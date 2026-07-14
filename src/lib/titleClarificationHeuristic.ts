/**
 * Detects when the assistant's reply is asking the user to confirm/clarify a movie
 * title it doesn't recognize, rather than emitting an <ADD>/<UPDATE> tag (Cycle 4 /
 * FR-001 Issue 2, FR-004).
 *
 * The system prompt (`systemPrompt.ts`) instructs the model to always include the
 * words "don't recognize" and "movie" together when it declines to log a title for
 * this reason, specifically so this heuristic can distinguish that case — a genuinely
 * expected, non-failure outcome that should be logged to `parse_failures` with
 * `reason: "unrecognized_title"` rather than treated as a compliance miss worth
 * retrying (`reason: "missing"`).
 *
 * Like `opinionHeuristic.ts`, this is a documented, medium-confidence heuristic that
 * depends on the model actually following the prompted phrasing — it does not attempt
 * to parse arbitrary natural language for "does this look like a clarifying
 * question" in general.
 */
export function looksLikeUnrecognizedTitleClarification(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /don'?t\s+recognize|do\s+not\s+recognize/i.test(trimmed) && /\bmovie\b/i.test(trimmed);
}
