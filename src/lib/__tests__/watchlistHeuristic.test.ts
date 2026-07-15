import { describe, expect, it } from "vitest";
import { looksLikeWatchlistIntent } from "../watchlistHeuristic";

describe("looksLikeWatchlistIntent (Cycle 7: missed want-to-watch classification)", () => {
  it.each([
    "I want to watch Toy Story",
    "I want to see Dune Part Two",
    "add Dune to my list",
    "put Blade Runner on my watchlist",
    "I'm planning to watch Oppenheimer this weekend",
    "I'm going to watch The Matrix tonight",
    "gonna watch Interstellar later",
  ])("matches a clear watch intent: %s", (text) => {
    expect(looksLikeWatchlistIntent(text)).toBe(true);
  });

  it.each([
    // Opinions about things already seen belong to the opinion heuristic, not here.
    "I finally watched Dune, loved it",
    "The Mask was a 2 out of 5",
    // Recommendation requests belong to the recommendation heuristic.
    "what should I watch next?",
    // Ordinary chit-chat and junk.
    "hi there",
    "the movie was okay",
    "asdkjhaskjdh",
    "",
    "   ",
  ])("does not match non-watchlist input: %s", (text) => {
    expect(looksLikeWatchlistIntent(text)).toBe(false);
  });
});
