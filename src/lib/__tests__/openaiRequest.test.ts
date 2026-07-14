import { describe, expect, it } from "vitest";
import { buildOpenAIRequestBody, OPENAI_MODEL, OPENAI_TEMPERATURE } from "../openaiRequest";

describe("buildOpenAIRequestBody", () => {
  it("requests a real (non-mocked) streaming completion (FR-001 AC4)", () => {
    const body = buildOpenAIRequestBody([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.model).toBe(OPENAI_MODEL);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("uses a conservative, documented temperature (Cycle 4 / FR-001 Issue 1 AC)", () => {
    // Exact value is a build-agent choice per the work order — asserted as a documented
    // constant plus a sanity bound (clearly lower than the prior 0.6), not a magic number.
    const body = buildOpenAIRequestBody([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(OPENAI_TEMPERATURE);
    expect(OPENAI_TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(OPENAI_TEMPERATURE).toBeLessThanOrEqual(0.3);
  });
});
