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

describe("useChat — want-to-watch <ADD> (Cycle 6 / FR-001, FR-003, FR-005, FR-009)", () => {
  it("dispatches a want-to-watch <ADD> with a null rating and a distinct 'Want to watch' footnote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(streamingResponse('Added to your list! <ADD item="Dune" status="want_to_watch" />')),
      ),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I want to watch Dune");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.footnote).toEqual({ tone: "watchlist", text: "Want to watch · Dune" });

    const itemInsert = fakeSupabase.insertCalls.find((c) => c.table === "items");
    expect(itemInsert?.payload).toMatchObject({
      user_id: USER_ID,
      item: "Dune",
      rating: null,
      status: "want_to_watch",
    });
  });

  it("dispatches the want-to-watch -> watched transition via <UPDATE> with status 'watched' and a real rating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(streamingResponse('Great, updating that! <UPDATE item="Dune" rating="5" />')),
      ),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I finally watched Dune, loved it");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.footnote).toEqual({ tone: "update", text: "Rating updated · Dune" });

    const itemInsert = fakeSupabase.insertCalls.find((c) => c.table === "items");
    // The want-to-watch -> watched transition always INSERTS a fresh row (never an
    // in-place overwrite of the earlier want-to-watch row), tagged status "watched".
    expect(itemInsert?.payload).toMatchObject({
      item: "Dune",
      rating: 5,
      status: "watched",
    });
  });
});

describe("useChat — rewatch/changed-opinion phrasing triggers the same retry-then-log safety net as a first-time rating (Cycle 6 / FR-004 bug fix)", () => {
  it("retries a rewatch re-mention that produced no <UPDATE> tag, then falls back and logs 'missing'", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamingResponse("I'll update your rating now.")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("My opinion on The Lego Movie has changed after rewatching it");
    });

    // Previously this phrasing didn't engage the opinion heuristic at all, so the
    // model's prose claim ("I'll update your rating now") went completely unlogged
    // when no <UPDATE> tag actually landed. It must now get the full 3-attempt
    // retry-then-fallback treatment, exactly like a missed first-time <ADD>.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "missing"),
    ).toBe(true);
  });
});

describe("useChat — <RECOMMEND> as a fourth registered, display-only tag type (FR-003, FR-008)", () => {
  it("dispatches a successful <RECOMMEND> to a display-only recommendation, with no items insert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamingResponse(
            'You might enjoy this. <RECOMMEND item="Arrival" reason="Similar puzzle-box plotting to Inception." />',
          ),
        ),
      ),
    );

    const { result } = renderHook(() => useChat(USER_ID, undefined, true));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("What should I watch next?");
    });

    const assistantMessage = result.current.messages[1];
    expect(assistantMessage.recommendation).toEqual({
      item: "Arrival",
      reason: "Similar puzzle-box plotting to Inception.",
    });
    expect(assistantMessage.footnote).toBeUndefined();
    expect(fakeSupabase.insertCalls.some((c) => c.table === "items")).toBe(false);
  });

  it("logs a 'missing' parse failure for a tag-less reply to an explicit recommendation request when the user has rated items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse("Let me think about that for a moment."))),
    );

    const { result } = renderHook(() => useChat(USER_ID, undefined, true));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("What should I watch next?");
    });

    expect(
      fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "missing"),
    ).toBe(true);
  });

  it("does NOT log a missing-recommendation failure when the user has no rated items yet (expected graceful decline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamingResponse("I don't have enough of your taste to go on yet — log a few movies first!"),
        ),
      ),
    );

    const { result } = renderHook(() => useChat(USER_ID, undefined, false));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("What should I watch next?");
    });

    expect(fakeSupabase.insertCalls.some((c) => c.table === "parse_failures")).toBe(false);
  });
});

