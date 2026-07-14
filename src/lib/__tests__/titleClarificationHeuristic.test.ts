import { describe, expect, it } from "vitest";
import { looksLikeUnrecognizedTitleClarification } from "../titleClarificationHeuristic";

describe("looksLikeUnrecognizedTitleClarification (Cycle 4 / FR-001 Issue 2, FR-004)", () => {
  it("recognizes the prompted clarification phrasing", () => {
    expect(
      looksLikeUnrecognizedTitleClarification(
        "I don't recognize that as a real movie — could you double-check the title?",
      ),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of the contraction spelling", () => {
    expect(looksLikeUnrecognizedTitleClarification("I DO NOT RECOGNIZE that movie title.")).toBe(true);
  });

  it("requires both 'recognize' and 'movie' to be present", () => {
    expect(looksLikeUnrecognizedTitleClarification("I don't recognize that name.")).toBe(false);
    expect(looksLikeUnrecognizedTitleClarification("That movie sounds great!")).toBe(false);
  });

  it("treats an ordinary saved/confirmation reply as not a clarification", () => {
    expect(looksLikeUnrecognizedTitleClarification("Got it, logging that for you!")).toBe(false);
  });

  it("ignores empty input", () => {
    expect(looksLikeUnrecognizedTitleClarification("   ")).toBe(false);
  });
});
