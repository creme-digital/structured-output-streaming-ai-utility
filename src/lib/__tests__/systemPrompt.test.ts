import { describe, expect, it } from "vitest";
import { buildExistingTitlesMessage, buildRecommendationContextMessage, SYSTEM_PROMPT } from "../systemPrompt";

describe("SYSTEM_PROMPT (FR-001 AC3: reviewable in the repo)", () => {
  it("documents the <ADD> tag format", () => {
    expect(SYSTEM_PROMPT).toMatch(/<ADD item="[^"]*" rating="N" \/>/);
  });

  it("documents the 1-5 rating scale with intensity anchors", () => {
    expect(SYSTEM_PROMPT).toMatch(/5 = loved/i);
    expect(SYSTEM_PROMPT).toMatch(/1 = hated/i);
  });

  it("instructs the model to skip the tag for ambiguous/off-topic input", () => {
    expect(SYSTEM_PROMPT).toMatch(/do not\s*(name a specific movie|emit a tag)/i);
  });

  it("instructs the model to resist prompt injection / off-topic requests", () => {
    expect(SYSTEM_PROMPT).toMatch(/decline/i);
  });

  it("documents the <UPDATE> tag format (Cycle 4 / FR-009)", () => {
    expect(SYSTEM_PROMPT).toMatch(/<UPDATE item="[^"]*" rating="N" \/>/);
  });

  it("instructs the model to fuzzy-match re-mentioned titles against a reference list", () => {
    expect(SYSTEM_PROMPT).toMatch(/already logged/i);
    expect(SYSTEM_PROMPT).toMatch(/typos/i);
  });

  it("instructs the model to ask for clarification on an unrecognized title instead of tagging (Cycle 4 / FR-001 Issue 2)", () => {
    expect(SYSTEM_PROMPT).toMatch(/do not recognize/i);
    expect(SYSTEM_PROMPT).toMatch(/don't recognize.*movie/i);
  });

  it("instructs the model to emit one <ADD>/<UPDATE> tag per distinct opinion, no cap, for compound messages (PRD v8 / FR-001/FR-003)", () => {
    expect(SYSTEM_PROMPT).toMatch(/one <ADD>\/<UPDATE> tag per distinct movie\/opinion/i);
    expect(SYSTEM_PROMPT).toMatch(/no cap\s+on how many tags/i);
    expect(SYSTEM_PROMPT).toMatch(/never drop one silently/i);
  });

  it("instructs the model that sentiment-only phrasing with no explicit number must still produce a tag (PRD v8 / FR-001/FR-004)", () => {
    expect(SYSTEM_PROMPT).toMatch(/sentiment-only phrasing/i);
    expect(SYSTEM_PROMPT).toMatch(/i hated barbie/i);
    expect(SYSTEM_PROMPT).toMatch(/never withhold a tag merely because the user gave no numeric\s+rating/i);
  });

  it("instructs the model that title recognition defers entirely to its own knowledge and must not reject mainstream real films (PRD v8 / FR-001)", () => {
    expect(SYSTEM_PROMPT).toMatch(/the big short/i);
    expect(SYSTEM_PROMPT).toMatch(/a star is born/i);
    expect(SYSTEM_PROMPT).toMatch(/american history x/i);
    expect(SYSTEM_PROMPT).toMatch(/the departed/i);
    expect(SYSTEM_PROMPT).toMatch(/no external list you are\s+being checked against/i);
  });

  it("documents the want-to-watch <ADD status=\"want_to_watch\" /> variant with rating omitted (Cycle 6 / FR-001)", () => {
    expect(SYSTEM_PROMPT).toMatch(/status="want_to_watch"/);
    expect(SYSTEM_PROMPT).toMatch(/leave the rating attribute out/i);
  });

  it("documents the on-request <RECOMMEND> tag, grounded and non-proactive (Cycle 6 / FR-008)", () => {
    expect(SYSTEM_PROMPT).toMatch(/<RECOMMEND item="[^"]*" reason="[^"]*" \/>/);
    expect(SYSTEM_PROMPT).toMatch(/never insert a recommendation.*unprompted/i);
  });

  it("instructs the model not to fabricate a recommendation when the user has no rated items", () => {
    expect(SYSTEM_PROMPT).toMatch(/do not\s+fabricate a personalized pick/i);
  });

  it("documents the action-integrity guard (Cycle 6 bug fix)", () => {
    expect(SYSTEM_PROMPT).toMatch(/action-integrity guard/i);
    expect(SYSTEM_PROMPT).toMatch(/never say.*that you are logging, saving, updating, or/i);
    expect(SYSTEM_PROMPT).toMatch(/changing a rating/i);
  });

  it("tells the model tag-stripped history is never a precedent for omitting tags (Cycle 7: history-poisoning fix)", () => {
    expect(SYSTEM_PROMPT).toMatch(/history.*not a formatting example/i);
    expect(SYSTEM_PROMPT).toMatch(/do not infer from history that tags are optional/i);
  });

  it("tells the model to accept a title the user insists is real after one clarifying question (Cycle 7)", () => {
    expect(SYSTEM_PROMPT).toMatch(/pushes back and confirms the title is real/i);
    expect(SYSTEM_PROMPT).toMatch(/actor, director, year/i);
    expect(SYSTEM_PROMPT).toMatch(/rather than refusing a second time/i);
  });
});

describe("buildRecommendationContextMessage (Cycle 6 / FR-008: recommendation grounding)", () => {
  it("returns null when the user has no rated items yet", () => {
    expect(buildRecommendationContextMessage([])).toBeNull();
  });

  it("lists the user's rated titles with their ratings for the model to ground a <RECOMMEND> in", () => {
    const message = buildRecommendationContextMessage([
      { item: "Inception", rating: 5 },
      { item: "Tenet", rating: 4 },
    ]);
    expect(message).toMatch(/"Inception" \(5\/5\)/);
    expect(message).toMatch(/"Tenet" \(4\/5\)/);
  });

  it("de-duplicates repeated titles, keeping the first (most recent) occurrence", () => {
    const message = buildRecommendationContextMessage([
      { item: "Inception", rating: 2 },
      { item: "inception", rating: 5 },
    ]);
    const occurrences = message?.match(/"[Ii]nception"/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(message).toMatch(/\(2\/5\)/);
  });

  it("ignores rows with a null/non-finite rating (want-to-watch entries never ground a recommendation)", () => {
    expect(
      buildRecommendationContextMessage([{ item: "Dune", rating: null as unknown as number }]),
    ).toBeNull();
  });
});

describe("buildExistingTitlesMessage (FR-009: model-side fuzzy-match context)", () => {
  it("returns null when the user has no logged items yet", () => {
    expect(buildExistingTitlesMessage([])).toBeNull();
  });

  it("lists the user's titles, quoted, for the model to compare against", () => {
    const message = buildExistingTitlesMessage(["Inception", "Tenet"]);
    expect(message).toMatch(/"Inception"/);
    expect(message).toMatch(/"Tenet"/);
    expect(message).toMatch(/<UPDATE>/);
  });

  it("de-duplicates repeated titles (a title may have multiple historical rows)", () => {
    const message = buildExistingTitlesMessage(["Inception", "inception", "Inception "]);
    const occurrences = message?.match(/"Inception"/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("ignores blank/whitespace-only entries", () => {
    expect(buildExistingTitlesMessage(["", "   "])).toBeNull();
  });
});
