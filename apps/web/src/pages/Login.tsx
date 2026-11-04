import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";

/** Only follow same-site paths, so a crafted ?next= link cannot redirect off the site. */
function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginPage() {
  const { user, login, sessionLost } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? safeNext(params.get("next"))} replace />;
  }

  const errors = submitted
    ? {
        email: email.trim() ? undefined : "Enter your email address",
        password: password ? undefined : "Enter your password",
      }
    : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(undefined);
    if (!email.trim() || !password) return;
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Sign in failed. Please try again.");
      setPassword("");
      setSubmitted(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          TestForge
        </div>
        <h1>Sign in</h1>
        <p className="muted">Order management for a fictional B2B supplier. All data is synthetic.</p>
        {sessionLost && !error && (
          <div className="alert alert-warning" role="alert" data-testid="session-expired">
            Your session has ended. Please sign in again.
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert" data-testid="login-error">
            {error}
          </div>
        )}
        <form onSubmit={submit} noValidate>
          <Field label="Email" error={errors.email}>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" error={errors.password}>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button type="submit" className="button button-primary button-block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
