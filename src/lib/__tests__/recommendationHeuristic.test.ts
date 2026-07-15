import { describe, expect, it } from "vitest";
import { looksLikeRecommendationRequest } from "../recommendationHeuristic";

describe("looksLikeRecommendationRequest (Cycle 6 / FR-004 + FR-008)", () => {
  it("recognizes an explicit recommendation request", () => {
    expect(looksLikeRecommendationRequest("Can you recommend something for me?")).toBe(true);
  });

  it("recognizes 'what should I watch next'", () => {
    expect(looksLikeRecommendationRequest("What should I watch next?")).toBe(true);
  });

  it("recognizes 'any suggestions'", () => {
    expect(looksLikeRecommendationRequest("Any suggestions for tonight?")).toBe(true);
  });

  it("treats a plain rating statement as not a recommendation request", () => {
    expect(looksLikeRecommendationRequest("I loved Inception")).toBe(false);
  });

  it("treats a greeting as not a recommendation request", () => {
    expect(looksLikeRecommendationRequest("hi there")).toBe(false);
  });

  it("ignores whitespace-only input", () => {
    expect(looksLikeRecommendationRequest("   ")).toBe(false);
  });
});
