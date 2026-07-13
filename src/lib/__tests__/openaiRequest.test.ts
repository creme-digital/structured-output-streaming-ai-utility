import { describe, expect, it } from "vitest";
import { buildOpenAIRequestBody, OPENAI_MODEL } from "../openaiRequest";

describe("buildOpenAIRequestBody", () => {
  it("requests a real (non-mocked) streaming completion (FR-001 AC4)", () => {
    const body = buildOpenAIRequestBody([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.model).toBe(OPENAI_MODEL);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
