import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { Logo } from "../components/Logo";
import { ErrorText, Field } from "../components/ui";
import { CurrencySelect } from "../components/ui";
import { useAuth } from "../state";
import type { User } from "../types";

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <Link to="/" className="brand" style={{ justifyContent: "center", padding: "0 0 18px" }}>
          <Logo size={30} />
          <span>Aurex</span>
        </Link>
        <div className="card" style={{ padding: 26 }}>
          <h1 style={{ fontSize: 22 }}>{title}</h1>
          <p className="muted small" style={{ margin: "4px 0 20px" }}>{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/api/auth/login", { email, password, totpCode: needTotp ? totpCode : undefined });
      setUser(user);
      navigate((location.state as { from?: string } | null)?.from ?? "/app", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        setNeedTotp(true);
        setError(null);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Aurex account.">
      <form className="stack" onSubmit={submit}>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {needTotp && (
          <Field label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
            <input className="input num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
          </Field>
        )}
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          New here? <Link to="/register">Create an account</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: "", handle: "", email: "", password: "", defaultCurrency: "USD" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/api/auth/register", form);
      setUser(user);
      navigate("/app", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Payments, AI and investing in one place.">
      <form className="stack" onSubmit={submit}>
        <Field label="Full name">
          <input className="input" autoComplete="name" value={form.displayName} onChange={(e) => set("displayName")(e.target.value)} required maxLength={60} />
        </Field>
        <Field label="Handle" hint="How friends find you, e.g. @amara">
          <input className="input" autoComplete="username" value={form.handle} onChange={(e) => set("handle")(e.target.value.replace(/[^a-zA-Z0-9_@]/g, ""))} required minLength={3} maxLength={21} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={form.email} onChange={(e) => set("email")(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 10 characters with a letter and a number.">
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password")(e.target.value)} required minLength={10} />
        </Field>
        <Field label="Main currency">
          <CurrencySelect value={form.defaultCurrency} onChange={set("defaultCurrency")} />
        </Field>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
