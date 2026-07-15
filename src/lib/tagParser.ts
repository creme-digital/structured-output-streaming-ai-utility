/**
 * Generic, extensible inline-tag parser (FR-003).
 *
 * The model streams natural-language prose interleaved with self-closing
 * tagged blocks, e.g. `<ADD item="Inception" rating="5" />`. This module
 * extracts those tags from anywhere in a body of text (start/middle/end,
 * or interleaved with prose) and returns the prose with the tags stripped
 * out for display, plus the structured matches.
 *
 * Architecture note: tag handling is registry-based so future tag types
 * (e.g. REMOVE in the eventual StealthCo product) can be added by
 * registering another `TagDefinition` — no changes to the extraction
 * engine itself. `<ADD>`, `<UPDATE>` (Cycle 4 / FR-009), and `<RECOMMEND>`
 * (FR-008, finished in Cycle 6 — see docs/ARCHITECTURE.md for why it had been
 * carried forward unbuilt for three prior cycles) are all registered/active
 * in this build (see `createDefaultTagRegistry` below). This satisfies
 * FR-003's requirement that the architecture be "proven flexible" while only
 * shipping tag types the PRD actually asked for.
 */

export interface TagMatch<T = Record<string, string>> {
  tag: string;
  attrs: T;
  raw: string;
}

export interface MalformedTag {
  tag: string;
  raw: string;
  reason: string;
}

export interface TagDefinition<T> {
  /** Tag name, case-insensitive, e.g. "ADD". */
  name: string;
  /**
   * Attribute names that must be present for the tag to be considered well-formed.
   * May be a plain list, or (Cycle 6 / FR-003) a function of the tag's own raw
   * attributes — used by `<ADD>` so `rating` is only required when `status` isn't
   * `"want_to_watch"`, without teaching the generic extraction engine below anything
   * about what those attribute names mean.
   */
  requiredAttrs: string[] | ((attrs: Record<string, string>) => string[]);
  /** Coerce + validate raw string attributes. Return null to mark the tag malformed. */
  validate: (attrs: Record<string, string>) => T | null;
}

export class TagRegistry {
  private definitions = new Map<string, TagDefinition<unknown>>();

  register<T>(definition: TagDefinition<T>): this {
    this.definitions.set(definition.name.toUpperCase(), definition as TagDefinition<unknown>);
    return this;
  }

  has(name: string): boolean {
    return this.definitions.has(name.toUpperCase());
  }

  get(name: string): TagDefinition<unknown> | undefined {
    return this.definitions.get(name.toUpperCase());
  }
}

export interface ExtractResult {
  /** Original text with every recognized tag (well-formed or not) removed. */
  cleanedText: string;
  /** Successfully parsed, validated tags. */
  matches: TagMatch[];
  /** Recognized tag names that failed to parse cleanly. */
  malformed: MalformedTag[];
}

// Matches `<NAME ...attrs... >` or `<NAME ...attrs... />`, non-greedy attribute body.
const TAG_RE = /<([A-Za-z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/)?>/g;
// Matches `key="value"` pairs within an attribute string.
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;

/**
 * Scan `fullText` for every tag registered in `registry`, anywhere in the string.
 * Unknown tag names are left untouched in the returned prose (not this parser's concern).
 */
export function extractTags(fullText: string, registry: TagRegistry): ExtractResult {
  const matches: TagMatch[] = [];
  const malformed: MalformedTag[] = [];
  let cleaned = "";
  let lastIndex = 0;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(fullText))) {
    const [full, name, attrString, selfClose] = match;
    if (!registry.has(name)) {
      continue; // not a tag we recognize — leave it as ordinary prose
    }

    cleaned += fullText.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;

    if (!selfClose) {
      malformed.push({ tag: name.toUpperCase(), raw: full, reason: "tag is not self-closing" });
      continue;
    }

    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrString))) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    const definition = registry.get(name)!;
    const requiredAttrs =
      typeof definition.requiredAttrs === "function" ? definition.requiredAttrs(attrs) : definition.requiredAttrs;
    const missing = requiredAttrs.filter((attr) => !(attr in attrs));
    if (missing.length > 0) {
      malformed.push({
        tag: name.toUpperCase(),
        raw: full,
        reason: `missing required attribute(s): ${missing.join(", ")}`,
      });
      continue;
    }

    const validated = definition.validate(attrs);
    if (validated == null) {
      malformed.push({ tag: name.toUpperCase(), raw: full, reason: "attribute values failed validation" });
      continue;
    }

    matches.push({ tag: name.toUpperCase(), attrs: validated as Record<string, string>, raw: full });
  }

  cleaned += fullText.slice(lastIndex);
  return { cleanedText: cleaned, matches, malformed };
}

/**
 * While a stream is still arriving, `fullText` may end mid-tag (e.g.
 * `...<ADD item="Inception" rat`). `extractTags` only strips *complete*
 * tags, so we additionally hide a trailing, not-yet-closed `<...` from the
 * live display buffer so users never see raw tag markup flash by while
 * tokens are still streaming in.
 */
