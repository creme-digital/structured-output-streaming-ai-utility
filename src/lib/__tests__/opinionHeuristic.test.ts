import { describe, expect, it } from "vitest";
import {
  countLikelyOpinions,
  findUncapturedOpinionSegments,
  looksLikeLoggableOpinion,
  splitOpinionSegments,
} from "../opinionHeuristic";

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

describe("looksLikeLoggableOpinion — sentiment-only phrasing, no explicit number (PRD v8 / FR-001/FR-004)", () => {
  it.each(["I hated Barbie", "I disliked Cats", "I loved Dune"])(
    "recognizes %s as a loggable opinion with no explicit rating word/number",
    (text) => {
      expect(looksLikeLoggableOpinion(text)).toBe(true);
    },
  );
});

describe("splitOpinionSegments / countLikelyOpinions / findUncapturedOpinionSegments (PRD v8 / FR-004: compound multi-opinion messages)", () => {
  it("splits a compound 'but' message into its two opinion clauses", () => {
    expect(splitOpinionSegments("I hated Chicago, but I loved A Star is Born")).toEqual([
      "I hated Chicago",
      "I loved A Star is Born",
    ]);
  });

  it("counts a single-opinion message as exactly one opinion", () => {
    expect(countLikelyOpinions("I loved Inception")).toBe(1);
  });

  it("counts a compound two-opinion message as two opinions", () => {
    expect(countLikelyOpinions("I hated Chicago, but I loved A Star is Born")).toBe(2);
  });

  it("counts an ambiguous, opinion-less message as zero opinions", () => {
    expect(countLikelyOpinions("the movie was okay")).toBe(0);
  });

  it("identifies neither segment as uncaptured once both matched titles are accounted for", () => {
    expect(findUncapturedOpinionSegments("I hated Chicago, but I loved A Star is Born", ["Chicago", "A Star is Born"])).toEqual(
      [],
    );
  });

  it("identifies the segment whose title was never tagged", () => {
    expect(findUncapturedOpinionSegments("I hated Chicago, but I loved A Star is Born", ["Chicago"])).toEqual([
      "I loved A Star is Born",
    ]);
  });

  it("treats every segment as uncaptured when nothing was matched at all", () => {
    expect(findUncapturedOpinionSegments("I hated Chicago, but I loved A Star is Born", [])).toEqual([
      "I hated Chicago",
      "I loved A Star is Born",
    ]);
  });
});
