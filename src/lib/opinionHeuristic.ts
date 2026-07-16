/**
 * A deliberately small heuristic used ONLY to decide how to *classify* a
 * turn that produced no `<ADD>` tag — never to gate or alter the
 * conversation itself (the assistant's reply is always shown as-is).
 *
 * FR-004 requires that a genuinely missing tag (the model should have logged
 * something but didn't) be logged to `parse_failures` for debugging, while
 * ordinary off-topic/ambiguous chat (e.g. "the movie was okay" with no title,
 * or "hi there") must NOT spam that debug log every turn. There is no way to
 * know the model's "intent" from the client, so we approximate: if the
 * user's own message reads like a clear opinion about a movie, we treat a
 * tag-less reply as a compliance miss worth logging as `reason: "missing"`;
 * otherwise it's just normal conversation and nothing is logged.
 *
 * This is documented as a medium-confidence, dev-team judgment call (see the
 * build summary) — the exact word list is illustrative, not exhaustive.
 *
 * Cycle 6 / FR-004 bug fix: the dev reported the model saying "I'll update your rating
 * now" for a rewatch/changed-opinion re-mention while nothing actually landed in the
 * database — root-caused to this heuristic not recognizing changed-opinion/rewatch
 * phrasing (as opposed to first-time sentiment words), so the retry-then-fallback
 * safety net below never engaged and the miss went completely unlogged. The signals in
 * the second group below close that gap: they fire on re-rating/rewatch language even
 * when it carries no first-time sentiment word of its own (e.g. "my opinion on X has
 * changed" has no "loved"/"hated" etc.), so a claimed-but-unemitted <UPDATE> now gets
 * exactly the same 2-retry-then-log discipline as a missed <ADD>.
 */
const OPINION_SIGNALS = [
  /\bloved?\b/i,
  /\blov(?:e|ing)\b/i,
  /\blik(?:e|ed|ing)\b/i,
  /\bhat(?:e|ed|ing)\b/i,
  /\bdislik(?:e|ed|ing)\b/i,
  /\benjoy(?:ed|s|ing)?\b/i,
  /\badore[ds]?\b/i,
  /\bamazing\b/i,
  /\bawesome\b/i,
  /\bgreat\b/i,
  /\bfantastic\b/i,
  /\bexcellent\b/i,
  /\bterrible\b/i,
  /\bawful\b/i,
  /\bboring\b/i,
  /\bbest\b/i,
  /\bworst\b/i,
  /\bfavou?rite\b/i,
  // Changed-opinion / rewatch / re-rating phrasing (Cycle 6 / FR-004 bug fix).
  /\bre-?watch(?:ed|ing)?\b/i,
  /\brewatch(?:ed|ing)?\b/i,
  /\bre-?rat(?:e|ed|ing)\b/i,
  /\bchang(?:ed|ing)?\s+my\s+(?:mind|opinion|rating)\b/i,
  /\bopinion\s+(?:on|about|of)\b.*\bchang/i,
  /\breconsider(?:ed|ing)?\b/i,
  /\bsecond\s+(?:watch|viewing|time\s+watching)\b/i,
  /\bactually\s+(?:loved?|hated|liked|disliked)\b/i,
];

/**
 * True if `text` reads like it's expressing an opinion about something specific
 * (as opposed to a greeting, a question, or genuinely ambiguous chit-chat).
 */
export function looksLikeLoggableOpinion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return OPINION_SIGNALS.some((pattern) => pattern.test(trimmed));
}

/**
 * PRD v8 / FR-001/FR-003/FR-004 (compound multi-opinion messages): splits `text` into
 * rough clause-level segments on common conjunctions/punctuation, so a compound message
 * with more than one distinct opinion (e.g. "I hated Chicago, but I loved A Star is
 * Born") can be reasoned about per-opinion instead of as one blob. This is deliberately
 * mechanical — comma/semicolon/sentence-end/"but"/"although"/"though"/"while"/"whereas" —
 * not a real clause parser, just enough to separate the PRD's own compound examples.
 */
const OPINION_SEGMENT_SPLIT = /,|;|\.(?:\s+|$)|\b(?:but|although|though|while|whereas)\b/i;

export function splitOpinionSegments(text: string): string[] {
  return text
    .split(OPINION_SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * The subset of `splitOpinionSegments(text)` that themselves read as an opinion (the
 * same word list `looksLikeLoggableOpinion` checks against the whole message, applied
 * per-segment instead). This is what lets a compound message be recognized as carrying
 * MULTIPLE distinct loggable opinions rather than just one.
 */
export function identifyOpinionSegments(text: string): string[] {
  return splitOpinionSegments(text).filter((segment) => OPINION_SIGNALS.some((pattern) => pattern.test(segment)));
}

/**
 * How many distinct loggable opinions `text` appears to express. Used by `useChat.ts`
 * to decide whether a turn is a "compound" multi-opinion message (>= 2) that warrants
 * the whole-turn retry-until-every-opinion-is-tagged discipline (FR-004), rather than
 * the ordinary single-opinion missing-tag path.
 */
export function countLikelyOpinions(text: string): number {
  return identifyOpinionSegments(text).length;
}

/**
 * Of the opinion-bearing segments in `text`, which ones do NOT mention any of
 * `matchedTitles` (case-insensitive substring match) — i.e. which expressed opinions the
 * tags the model actually emitted don't appear to account for. Best-effort only: it has
 * no real understanding of which segment maps to which tag (that's the model's job), so
 * it approximates "captured" as "the tagged title's text appears somewhere in this
 * segment." Used to name unmatched opinions in the fallback message after all retries
 * are exhausted (FR-004: "no silent drops").
 */
export function findUncapturedOpinionSegments(text: string, matchedTitles: string[]): string[] {
  const lowerTitles = matchedTitles.map((title) => title.trim().toLowerCase()).filter(Boolean);
  return identifyOpinionSegments(text).filter(
    (segment) => !lowerTitles.some((title) => segment.toLowerCase().includes(title)),
  );
}
