// Cycle 6 / FR-010: types for the live history panel. Mirrors the `items` row
// shape at the UI boundary — the build step's data hook (Supabase read +
// realtime subscription on INSERT events, RLS-scoped to the logged-in user)
// maps rows into this shape; this component tree never talks to Supabase
// directly.

export type HistoryEntryStatus = "watched" | "want_to_watch";

export interface HistoryEntry {
  id: string;
  item: string;
  /** ESTIMATED by the model, never present for a want-to-watch row (null). */
  rating: number | null;
  status: HistoryEntryStatus;
  createdAt: string;
}

export type HistoryLoadStatus = "loading" | "ready" | "error";
