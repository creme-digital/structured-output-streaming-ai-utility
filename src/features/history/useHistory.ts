import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { HistoryEntry, HistoryLoadStatus } from "./types";

interface ItemRow {
  id: string;
  item: string;
  rating: number | null;
  status: string | null;
  created_at: string;
}

function rowToEntry(row: ItemRow): HistoryEntry {
  return {
    id: row.id,
    item: row.item,
    rating: row.rating,
    status: row.status === "want_to_watch" ? "want_to_watch" : "watched",
    createdAt: row.created_at,
  };
}

export interface UseHistoryResult {
  ratedItems: HistoryEntry[];
  watchlistItems: HistoryEntry[];
  status: HistoryLoadStatus;
}

/**
 * FR-010: the live history panel's data source — an initial RLS-scoped read of the
 * signed-in user's own `items` rows, kept live via a Supabase realtime subscription on
 * `items` INSERT events. Every historical row is kept (never deduped/merged): multiple
 * `<UPDATE>` entries for the same title stay visible as separate rows, per the PRD's
 * explicit "full uncollapsed rating history" requirement.
 *
 * Isolation: both the initial read and the realtime subscription are scoped to this
 * user's own `user_id` — the `.eq(...)`/`filter` here are a defense-in-depth/noise
 * nicety, not the isolation boundary; Postgres RLS (`002_items.sql`,
 * `006_items_status_and_realtime.sql`) is what actually prevents reading another user's
 * rows, for both the REST read and the realtime feed (Supabase evaluates RLS per
 * subscriber for `postgres_changes`).
 */
export function useHistory(userId: string): UseHistoryResult {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState<HistoryLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setEntries([]);

    async function loadInitial() {
      const { data, error } = await supabase
        .from("items")
        .select("id, item, rating, status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error || !data) {
        setStatus("error");
        return;
      }

      setEntries((data as ItemRow[]).map(rowToEntry));
      setStatus("ready");
    }

    void loadInitial();

    const channel = supabase
      .channel(`items-inserts-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "items", filter: `user_id=eq.${userId}` },
        (payload: { new: ItemRow }) => {
          if (cancelled) return;
          const incoming = rowToEntry(payload.new);
          setEntries((prev) => {
            // Guard against a double-add if the realtime event and the initial load race.
            if (prev.some((entry) => entry.id === incoming.id)) return prev;
            return [incoming, ...prev];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return {
    ratedItems: entries.filter((entry) => entry.status === "watched"),
    watchlistItems: entries.filter((entry) => entry.status === "want_to_watch"),
    status,
  };
}
