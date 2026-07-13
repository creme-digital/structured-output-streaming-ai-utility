import { AppShell } from "./components/layout/AppShell";
import { Button, Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthScreen } from "./features/auth/AuthScreen";
import { Home } from "./pages/Home";

function AppContent() {
  const { session, user, initializing, signOut } = useAuth();

  return (
    <AppShell
      headerRight={
        session && user ? (
          <>
            <span className="app-shell__user">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </>
        ) : undefined
      }
    >
      {initializing ? (
        <div className="app-shell__loading" role="status" aria-live="polite">
          <Spinner label="Loading" />
        </div>
      ) : session && user ? (
        <Home />
      ) : (
        <AuthScreen />
      )}
    </AppShell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
