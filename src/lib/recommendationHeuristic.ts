/**
 * Cycle 6 / FR-004 + FR-008: a small heuristic, in the same spirit as
 * `opinionHeuristic.ts`, used ONLY to decide whether a tag-less reply should be logged
 * to `parse_failures` as a missed `<RECOMMEND>` — never to gate or alter the
 * conversation itself.
 *
 * Unlike the opinion heuristic, a missing recommendation is NOT retried (the PRD's
 * FR-004 scope for `<RECOMMEND>` only asks for fallback + logging, not the 2-retry
 * safety net that's specific to FR-004 Issue 1's `<ADD>`/`<UPDATE>` fix) — see
 * `useChat.ts` for how this is wired into the single-attempt classification.
 *
 * `hasRatedItems` gates whether a match here is actually logged as a compliance miss:
 * when the user has never rated anything, the system prompt correctly instructs the
 * model to respond conversationally with no tag ("log a few movies first") — that is
 * expected, graceful behavior (FR-004's "no fabricated personalized recommendation from
 * empty data"), not a parse failure, so the caller must not log it as one.
 */
const RECOMMENDATION_SIGNALS = [
  /\brecommend(?:ation|ations|ed|ing)?\b/i,
  /\bsuggest(?:ion|ions|ed|ing)?\b/i,
  /what should i watch/i,
  /\bwatch next\b/i,
  /\banything (?:good|else) to watch\b/i,
  /\bany (?:good )?movies? (?:i should|for me|you'd recommend)\b/i,
];

export function looksLikeRecommendationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return RECOMMENDATION_SIGNALS.some((pattern) => pattern.test(trimmed));
}
