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
