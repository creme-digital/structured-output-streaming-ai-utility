import { ChatPanel } from "../features/chat/ChatPanel";
import { useAuth } from "../context/AuthContext";

/**
 * Authenticated landing screen. Only ever rendered once a session exists
 * (see App.tsx), so `user` is guaranteed here.
 */
export function Home() {
  const { user } = useAuth();
  if (!user) return null;
  return <ChatPanel userId={user.id} />;
}
