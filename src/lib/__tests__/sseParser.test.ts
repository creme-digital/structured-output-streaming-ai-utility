import { describe, expect, it } from "vitest";
import { OpenAIStreamDecoder } from "../sseParser";

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe("OpenAIStreamDecoder", () => {
  it("extracts a delta from a single complete SSE event", () => {
    const decoder = new OpenAIStreamDecoder();
    const { deltas, done } = decoder.feed(sseChunk("Hello"));
    expect(deltas).toEqual(["Hello"]);
    expect(done).toBe(false);
  });

  it("accumulates deltas across multiple feed calls (token-by-token)", () => {
    const decoder = new OpenAIStreamDecoder();
    const collected: string[] = [];
    for (const word of ["Hel", "lo", " wor", "ld"]) {
      const { deltas } = decoder.feed(sseChunk(word));
      collected.push(...deltas);
    }
    expect(collected.join("")).toBe("Hello world");
  });

  it("recognizes the [DONE] sentinel", () => {
    const decoder = new OpenAIStreamDecoder();
    const { done } = decoder.feed("data: [DONE]\n\n");
    expect(done).toBe(true);
  });

  it("buffers a line split across two feed calls instead of dropping it", () => {
    const decoder = new OpenAIStreamDecoder();
    const full = sseChunk("split-token");
    const midpoint = Math.floor(full.length / 2);

    const first = decoder.feed(full.slice(0, midpoint));
    expect(first.deltas).toEqual([]); // incomplete line yet, nothing to emit

    const second = decoder.feed(full.slice(midpoint));
    expect(second.deltas).toEqual(["split-token"]);
  });

  it("skips a malformed JSON line without throwing (FR-004: never crash the stream consumer)", () => {
    const decoder = new OpenAIStreamDecoder();
    expect(() => decoder.feed("data: {not valid json\n\n")).not.toThrow();
    const { deltas } = decoder.feed(sseChunk("still works"));
    expect(deltas).toEqual(["still works"]);
  });

  it("ignores chunks with no content delta (e.g. role-only or finish_reason events)", () => {
    const decoder = new OpenAIStreamDecoder();
    const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`;
    const { deltas } = decoder.feed(roleOnly);
    expect(deltas).toEqual([]);
  });
});
