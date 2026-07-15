import { useState } from "react";
import { Badge, Card, Spinner, Tabs } from "../../components/ui";
import { HistoryEntry, HistoryLoadStatus } from "./types";
import "./HistoryPanel.css";

export interface HistoryPanelProps {
  /**
   * Rows with status "watched" (rated/logged items). Every historical row —
   * including multiple <UPDATE> entries for the same title — must be passed
   * uncollapsed (FR-010 acceptance criteria); this component never dedupes
   * or merges rows, it renders exactly what it's given, in order.
   */
  ratedItems: HistoryEntry[];
  /** Rows with status "want_to_watch" (no rating). */
  watchlistItems: HistoryEntry[];
  status: HistoryLoadStatus;
}

type TabId = "rated" | "watchlist";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "rated", label: "Rated" },
  { id: "watchlist", label: "Want to Watch" },
];

/**
 * Live history panel (FR-010): a panel on the right of the chat screen
 * showing the signed-in user's own logged items across two tabs — "Rated"
 * (status 'watched', with rating) and "Want to Watch" (status
 * 'want_to_watch', no rating, distinct badge per FR-005).
 *
 * Presentational only. Real-time behavior — the Supabase realtime
 * subscription on `items` INSERT events scoped to this user, and the initial
 * read, both RLS-enforced — is owned by the caller/build step; this
 * component just renders whatever `ratedItems` / `watchlistItems` / `status`
 * it's handed. Home.tsx currently passes empty placeholder data pending that
 * wiring, matching the same design/build split the rest of this app follows
 * (see DESIGN.md Cycle 6).
 */
export function HistoryPanel({ ratedItems, watchlistItems, status }: HistoryPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("rated");
  const entries = activeTab === "rated" ? ratedItems : watchlistItems;

  return (
    <Card className="history-panel" padded={false}>
      <Tabs
        tabs={TABS}
        activeId={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
        aria-label="Item history"
      />

      <div className="history-panel__scroll">
        {status === "loading" && (
          <div className="history-panel__state">
            <Spinner label="Loading your history" />
          </div>
        )}

        {status === "error" && (
          <div className="history-panel__state history-panel__state--error" role="alert">
            Couldn't load your history. Please refresh the page.
          </div>
        )}

        {status === "ready" && entries.length === 0 && (
          <div className="history-panel__empty">
            {activeTab === "rated"
              ? "Movies you rate in chat will show up here."
              : "Movies you want to watch will show up here."}
          </div>
        )}

        {status === "ready" &&
          entries.map((entry) => (
            <div key={entry.id} className="history-entry">
              <div className="history-entry__main">
                <span className="history-entry__title">{entry.item}</span>
                {entry.status === "want_to_watch" ? (
                  <Badge tone="watchlist">Want to watch</Badge>
                ) : (
                  <span className="history-entry__rating">
                    {entry.rating !== null ? `★ ${entry.rating}` : "—"}
                  </span>
                )}
              </div>
              <span className="history-entry__timestamp">{new Date(entry.createdAt).toLocaleString()}</span>
            </div>
          ))}
      </div>
    </Card>
  );
}
