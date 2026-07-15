import { ChatPanel } from "../features/chat/ChatPanel";
import { HistoryPanel } from "../features/history/HistoryPanel";
import { useAuth } from "../context/AuthContext";
import "./Home.css";

/**
 * Authenticated landing screen. Only ever rendered once a session exists
 * (see App.tsx), so `user` is guaranteed here.
 *
 * Cycle 6 / FR-010: the chat panel now shares the screen with a live history
 * panel on the right ("Rated" / "Want to Watch" tabs), per the dev's own
 * description — "a log on the right of the chat with a rated and want to
 * watch tab." `HistoryPanel` is presentational only here and is currently
 * wired with empty/loading placeholder data; the build step owns the actual
 * Supabase read plus the realtime subscription on `items` INSERT events
 * (RLS-scoped to this user) that will feed it real rows, the same
 * design/build split this app has followed since Cycle 1's placeholder Home.
 */
export function Home() {
  const { user, session } = useAuth();
  if (!user) return null;
  return (
    <div className="home-layout">
      <ChatPanel userId={user.id} accessToken={session?.access_token} />
      <HistoryPanel ratedItems={[]} watchlistItems={[]} status="loading" />
    </div>
  );
}
