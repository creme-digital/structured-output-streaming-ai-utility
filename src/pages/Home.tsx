import { ChatPanel } from "../features/chat/ChatPanel";
import { HistoryPanel } from "../features/history/HistoryPanel";
import { useHistory } from "../features/history/useHistory";
import { useAuth } from "../context/AuthContext";
import "./Home.css";

/**
 * Authenticated landing screen. Only ever rendered once a session exists
 * (see App.tsx), so `user` is guaranteed here.
 *
 * Cycle 6 / FR-010: the chat panel now shares the screen with a live history
 * panel on the right ("Rated" / "Want to Watch" tabs), per the dev's own
 * description — "a log on the right of the chat with a rated and want to
 * watch tab." `useHistory` owns the RLS-scoped Supabase read plus the
 * realtime subscription on `items` INSERT events that feeds it; `HistoryPanel`
 * itself stays presentational. Whether the user has any rated item is also
 * threaded into `ChatPanel` (FR-004/FR-008) so the two features share one
 * source of truth for "has this user rated anything yet."
 */
export function Home() {
  const { user, session } = useAuth();
  const { ratedItems, watchlistItems, status } = useHistory(user?.id ?? "");
  if (!user) return null;
  return (
    <div className="home-layout">
      <ChatPanel userId={user.id} accessToken={session?.access_token} hasRatedItems={ratedItems.length > 0} />
      <HistoryPanel ratedItems={ratedItems} watchlistItems={watchlistItems} status={status} />
    </div>
  );
}
