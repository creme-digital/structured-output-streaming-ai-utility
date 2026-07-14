import { ChatPanel } from "../features/chat/ChatPanel";
import { useAuth } from "../context/AuthContext";

/**
 * Authenticated landing screen. Only ever rendered once a session exists
 * (see App.tsx), so `user` is guaranteed here.
 */
export function Home() {
  const { user, session } = useAuth();
  if (!user) return null;
  // Cycle 4 / FR-009: pass the current access token so the edge function can read this
  // user's own logged titles (RLS-scoped) for <UPDATE> fuzzy-matching.
  return <ChatPanel userId={user.id} accessToken={session?.access_token} />;
}
