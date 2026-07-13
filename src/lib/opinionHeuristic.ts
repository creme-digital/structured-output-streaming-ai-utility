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
