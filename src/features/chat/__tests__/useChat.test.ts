import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabaseTables } from "../../../test/mockSupabase";

let fakeSupabase: ReturnType<typeof createFakeSupabaseTables>;

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    get from() {
      return fakeSupabase.from;
    },
  },
}));

const { useChat } = await import("../useChat");

/** Builds a fetch Response whose body streams the given text as OpenAI-style SSE chunks. */
function streamingResponse(fullText: string, chunkSize = 4): Response {
  const chunks: string[] = [];
  for (let i = 0; i < fullText.length; i += chunkSize) {
    chunks.push(fullText.slice(i, i + chunkSize));
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
        controller.enqueue(encoder.encode(sse));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const USER_ID = "user-123";

beforeEach(() => {
  fakeSupabase = createFakeSupabaseTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChat (FR-002 / FR-003 / FR-004 / FR-006)", () => {
  it("loads persisted chat history scoped to the current user on mount", async () => {
    fakeSupabase = createFakeSupabaseTables({
      historyRows: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "hello!" },
      ],
    });

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("hi");
  });

  it("surfaces a history-load error instead of hanging or crashing", async () => {
    fakeSupabase = createFakeSupabaseTables({ historyError: { message: "network down" } });
    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("error"));
  });

  it("streams the assistant reply progressively and writes a row on a successful <ADD> tag", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamingResponse('Great pick! <ADD item="Inception" rating="5" />')),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    // Two persisted turns: the user's message and the assistant's.
    expect(result.current.messages).toHaveLength(2);
    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.status).toBe("done");
    expect(assistantMessage.content).toBe("Great pick!");
    expect(assistantMessage.content).not.toContain("<ADD");
    expect(assistantMessage.footnote).toEqual({ tone: "success", text: "Saved · Inception" });

    const itemInsert = fakeSupabase.insertCalls.find((c) => c.table === "items");
    expect(itemInsert?.payload).toMatchObject({
      user_id: USER_ID,
      item: "Inception",
      rating: 5,
      category: "movies",
      raw_user_text: "I loved Inception",
    });

    const userInsert = fakeSupabase.insertCalls.find(
      (c) => c.table === "chat_messages" && c.payload.role === "user",
    );
    expect(userInsert?.payload.content).toBe("I loved Inception");

    const assistantInsert = fakeSupabase.insertCalls.find(
      (c) => c.table === "chat_messages" && c.payload.role === "assistant",
    );
    expect(assistantInsert?.payload.content).toBe("Great pick!");
  });

  it("renders partial text before the stream completes (FR-002 AC1)", async () => {
    let resolveSecondChunk!: () => void;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
          ),
        );
        const wait = new Promise<void>((resolve) => {
          resolveSecondChunk = resolve;
        });
        wait.then(() => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("hi");
    });

    await waitFor(() =>
      expect(result.current.messages.find((m) => m.role === "assistant")?.content).toBe("Hello"),
    );
    expect(result.current.messages.find((m) => m.role === "assistant")?.status).toBe("streaming");

    await act(async () => {
      resolveSecondChunk();
      await sendPromise;
    });

    expect(result.current.messages.find((m) => m.role === "assistant")?.content).toBe("Hello world");
  });

  it("logs a parse_failures row and shows a fallback footnote for a malformed tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse('Noted. <ADD item="Inception" rating="high" />'))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception, it was epic");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.footnote?.tone).toBe("danger");
    expect(fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "malformed")).toBe(
      true,
    );
  });

  it("handles an off-topic reply with no tag gracefully — no crash, no spurious failure log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse("I'm not sure I follow — could you say more?"))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("asdkjhaskjdh");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.status).toBe("done");
    expect(assistantMessage.footnote).toBeUndefined();
    expect(fakeSupabase.insertCalls.some((c) => c.table === "parse_failures")).toBe(false);
  });

  it("logs a 'missing' parse failure when a clear opinion produced no tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse("Glad to hear it!"))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    expect(
      fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "missing"),
    ).toBe(true);
  });

  it("never crashes and shows a fallback message when the network request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network unreachable"))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await expect(result.current.sendMessage("I loved Inception")).resolves.not.toThrow();
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.status).toBe("error");
    expect(assistantMessage.content).toMatch(/something went wrong/i);
    expect(fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "other")).toBe(
      true,
    );
  });

  it("shows a fallback message when the edge function returns a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Server is not configured", { status: 500 }))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.status).toBe("error");
    expect(assistantMessage.footnote?.tone).toBe("danger");
  });

  it("ignores empty submissions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("   ");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });
});

describe("useChat — <UPDATE> as a third registered tag type (Cycle 4 / FR-003, FR-009)", () => {
  it("dispatches a successful <UPDATE> to an items insert with a distinct 'rating updated' footnote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamingResponse('Noted, updating that one. <UPDATE item="Inception" rating="2" />'),
        ),
      ),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("Actually, Inception was worse on rewatch");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.footnote).toEqual({ tone: "update", text: "Rating updated · Inception" });

    // <UPDATE> INSERTS a new row — it must never overwrite/upsert an existing one
    // (FR-009: full rating history preserved).
    const itemInsert = fakeSupabase.insertCalls.find((c) => c.table === "items");
    expect(itemInsert?.payload).toMatchObject({
      user_id: USER_ID,
      item: "Inception",
      rating: 2,
      category: "movies",
    });
  });
});

describe("useChat — silent retry on missing tag (Cycle 4 / FR-004 Issue 1)", () => {
  it("silently retries up to 2 additional times and keeps only the final attempt's output", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(streamingResponse("Hmm, tell me more about that.")))
      .mockImplementationOnce(() => Promise.resolve(streamingResponse("Still thinking it over.")))
      .mockImplementationOnce(() =>
        Promise.resolve(streamingResponse('Got it! <ADD item="Inception" rating="5" />')),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.content).toBe("Got it!");
    expect(assistantMessage.footnote).toEqual({ tone: "success", text: "Saved · Inception" });
    // Discarded attempts must never be surfaced as failures — only the final,
    // successful attempt is logged/visible.
    expect(fakeSupabase.insertCalls.some((c) => c.table === "parse_failures")).toBe(false);
  });

  it("falls back and logs 'missing' exactly once after all 3 attempts produce no tag", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(streamingResponse("Sounds like a mixed reaction!")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const missingLogs = fakeSupabase.insertCalls.filter(
      (c) => c.table === "parse_failures" && c.payload.reason === "missing",
    );
    expect(missingLogs).toHaveLength(1);
    expect(result.current.messages[1].footnote).toEqual({
      tone: "neutral",
      text: "Didn't catch an item to log there.",
    });
  });

  it("does not retry when the user's message doesn't look like an opinion", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(streamingResponse("Sure, happy to chat!")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("what's up");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("useChat — unrecognized-title clarification (Cycle 4 / FR-001 Issue 2, FR-004)", () => {
  it("logs 'unrecognized_title' and does not retry when the model asks for clarification", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        streamingResponse("I don't recognize that as a real movie — could you double-check the title?"),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Freeze Frame 3000");
    });

    // Expected behavior, not a compliance miss — must NOT trigger the silent retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fakeSupabase.insertCalls.some(
        (c) => c.table === "parse_failures" && c.payload.reason === "unrecognized_title",
      ),
    ).toBe(true);

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.status).toBe("done");
    expect(assistantMessage.footnote).toBeUndefined();
  });
});
