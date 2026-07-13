/**
 * Incremental decoder for OpenAI's chat-completions streaming format
 * (server-sent-events-style `data: {...}\n\n` lines terminated by `data: [DONE]`).
 *
 * Pure, network-free, and used by both the edge function (proxying OpenAI) and,
 * indirectly, tested here without needing a live OpenAI connection. Chunks fed in
 * one at a time may split a line across two calls to `feed`, so a trailing
 * partial line is always buffered until the next call completes it.
 */

export interface StreamDecodeResult {
  /** Zero or more text deltas extracted from this chunk, in order. */
  deltas: string[];
  /** True once a `[DONE]` sentinel has been seen. */
  done: boolean;
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

export class OpenAIStreamDecoder {
  private buffer = "";

  feed(chunk: string): StreamDecodeResult {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    const deltas: string[] = [];
    let done = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice("data:".length).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        done = true;
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        const content = parsed.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          deltas.push(content);
        }
      } catch {
        // A single malformed SSE line must never crash the stream consumer (FR-004) —
        // skip it, the rest of the stream keeps flowing.
      }
    }

    return { deltas, done };
  }
}
