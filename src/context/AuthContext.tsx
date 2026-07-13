import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";

export interface AuthResult {
  error: string | null;
  /**
   * True when sign-up succeeded but Supabase did NOT return a session — i.e. the
   * project requires email confirmation before the account can log in. Callers
   * must not assume a successful sign-up means the user is now authenticated.
   */
  needsEmailConfirmation?: boolean;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  /** True only while the initial session is being resolved on first load. */
  initializing: boolean;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSession(data.session);
        setInitializing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSession(null);
        setInitializing(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      initializing,
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
          return { error: friendlyAuthError(error.message) };
        }
        // Supabase returns no session when the project requires email confirmation
        // before first login — the account exists but isn't signed in yet. Surface
        // that distinction so the UI never claims a sign-in that didn't happen.
        return { error: null, needsEmailConfirmation: !data.session };
      },
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error ? friendlyAuthError(error.message) : null };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    }),
    [session, initializing],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

/** Supabase auth error messages are generally fine to surface directly, but a couple are worth softening. */
function friendlyAuthError(message: string): string {
  if (/already registered/i.test(message)) {
    return "An account with that email already exists — try signing in instead.";
  }
  if (/invalid login credentials/i.test(message)) {
    return "Incorrect email or password.";
  }
  return message;
}
