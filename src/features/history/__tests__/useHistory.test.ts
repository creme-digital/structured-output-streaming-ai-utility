import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabaseTables } from "../../../test/mockSupabase";

let fakeSupabase: ReturnType<typeof createFakeSupabaseTables>;

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    get from() {
      return fakeSupabase.from;
    },
    get channel() {
      return fakeSupabase.channel;
    },
    get removeChannel() {
      return fakeSupabase.removeChannel;
    },
  },
}));

const { useHistory } = await import("../useHistory");

const USER_ID = "user-123";

beforeEach(() => {
  fakeSupabase = createFakeSupabaseTables();
});

describe("useHistory (FR-010: live history panel data source)", () => {
  it("loads the signed-in user's items and splits them into rated vs want-to-watch, uncollapsed", async () => {
    fakeSupabase = createFakeSupabaseTables({
      historyRows: [
        { id: "1", item: "Inception", rating: 2, status: "watched", created_at: "2024-01-01T00:00:00Z" },
        { id: "2", item: "Inception", rating: 5, status: "watched", created_at: "2024-01-05T00:00:00Z" },
        { id: "3", item: "Dune", rating: null, status: "want_to_watch", created_at: "2024-01-02T00:00:00Z" },
      ],
    });

    const { result } = renderHook(() => useHistory(USER_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Two historical rows for the same title stay separate — never deduped/merged
    // (FR-010's "full uncollapsed rating history" requirement).
    expect(result.current.ratedItems).toHaveLength(2);
    expect(result.current.ratedItems.map((e) => e.item)).toEqual(["Inception", "Inception"]);
    expect(result.current.watchlistItems).toHaveLength(1);
    expect(result.current.watchlistItems[0]).toMatchObject({ item: "Dune", rating: null, status: "want_to_watch" });
  });

  it("surfaces a load error instead of hanging or crashing", async () => {
    fakeSupabase = createFakeSupabaseTables({ historyError: { message: "down" } });
    const { result } = renderHook(() => useHistory(USER_ID));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("appends a new row when a realtime INSERT event fires, without a manual refresh", async () => {
    const { result } = renderHook(() => useHistory(USER_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const channel = fakeSupabase.channels.get(`items-inserts-${USER_ID}`);
    expect(channel).toBeDefined();

    act(() => {
      channel!.emit({
        new: { id: "new-1", item: "Arrival", rating: 4, status: "watched", created_at: "2024-02-01T00:00:00Z" },
      });
    });

    await waitFor(() => expect(result.current.ratedItems.map((e) => e.item)).toContain("Arrival"));
  });

  it("routes a realtime want-to-watch INSERT to the watchlist list, not the rated list", async () => {
    const { result } = renderHook(() => useHistory(USER_ID));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const channel = fakeSupabase.channels.get(`items-inserts-${USER_ID}`);

    act(() => {
      channel!.emit({
        new: { id: "new-2", item: "Blade Runner 2049", rating: null, status: "want_to_watch", created_at: "2024-02-02T00:00:00Z" },
      });
    });

    await waitFor(() => expect(result.current.watchlistItems.map((e) => e.item)).toContain("Blade Runner 2049"));
    expect(result.current.ratedItems.map((e) => e.item)).not.toContain("Blade Runner 2049");
  });

  it("unsubscribes the realtime channel on unmount", async () => {
    const { unmount } = renderHook(() => useHistory(USER_ID));
    await waitFor(() => expect(fakeSupabase.channel).toHaveBeenCalled());
    unmount();
    expect(fakeSupabase.removeChannel).toHaveBeenCalled();
  });
});