export function stripTrailingPartialTag(text: string): string {
  return text.replace(/<[^>]*$/, "");
}

export type ItemStatus = "watched" | "want_to_watch";

export interface AddTagAttrs {
  item: string;
  /**
   * Cycle 6 / FR-003: null for a want-to-watch entry (rating intentionally omitted by
   * the model — see systemPrompt.ts). Always a 1-5 integer for a normal rated <ADD>.
   */
  rating: number | null;
  /** Cycle 6 / FR-003: defaults to "watched" when the tag carries no status attribute. */
  status: ItemStatus;
}

const MIN_RATING = 1;
const MAX_RATING = 5;

/**
 * Cycle 6 / FR-003: `rating` is only a required attribute when the tag isn't a
 * want-to-watch `<ADD>` — see `TagDefinition.requiredAttrs`'s function form. Read
 * *before* `validateAddAttrs` runs, so a plain `<ADD item="..." />` with no `status`
 * and no `rating` is still reported as "missing required attribute(s): rating" (the
 * pre-existing, tested malformed reason), not folded into a generic validation failure.
 */
function addRequiredAttrs(attrs: Record<string, string>): string[] {
  return attrs.status?.trim() === "want_to_watch" ? ["item"] : ["item", "rating"];
}

function validateAddAttrs(attrs: Record<string, string>): AddTagAttrs | null {
  const item = attrs.item?.trim();
  if (!item) return null;

  const rawStatus = attrs.status?.trim();
  if (rawStatus && rawStatus !== "watched" && rawStatus !== "want_to_watch") return null;
  const status: ItemStatus = rawStatus === "want_to_watch" ? "want_to_watch" : "watched";

  if (status === "want_to_watch") {
    // Rating is intentionally omitted for want-to-watch entries (FR-001/FR-003) —
    // never guess one, and never treat its absence as malformed.
    return { item, rating: null, status };
  }

  const rating = Number(attrs.rating);
  if (!Number.isFinite(rating)) return null;
  if (rating < MIN_RATING || rating > MAX_RATING) return null;

  return { item, rating, status };
}

export const ADD_TAG_DEFINITION: TagDefinition<AddTagAttrs> = {
  name: "ADD",
  requiredAttrs: addRequiredAttrs,
  validate: validateAddAttrs,
};

/**
 * `<UPDATE item="..." rating="..." />` (Cycle 4 / FR-009): re-mention of an already-logged
 * title, INCLUDING a title the user had previously marked want-to-watch (Cycle 6 /
 * FR-009's want-to-watch -> watched transition). Rating is always required and always
 * present here — an update always carries a fresh, real opinion — so this keeps the
 * original, simpler shape/validation rather than reusing `AddTagAttrs`. `useChat.ts`
 * INSERTS a new `items` row (never an overwrite, preserving rating history), always
 * with `status: "watched"`, and renders a distinct "rating updated" footnote instead of
 * "Saved"/"Want to watch".
 */
export interface UpdateTagAttrs {
  item: string;
  rating: number;
}

function validateUpdateAttrs(attrs: Record<string, string>): UpdateTagAttrs | null {
  const item = attrs.item?.trim();
  if (!item) return null;

  const rating = Number(attrs.rating);
  if (!Number.isFinite(rating)) return null;
  if (rating < MIN_RATING || rating > MAX_RATING) return null;

  return { item, rating };
}

export const UPDATE_TAG_DEFINITION: TagDefinition<UpdateTagAttrs> = {
  name: "UPDATE",
  requiredAttrs: ["item", "rating"],
  validate: validateUpdateAttrs,
};

/**
 * `<RECOMMEND item="..." reason="..." />` (FR-008): a personalized, on-request movie
 * recommendation. Display-only — `useChat.ts` never writes a database row for this tag,
 * it only renders a distinct card (FR-005/FR-008 acceptance criteria).
 */
export interface RecommendTagAttrs {
  item: string;
  reason: string;
}

function validateRecommendAttrs(attrs: Record<string, string>): RecommendTagAttrs | null {
  const item = attrs.item?.trim();
  const reason = attrs.reason?.trim();
  if (!item || !reason) return null;
  return { item, reason };
}

export const RECOMMEND_TAG_DEFINITION: TagDefinition<RecommendTagAttrs> = {
  name: "RECOMMEND",
  requiredAttrs: ["item", "reason"],
  validate: validateRecommendAttrs,
};

/**
 * The registry actually wired up in this build: `<ADD>`, `<UPDATE>`, and `<RECOMMEND>`
 * (FR-003 / FR-008 / FR-009 scope). `REMOVE` and any further tag types remain out of
 * scope per the PRD.
 */
export function createDefaultTagRegistry(): TagRegistry {
  return new TagRegistry()
    .register(ADD_TAG_DEFINITION)
    .register(UPDATE_TAG_DEFINITION)
    .register(RECOMMEND_TAG_DEFINITION);
}
