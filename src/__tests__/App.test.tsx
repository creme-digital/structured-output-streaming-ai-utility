import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabaseAuth, createFakeSupabaseTables } from "../test/mockSupabase";

const auth = createFakeSupabaseAuth();
const tables = createFakeSupabaseTables();

vi.mock("../lib/supabaseClient", () => ({
  // Cycle 6 / FR-010: Home now also renders the live history panel, whose `useHistory`
  // hook calls `supabase.channel(...)`/`removeChannel(...)` for its realtime
  // subscription — included here so rendering the authenticated `Home` screen doesn't
  // throw on a missing mock method.
  supabase: { auth, from: tables.from, channel: tables.channel, removeChannel: tables.removeChannel },
}));

const { App } = await import("../App");

describe("App auth gating (FR-006)", () => {
  it("shows the auth screen when there is no session", async () => {
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("shows the chat panel and sign-out control once a session exists", async () => {
    auth.getSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: "user-1", email: "demo@stealthco.test" },
        },
      },
    });

    render(<App />);

    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
    expect(screen.getByText("demo@stealthco.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("does not crash and shows a fallback if history loading fails", async () => {
    auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: "user-2", email: "demo2@stealthco.test" } } },
    });
    // Cycle 6 / FR-010: Home now mounts two independent `.from(...)` consumers on mount
    // (ChatPanel's chat history, HistoryPanel's item history via `useHistory`) whose
    // effect-firing order isn't something this test should depend on — keyed on table
    // name instead of "the first call" so this only ever exercises the chat-history
    // failure path, regardless of which effect happens to run first.
    const errorResult = Object.assign(Promise.resolve({ data: null, error: { message: "down" } }), {
      limit: () => Promise.resolve({ data: null, error: { message: "down" } }),
    });
    const errorBuilder = {
      select: () => errorBuilder,
      eq: () => errorBuilder,
      ilike: () => errorBuilder,
      order: () => errorResult,
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => {
        const chain = Object.assign(Promise.resolve({ data: null, error: null }), {
          eq: (): typeof chain => chain,
        });
        return chain;
      },
    };
    const originalImpl = tables.from.getMockImplementation()!;
    tables.from.mockImplementation((table: string) => (table === "chat_messages" ? errorBuilder : originalImpl(table)));

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/couldn't load your chat history/i)).toBeInTheDocument(),
    );
  });
});
