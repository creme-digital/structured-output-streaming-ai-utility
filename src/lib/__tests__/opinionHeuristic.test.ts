import { describe, expect, it } from "vitest";
import { looksLikeLoggableOpinion } from "../opinionHeuristic";

describe("looksLikeLoggableOpinion", () => {
  it("recognizes strong positive sentiment", () => {
    expect(looksLikeLoggableOpinion("I loved Inception")).toBe(true);
  });

  it("recognizes negative sentiment", () => {
    expect(looksLikeLoggableOpinion("I hated that movie")).toBe(true);
  });

  it("treats a plain greeting as not loggable", () => {
    expect(looksLikeLoggableOpinion("hi there")).toBe(false);
  });

  it("treats an ambiguous, title-less remark as not loggable", () => {
    expect(looksLikeLoggableOpinion("the movie was okay")).toBe(false);
  });

  it("treats an off-topic question as not loggable", () => {
    expect(looksLikeLoggableOpinion("can you help me plan a trip to Paris?")).toBe(false);
  });

  it("ignores whitespace-only input", () => {
    expect(looksLikeLoggableOpinion("   ")).toBe(false);
  });
});
