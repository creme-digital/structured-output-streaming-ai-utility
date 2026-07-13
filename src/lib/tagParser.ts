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
 * (e.g. UPDATE, REMOVE in the eventual StealthCo product) can be added by
 * registering another `TagDefinition` — no changes to the extraction
 * engine itself. Only `<ADD>` is registered/active in this build
 * (see `defaultTagRegistry` below); this satisfies FR-003's requirement
 * that the architecture be "proven flexible" without shipping tag types
 * that were never requested.
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
  /** Attribute names that must be present for the tag to be considered well-formed. */
  requiredAttrs: string[];
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
    const missing = definition.requiredAttrs.filter((attr) => !(attr in attrs));
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

export interface AddTagAttrs {
  item: string;
  rating: number;
}

const MIN_RATING = 1;
const MAX_RATING = 5;

export const ADD_TAG_DEFINITION: TagDefinition<AddTagAttrs> = {
  name: "ADD",
  requiredAttrs: ["item", "rating"],
  validate: (attrs) => {
    const item = attrs.item?.trim();
    if (!item) return null;

    const rating = Number(attrs.rating);
    if (!Number.isFinite(rating)) return null;
    if (rating < MIN_RATING || rating > MAX_RATING) return null;

    return { item, rating };
  },
};

/** The registry actually wired up in this build: only `<ADD>` is active (FR-003 scope). */
export function createDefaultTagRegistry(): TagRegistry {
  return new TagRegistry().register(ADD_TAG_DEFINITION);
}
