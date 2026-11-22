import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Logo } from "../components/Logo";
import { ErrorText, Field } from "../components/ui";
import { CurrencySelect } from "../components/ui";
import { useAuth, useLoad } from "../state";
import { useCaptcha } from "../components/Turnstile";
import type { User } from "../types";

/** Where to go after signing in: a safe, same-site path from ?next=, or the dashboard. */
function useNext(fallback: string) {
  const [params] = useSearchParams();
  const next = params.get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
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
  const captcha = useCaptcha();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/api/auth/login", { email, password, totpCode: needTotp ? totpCode : undefined, captchaToken: captcha.token ?? undefined });
      setUser(user);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        setNeedTotp(true);
        setError(null);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
      captcha.reset(); // each token works once
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Aurex account.">
      <form className="stack" onSubmit={submit}>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint={<Link to="/forgot-password" className="small">Forgot your password?</Link>}>
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
        {captcha.widget}
        <button className="btn block lg" disabled={busy || !captcha.ready}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          New here? <Link to={`/register${location.search}`}>Create an account</Link>
        </p>
      </form>
    </AuthShell>
  );
}

/** "Forgot your password?": asks for the email address and sends a reset link to it. */
export function ForgotPasswordPage() {
  const captcha = useCaptcha();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/password/forgot", { email, captchaToken: captcha.token ?? undefined });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      captcha.reset(); // each token works once
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={`If ${email} belongs to an Aurex account with a confirmed email address, a reset link is on its way.`}>
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>The link works once, for 30 minutes. Nothing arrived? Check spam, or wait a minute and ask again. If you never confirmed your email address, contact support.</p>
          <Link to="/login" className="btn secondary block">Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email address and we'll send you a link to choose a new one.">
      <form className="stack" onSubmit={submit}>
        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <ErrorText error={error} />
        {captcha.widget}
        <button className="btn block lg" disabled={busy || !captcha.ready}>{busy ? "Sending…" : "Send reset link"}</button>
        <p className="small muted" style={{ textAlign: "center" }}>
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}

/** Opened from the emailed link: choose a new password (and give the authenticator code when 2FA is on). */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  // Keep the token out of the address bar (and browser history) once it's been read.
  const [token] = useState(() => params.get("token") ?? "");
  useEffect(() => {
    if (window.location.search.includes("token=")) window.history.replaceState(null, "", "/reset-password");
  }, []);
  const link = useLoad(() => api.post<{ valid: boolean; twoFactor: boolean }>("/api/auth/password/reset/check", { token }));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/password/reset", { token, password, code: link.data?.twoFactor ? code : undefined });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Password changed" subtitle="Sign in with your new password. Every device was signed out.">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>As a precaution, withdrawals and large payments are paused for a while after a reset.</p>
          <Link to="/login" className="btn block">Sign in</Link>
        </div>
      </AuthShell>
    );
  }
  if (link.loading) return <AuthShell title="Choose a new password" subtitle="Checking your link…"><div /></AuthShell>;
  if (!link.data?.valid) {
    return (
      <AuthShell title="This link doesn't work" subtitle="It has expired or was already used.">
        <Link to="/forgot-password" className="btn block">Ask for a new link</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle="Pick one you don't use anywhere else.">
      <form className="stack" onSubmit={submit}>
        <Field label="New password" hint="At least 12 characters with a letter and a number. A few unrelated words works well.">
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoFocus />
        </Field>
        <Field label="Type it again">
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} />
        </Field>
        {link.data.twoFactor && (
          <Field label="Authenticator code" hint="Two-factor authentication is on: enter the 6-digit code from your app, or one of your recovery codes.">
            <input className="input num" autoComplete="one-time-code" maxLength={14} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
        )}
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </form>
    </AuthShell>
  );
}

export const VERIFY_KEY = "aurex-verify-email";

export function RegisterPage() {
  const captcha = useCaptcha();
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
        captchaToken: captcha.token ?? undefined,
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
      captcha.reset(); // each token works once
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
        <p className="xs muted" style={{ margin: 0 }}>
          By creating an account you agree to the <Link to="/terms" target="_blank">Terms of Service</Link> and confirm you've read the <Link to="/privacy" target="_blank">Privacy Policy</Link> and <Link to="/risk" target="_blank">Risk warnings</Link>.
        </p>
        {captcha.widget}
        <button className="btn block lg" disabled={busy || !captcha.ready}>{busy ? "Creating account…" : "Create account"}</button>
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
  const captcha = useCaptcha();
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
      await api.post("/api/public/waitlist", { email, name: name || undefined, captchaToken: captcha.token ?? undefined });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      captcha.reset(); // each token works once
    }
  }
  if (done) return <div className="banner info" role="status">You're on the list. We'll email {email} an invite when there's a place for you.</div>;
  return (
    <form className="stack" onSubmit={join}>
      <Field label="Your name (optional)"><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
      <Field label="Email"><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ErrorText error={error} />
      {captcha.widget}
      <button className="btn block" disabled={busy || !captcha.ready}>{busy ? "Joining…" : "Join the waitlist"}</button>
    </form>
  );
}
