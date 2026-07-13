import { FormEvent, useState } from "react";
import { Button, Card, Input } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import "./AuthScreen.css";

type Mode = "sign-in" | "sign-up";

/**
 * Email/password auth screen (FR-006). Single "user" role — there is no
 * admin/reviewer path, so this is the only auth surface the app has.
 */
export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const { signIn, signUp } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signUpComplete, setSignUpComplete] = useState(false);

  const isSignUp = mode === "sign-up";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Enter both an email and a password.");
      return;
    }
    if (isSignUp && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const result = isSignUp ? await signUp(email.trim(), password) : await signIn(email.trim(), password);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (isSignUp) {
        setSignUpComplete(true);
      }
    } catch {
      setError("Something went wrong reaching the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setSignUpComplete(false);
  }

  return (
    <div className="auth-screen">
      <div className="auth-screen__intro">
        <h1 className="auth-screen__title">{isSignUp ? "Create an account" : "Welcome back"}</h1>
        <p className="auth-screen__subtitle">
          Sign {isSignUp ? "up" : "in"} to chat and keep your logged movies across sessions.
        </p>
      </div>

      <Card>
        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {error && (
            <p className="auth-form__error" role="alert">
              {error}
            </p>
          )}
          {signUpComplete && !error && (
            <p className="auth-form__success" role="status">
              Account created — signing you in...
            </p>
          )}

          <Input
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            hint={isSignUp ? "At least 6 characters." : undefined}
            required
          />

          <Button className="auth-form__submit" type="submit" disabled={submitting}>
            {submitting ? "Please wait..." : isSignUp ? "Sign up" : "Sign in"}
          </Button>
        </form>
      </Card>

      <p className="auth-screen__toggle">
        {isSignUp ? (
          <>
            Already have an account?{" "}
            <Button variant="ghost" size="sm" type="button" onClick={() => switchMode("sign-in")}>
              Sign in
            </Button>
          </>
        ) : (
          <>
            New here?{" "}
            <Button variant="ghost" size="sm" type="button" onClick={() => switchMode("sign-up")}>
              Create an account
            </Button>
          </>
        )}
      </p>
    </div>
  );
}
