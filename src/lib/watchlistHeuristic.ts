/**
 * Cycle 7: a small heuristic, in the same spirit as `opinionHeuristic.ts` and
 * `recommendationHeuristic.ts`, used ONLY to classify a tag-less reply — never to gate
 * or alter the conversation itself.
 *
 * Why it exists: the live-site incident behind this cycle's history-poisoning fix
 * surfaced a coverage gap — when the model replied "I'll add Toy Story to your
 * want-to-watch list!" without emitting the `<ADD status="want_to_watch" />` tag,
 * NOTHING happened: no retry, no `parse_failures` row, no footnote. The opinion
 * heuristic doesn't fire (a watch intent carries no sentiment word) and the
 * recommendation heuristic doesn't either, so `missKind` stayed null and the miss was
 * indistinguishable from ordinary chit-chat. This heuristic closes that gap: a clear
 * watch-intent message whose reply carries no tag now gets the same 2-retry-then-log
 * safety net as a missed <ADD>/<UPDATE> (FR-004), plus its own neutral footnote.
 *
 * Same caveats as its siblings: medium-confidence, dev-team judgment call; the word
 * list is illustrative, not exhaustive.
 */
const WATCHLIST_SIGNALS = [
  /\bwant(?:ed)?\s+to\s+(?:watch|see)\b/i,
  /\bwatch\s?list\b/i,
  /\bplan(?:ning|s)?\s+(?:on\s+watching|to\s+watch)\b/i,
  /\bgoing\s+to\s+watch\b/i,
  /\bgonna\s+watch\b/i,
  /\bhaven'?t\s+(?:seen|watched)\s+(?:it|that)?\s*(?:yet)?\b.*\bwant\b/i,
  /\badd\b.+\bto\s+my\s+(?:list|queue)\b/i,
  /\bon\s+my\s+(?:list|to-?watch)\b/i,
];

/**
 * True if `text` reads like a future watch intent (as opposed to an opinion on
 * something already seen, a recommendation request, or ordinary chit-chat).
 */
export function looksLikeWatchlistIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  return WATCHLIST_SIGNALS.some((pattern) => pattern.test(trimmed));
}