describe("useChat — model history uses raw (tag-inclusive) content (Cycle 7: history-poisoning fix)", () => {
  /** Parses the JSON body of the nth fetch call to /api/chat. */
  function fetchBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): { messages: Array<{ role: string; content: string }> } {
    const init = fetchMock.mock.calls[call][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it("persists the assistant's raw output (tags intact) as raw_content alongside the cleaned display text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse('Great pick! <ADD item="Inception" rating="5" />'))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    const assistantInsert = fakeSupabase.insertCalls.find(
      (c) => c.table === "chat_messages" && c.payload.role === "assistant",
    );
    // Display text stays cleaned; the model-visible form keeps the tag.
    expect(assistantInsert?.payload.content).toBe("Great pick!");
    expect(assistantInsert?.payload.raw_content).toBe('Great pick! <ADD item="Inception" rating="5" />');
  });

  it("persists raw_content: null for a compliance miss so the tag-less claim is never replayed to the model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse("I'll update your rating for that movie now."))),
    );

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });

    const assistantInsert = fakeSupabase.insertCalls.find(
      (c) => c.table === "chat_messages" && c.payload.role === "assistant",
    );
    expect(assistantInsert?.payload.raw_content).toBeNull();
  });

  it("sends the model its own prior reply WITH the tag, not the cleaned display text", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(streamingResponse('Great pick! <ADD item="Inception" rating="5" />')),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(streamingResponse('Noted! <UPDATE item="Inception" rating="2" />')),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });
    await act(async () => {
      await result.current.sendMessage("Actually, Inception was worse on rewatch");
    });

    const secondBody = fetchBody(fetchMock, 1);
    const assistantTurns = secondBody.messages.filter((m) => m.role === "assistant");
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].content).toBe('Great pick! <ADD item="Inception" rating="5" />');
  });

  it("excludes an in-session compliance miss from the history sent on the next turn", async () => {
    const fetchMock = vi
      .fn()
      // Turn 1: 3 tag-less attempts against an opinion -> no_tag_final compliance miss.
      .mockImplementationOnce(() => Promise.resolve(streamingResponse("I'll update your rating now.")))
      .mockImplementationOnce(() => Promise.resolve(streamingResponse("I'll update your rating now.")))
      .mockImplementationOnce(() => Promise.resolve(streamingResponse("I'll update your rating now.")))
      // Turn 2.
      .mockImplementationOnce(() =>
        Promise.resolve(streamingResponse('Got it! <ADD item="Dune" rating="5" />')),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I loved Inception");
    });
    await act(async () => {
      await result.current.sendMessage("I loved Dune");
    });

    const secondTurnBody = fetchBody(fetchMock, 3);
    // The poisoned reply is displayed to the user but never shown to the model again;
    // both user turns survive.
    expect(secondTurnBody.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(secondTurnBody.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(result.current.messages.find((m) => m.role === "assistant")?.content).toBe(
      "I'll update your rating now.",
    );
  });

  it("excludes legacy persisted assistant rows (raw_content null) from model history while still displaying them", async () => {
    fakeSupabase = createFakeSupabaseTables({
      historyRows: [
        { id: "1", role: "user", content: "I loved Inception" },
        // Legacy pre-Cycle-7 row: cleaned text only — potentially a poisoned claim.
        { id: "2", role: "assistant", content: "I'll update your rating now.", raw_content: null },
        { id: "3", role: "user", content: "I loved Dune" },
        // Post-fix row: raw form persisted, tag intact.
        { id: "4", role: "assistant", content: "Got it!", raw_content: 'Got it! <ADD item="Dune" rating="5" />' },
      ],
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamingResponse('Nice! <ADD item="Tenet" rating="4" />')),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));
    expect(result.current.messages).toHaveLength(4);

    await act(async () => {
      await result.current.sendMessage("I liked Tenet");
    });

    const body = fetchBody(fetchMock);
    const assistantTurns = body.messages.filter((m) => m.role === "assistant");
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].content).toBe('Got it! <ADD item="Dune" rating="5" />');
  });
});

describe("useChat — missed want-to-watch <ADD> gets the retry-then-log safety net (Cycle 7)", () => {
  it("retries a watch intent that produced no tag, then falls back, logs 'missing', and shows a distinct footnote", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamingResponse("I'll add that to your want-to-watch list!")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat(USER_ID));
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    await act(async () => {
      await result.current.sendMessage("I want to watch Toy Story");
    });

    // Previously this was completely invisible: no opinion/recommendation signal fired,
    // so the claimed-but-unemitted watchlist add produced no retry, no log, no footnote.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fakeSupabase.insertCalls.some((c) => c.table === "parse_failures" && c.payload.reason === "missing"),
    ).toBe(true);
    expect(result.current.messages[1].footnote).toEqual({
      tone: "neutral",
      text: "Didn't catch a watchlist add there.",
    });
    // And, like every compliance miss, it must not poison future model history.
    const assistantInsert = fakeSupabase.insertCalls.find(
      (c) => c.table === "chat_messages" && c.payload.role === "assistant",
    );
    expect(assistantInsert?.payload.raw_content).toBeNull();
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
