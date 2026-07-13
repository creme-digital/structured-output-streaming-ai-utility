import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabaseAuth } from "../../test/mockSupabase";

const auth = createFakeSupabaseAuth();

vi.mock("../../lib/supabaseClient", () => ({
  supabase: { auth },
}));

// Imported after the mock so the module under test picks up the mocked client.
const { AuthProvider, useAuth } = await import("../AuthContext");

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("AuthContext (FR-006)", () => {
  it("starts initializing and resolves to signed-out when there is no session", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.initializing).toBe(true);

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.user).toBeNull();
  });

  it("signIn calls supabase.auth.signInWithPassword and surfaces errors", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.initializing).toBe(false));

    let response;
    await act(async () => {
      response = await result.current.signIn("user@example.com", "wrongpass");
    });

    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "wrongpass",
    });
    expect(response).toEqual({ error: "Incorrect email or password." });
  });

  it("signUp calls supabase.auth.signUp and passes through a friendly duplicate-account error", async () => {
    auth.signUp.mockResolvedValueOnce({ error: { message: "User already registered" } });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.initializing).toBe(false));

    let response;
    await act(async () => {
      response = await result.current.signUp("dup@example.com", "password123");
    });

    expect(response).toEqual({
      error: "An account with that email already exists — try signing in instead.",
    });
  });

  it("signOut calls supabase.auth.signOut", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.initializing).toBe(false));

    await act(async () => {
      await result.current.signOut();
    });

    expect(auth.signOut).toHaveBeenCalled();
  });
});
