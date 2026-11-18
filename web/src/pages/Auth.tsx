import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Logo } from "../components/Logo";
import { ErrorText, Field } from "../components/ui";
import { CurrencySelect } from "../components/ui";
import { useAuth, useLoad } from "../state";
import type { User } from "../types";

/** Where to go after signing in: a safe, same-site path from ?next=, or the dashboard. */
function useNext(fallback: string) {
  const [params] = useSearchParams();
  const next = params.get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

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
  const next = useNext((location.state as { from?: string } | null)?.from ?? "/app");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/api/auth/login", { email, password, totpCode: needTotp ? totpCode : undefined });
      setUser(user);
      navigate(next, { replace: true });
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
          <Field
            label={useRecovery ? "Recovery code" : "Authenticator code"}
            hint={
              <>
                {useRecovery ? "Each recovery code works once. Signing in with one pauses withdrawals for 24 hours as a precaution. " : "Open your authenticator app and enter the 6-digit code. "}
                <button type="button" className="link-btn" onClick={() => { setUseRecovery(!useRecovery); setTotpCode(""); }}>
                  {useRecovery ? "Use the app instead" : "Lost your phone? Use a recovery code"}
                </button>
              </>
            }
          >
            <input
              className="input num"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              maxLength={useRecovery ? 14 : 6}
              value={totpCode}
              onChange={(e) => setTotpCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
              autoFocus
              required
            />
          </Field>
        )}
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          New here? <Link to={`/register${location.search}`}>Create an account</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export const VERIFY_KEY = "aurex-verify-email";

export function RegisterPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = useNext("/app");
  const signup = useLoad(() => api.get<{ mode: "open" | "invite" | "closed"; full: boolean; waitlist: boolean }>("/api/public/signup"));
  const inviteFromLink = new URLSearchParams(location.search).get("invite") ?? "";
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ displayName: "", handle: "", email: "", password: "", defaultCurrency: "USD", inviteCode: inviteFromLink });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user, emailVerification } = await api.post<{ user: User; emailVerification: { devCode?: string } | null }>("/api/auth/register", {
        ...form,
        inviteCode: form.inviteCode.trim() || undefined,
      });
      // Prompt for the emailed code on arrival (in development the code itself comes back too).
      if (emailVerification) {
        try {
          sessionStorage.setItem(VERIFY_KEY, JSON.stringify({ devCode: emailVerification.devCode ?? null }));
        } catch {
          /* storage unavailable: the dashboard banner still offers verification */
        }
      }
      setUser(user);
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = signup.data;
  const gated = s && (s.mode === "closed" || s.full) && !inviteFromLink;
  if (gated && !showForm) {
    return (
      <AuthShell title="Join the waitlist" subtitle={s.full ? "Aurex is full for now: we're letting people in in small groups." : "Sign-ups are paused while we open up in stages."}>
        <Waitlist />
        <p className="small muted" style={{ textAlign: "center" }}>
          Have an invite? <button type="button" className="link-btn" onClick={() => setShowForm(true)}>Create your account</button> · <Link to={`/login${location.search}`}>Sign in</Link>
        </p>
      </AuthShell>
    );
  }
  const needsInvite = s?.mode === "invite" || ((s?.mode === "closed" || s?.full) && showForm);

  return (
    <AuthShell title="Create your account" subtitle={needsInvite ? "Aurex is invite-only during the beta." : "Payments, AI and investing in one place."}>
      <form className="stack" onSubmit={submit}>
        {needsInvite && (
          <Field label="Invite code" hint="From your invite email or the person who invited you">
            <input className="input mono" value={form.inviteCode} onChange={(e) => set("inviteCode")(e.target.value.toUpperCase())} autoComplete="off" placeholder="ABCDE-FGHJK" />
          </Field>
        )}
        <Field label="Full name">
          <input className="input" autoComplete="name" value={form.displayName} onChange={(e) => set("displayName")(e.target.value)} required maxLength={60} />
        </Field>
        <Field label="Handle" hint="How friends find you, e.g. @amara">
          <input className="input" autoComplete="username" value={form.handle} onChange={(e) => set("handle")(e.target.value.replace(/[^a-zA-Z0-9_@]/g, ""))} required minLength={3} maxLength={21} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={form.email} onChange={(e) => set("email")(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 12 characters with a letter and a number. A few unrelated words works well; common or leaked passwords are refused.">
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password")(e.target.value)} required minLength={12} />
        </Field>
        <Field label="Main currency">
          <CurrencySelect value={form.defaultCurrency} onChange={set("defaultCurrency")} />
        </Field>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          Already have an account? <Link to={`/login${location.search}`}>Sign in</Link>
        </p>
      </form>
      {needsInvite && (
        <details style={{ marginTop: 12 }}>
          <summary className="small" style={{ cursor: "pointer", textAlign: "center" }}>No invite yet? Join the waitlist</summary>
          <div style={{ marginTop: 10 }}><Waitlist /></div>
        </details>
      )}
    </AuthShell>
  );
}

function Waitlist() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function join(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/public/waitlist", { email, name: name || undefined });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (done) return <div className="banner info" role="status">You're on the list. We'll email {email} an invite when there's a place for you.</div>;
  return (
    <form className="stack" onSubmit={join}>
      <Field label="Your name (optional)"><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
      <Field label="Email"><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ErrorText error={error} />
      <button className="btn block" disabled={busy}>{busy ? "Joining…" : "Join the waitlist"}</button>
    </form>
  );
}
