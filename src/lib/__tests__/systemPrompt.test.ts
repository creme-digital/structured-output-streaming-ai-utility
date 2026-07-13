import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../systemPrompt";

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
});
