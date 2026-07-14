import { describe, expect, it } from "vitest";
import { buildExistingTitlesMessage, SYSTEM_PROMPT } from "../systemPrompt";

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

  it("caps tag emission to at most one of <ADD> or <UPDATE> per reply", () => {
    expect(SYSTEM_PROMPT).toMatch(/never both/i);
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
