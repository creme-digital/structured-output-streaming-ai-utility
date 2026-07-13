import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabaseAuth, createFakeSupabaseTables } from "../test/mockSupabase";

const auth = createFakeSupabaseAuth();
const tables = createFakeSupabaseTables();

vi.mock("../lib/supabaseClient", () => ({
  supabase: { auth, from: tables.from },
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
    tables.from.mockImplementationOnce(() => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => Promise.resolve({ data: null, error: { message: "down" } }),
        insert: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/couldn't load your chat history/i)).toBeInTheDocument(),
    );
  });
});
