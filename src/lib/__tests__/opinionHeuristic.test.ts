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

describe("looksLikeLoggableOpinion — changed-opinion / rewatch phrasing (Cycle 6 / FR-004 bug fix)", () => {
  it("recognizes a rewatch mention even with no first-time sentiment word", () => {
    expect(looksLikeLoggableOpinion("My opinion on The Lego Movie has changed after rewatching it")).toBe(true);
  });

  it("recognizes explicit 'changed my mind' phrasing", () => {
    expect(looksLikeLoggableOpinion("I changed my mind about Inception")).toBe(true);
  });

  it("recognizes 'rewatched' on its own", () => {
    expect(looksLikeLoggableOpinion("I rewatched Tenet last night")).toBe(true);
  });

  it("recognizes 'actually hated/loved' re-rating phrasing", () => {
    expect(looksLikeLoggableOpinion("I actually hated it this time around")).toBe(true);
  });

  it("recognizes 'second viewing' phrasing", () => {
    expect(looksLikeLoggableOpinion("On my second viewing of Dune I liked it a lot more")).toBe(true);
  });
});
