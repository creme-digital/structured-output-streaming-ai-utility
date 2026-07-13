import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabaseAuth } from "../../../test/mockSupabase";

const auth = createFakeSupabaseAuth();

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: { auth },
}));

const { AuthProvider } = await import("../../../context/AuthContext");
const { AuthScreen } = await import("../AuthScreen");

function renderAuthScreen() {
  return render(
    <AuthProvider>
      <AuthScreen />
    </AuthProvider>,
  );
}

describe("AuthScreen (FR-006)", () => {
  it("shows a validation error when submitting without email/password", async () => {
    renderAuthScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/enter both an email and a password/i);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("signs in with the entered credentials", async () => {
    renderAuthScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "correct-password",
      }),
    );
  });

  it("surfaces a sign-in error from Supabase instead of failing silently", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } });
    renderAuthScreen();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect email or password/i);
  });

  it("toggles to sign-up mode and enforces the minimum password length", async () => {
    renderAuthScreen();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 6 characters/i);
    expect(auth.signUp).not.toHaveBeenCalled();
  });
});
