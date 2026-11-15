import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { CurrencySelect, ErrorText, Field } from "../components/ui";
import { timeAgo } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import type { Provider, TradingSettings, User } from "../types";

export function SettingsPage() {
  const { hash } = useLocation();
  const security = useLoad(() => api.get<SecurityOverview>("/api/settings/security"));
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Profile, security, AI providers and brokerage.</p>
        </div>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <SecurityCenter data={security.data} reload={security.reload} />
        <div className="grid grid-2">
          <ProfileCard />
          <PasswordCard />
        </div>
        <TwoFactorCard onChange={security.reload} />
        <AIKeysCard />
        <TradingCard />
        <SecurityLog />
      </div>
    </>
  );
}

function ProfileCard() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.patch<{ user: User }>("/api/settings/profile", { displayName, defaultCurrency: currency });
      setUser(r.user);
      toast("Profile saved");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>Profile</h2>
      <Field label="Display name">
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} required />
      </Field>
      <div className="grid grid-2">
        <Field label="Handle"><input className="input" value={`@${user?.handle}`} disabled /></Field>
        <Field label="Main currency"><CurrencySelect value={currency} onChange={setCurrency} /></Field>
      </div>
      <Field label="Email"><input className="input" value={user?.email} disabled /></Field>
      <ErrorText error={error} />
      <button className="btn" style={{ alignSelf: "flex-start" }}>Save profile</button>
    </form>
  );
}

function PasswordCard() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/settings/password", { currentPassword: current, newPassword: next, code: user?.totpEnabled ? code : undefined });
      toast("Password changed. Other devices were signed out.");
      setCurrent("");
      setNext("");
      setCode("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>Password</h2>
      <Field label="Current password">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 12 characters. A few unrelated words works well. Common or leaked passwords are refused. Changing it signs out other devices and pauses withdrawals for 24 hours.">
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
      </Field>
      {user?.totpEnabled && (
        <Field label="Authenticator code">
          <input className="input num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required style={{ maxWidth: 200 }} />
        </Field>
      )}
      <ErrorText error={error} />
      <button className="btn" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
    </form>
  );
}

/** Shows freshly issued recovery codes once, with copy and download. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = `Aurex recovery codes (each works once)\n\n${codes.join("\n")}\n`;
  return (
    <div className="banner" style={{ display: "block" }}>
      <strong>Save your recovery codes now.</strong>
      <p className="small" style={{ margin: "4px 0 10px" }}>
        If you lose your phone, each of these lets you sign in once. They won't be shown again. Store them somewhere safe, like a password manager.
      </p>
      <div className="code-grid">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <button type="button" className="btn sm secondary" onClick={() => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Couldn't copy", "error"))}>Copy</button>
        <a className="btn sm secondary" download="aurex-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>Download</a>
        <button type="button" className="btn sm" onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

function TwoFactorCard({ onChange }: { onChange: () => void }) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    try {
      setSetup(await api.post("/api/settings/2fa/setup"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/api/settings/2fa/confirm", { code });
      toast("Two-factor authentication is on");
      setSetup(null);
      setCode("");
      setCodes(r.recoveryCodes);
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function disable(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/settings/2fa/disable", { password, code });
      toast("Two-factor authentication turned off");
      setPassword("");
      setCode("");
      await refresh();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function regenerate() {
    if (!confirm_("Create new recovery codes? Your current ones will stop working.")) return;
    try {
      setCodes((await api.post<{ recoveryCodes: string[] }>("/api/settings/2fa/recovery-codes")).recoveryCodes);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="card stack" id="two-factor">
      <div className="row between">
        <h2>Two-factor authentication</h2>
        <span className={`pill ${user?.totpEnabled ? "good" : "warn"}`}>{user?.totpEnabled ? "On" : "Off"}</span>
      </div>
      <p className="muted small">Require a code from an authenticator app (Google Authenticator, 1Password, Authy…) when you sign in and before money leaves your account. Strongly recommended. Admins must use it.</p>
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      {!user?.totpEnabled && !setup && (
        <button className="btn" style={{ alignSelf: "flex-start" }} onClick={start}>Set up two-factor</button>
      )}
      {setup && (
        <form className="stack" onSubmit={confirm}>
          <div className="card" style={{ background: "var(--surface-2)", boxShadow: "none" }}>
            <div className="small muted">1. In your authenticator app, add an account with this key (or tap the link on your phone):</div>
            <div className="mono" style={{ fontSize: 16, letterSpacing: "0.08em", margin: "8px 0", wordBreak: "break-all" }}>{setup.secret.match(/.{1,4}/g)?.join(" ")}</div>
            <a href={setup.otpauthUri} className="small">Open in authenticator app</a>
          </div>
          <Field label="2. Enter the 6-digit code it shows">
            <input className="input num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required style={{ maxWidth: 200 }} />
          </Field>
          <button className="btn" style={{ alignSelf: "flex-start" }}>Turn on</button>
        </form>
      )}
      {user?.totpEnabled && (
        <>
          <div className="row wrap">
            <button type="button" className="btn sm secondary" onClick={regenerate}>New recovery codes</button>
          </div>
          {user.role !== "admin" && (
            <form className="row wrap" onSubmit={disable} style={{ alignItems: "flex-end" }}>
              <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
              <Field label="Current code"><input className="input num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required /></Field>
              <button className="btn secondary">Turn off</button>
            </form>
          )}
        </>
      )}
      <ErrorText error={error} />
    </div>
  );
}

const confirm_ = (msg: string) => window.confirm(msg);

interface SecurityOverview {
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  securityHoldUntil: string | null;
  reauthWindowMinutes: number;
  stepUpSendUsd: number;
  sessions: { id: string; device: string; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean }[];
  alerts: { id: number; kind: string; message: string; ip: string | null; createdAt: string; read: boolean }[];
  admin: { canClaim: boolean; requires2fa: boolean };
}

/** Devices, alerts, backup codes and holds in one place. */
function SecurityCenter({ data, reload }: { data: SecurityOverview | null; reload: () => void }) {
  const toast = useToast();
  const { user, setUser } = useAuth();
  const [adminCode, setAdminCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const unread = (data?.alerts ?? []).filter((a) => !a.read).length;

  useEffect(() => {
    if (unread > 0) {
      const t = setTimeout(() => api.post("/api/settings/security/alerts/read").catch(() => undefined), 4000);
      return () => clearTimeout(t);
    }
  }, [unread]);

  async function revoke(id: string) {
    await api.del(`/api/settings/sessions/${id}`);
    toast("Device signed out");
    reload();
  }
  async function revokeOthers() {
    await api.post("/api/settings/sessions/revoke-others");
    toast("Signed out everywhere else");
    reload();
  }
  async function claim(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ user: User }>("/api/settings/admin/claim", { code: adminCode });
      setUser(r.user);
      toast("Admin access granted");
      setAdminCode("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!data) return <div className="card"><div className="skeleton" style={{ height: 160 }} /></div>;
  const others = data.sessions.filter((s) => !s.current).length;
  return (
    <div className="card stack" id="security">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>Security center</h2>
        <span className={`pill ${data.totpEnabled ? "good" : "warn"}`}>{data.totpEnabled ? "Protected with 2FA" : "Turn on 2FA"}</span>
      </div>

      {data.securityHoldUntil && (
        <div className="banner">
          <Icon.Shield size={16} />
          <span>Withdrawals and large sends are paused until {new Date(data.securityHoldUntil).toLocaleString()} after a recent security change. This protects you if someone else made it.</span>
        </div>
      )}

      <div className="grid grid-3">
        <div><div className="stat-label">Signed-in devices</div><div className="stat-value" style={{ fontSize: 22 }}>{data.sessions.length}</div></div>
        <div><div className="stat-label">Recovery codes left</div><div className="stat-value" style={{ fontSize: 22 }}>{data.totpEnabled ? data.recoveryCodesLeft : "—"}</div></div>
        <div><div className="stat-label">Password re-check</div><div className="stat-sub">Before withdrawals and sends over ${data.stepUpSendUsd.toLocaleString()}, valid {data.reauthWindowMinutes} min</div></div>
      </div>

      <div>
        <div className="row between" style={{ marginBottom: 4 }}>
          <h3 style={{ fontSize: 15 }}>Devices</h3>
          {others > 0 && <button className="btn ghost sm" onClick={revokeOthers}>Sign out all other devices</button>}
        </div>
        {data.sessions.map((s) => (
          <div className="session-row" key={s.id}>
            <Icon.Phone size={18} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{s.device} {s.current && <span className="pill good" style={{ marginLeft: 4 }}>This device</span>}</div>
              <div className="faint xs">{s.ip ? `${s.ip} · ` : ""}active {timeAgo(s.lastSeenAt)} · signed in {timeAgo(s.createdAt)}</div>
            </div>
            {!s.current && <button className="btn ghost sm" onClick={() => revoke(s.id)}>Sign out</button>}
          </div>
        ))}
      </div>

      <div>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Security alerts</h3>
        {data.alerts.length === 0 && <p className="muted small">Nothing unusual. New sign-ins, password changes and lockouts show up here.</p>}
        {data.alerts.slice(0, 8).map((a) => (
          <div key={a.id} className={`alert-row ${a.read ? "" : "unread"}`}>
            <span className={`pill ${a.read ? "" : "warn"}`} style={{ flex: "none" }}>{a.read ? "Seen" : "New"}</span>
            <div className="grow"><strong style={{ fontWeight: a.read ? 500 : 650 }}>{a.message}</strong><div className="faint xs">{timeAgo(a.createdAt)}</div></div>
          </div>
        ))}
      </div>

      {data.admin.canClaim && user?.role !== "admin" && (
        <form className="stack" onSubmit={claim} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <h3 style={{ fontSize: 15 }}>Admin access</h3>
          <p className="muted small">This account is listed as an administrator. Enter the setup code from the server configuration{data.admin.requires2fa && !data.totpEnabled ? " after turning on two-factor authentication" : ""}.</p>
          <div className="row wrap" style={{ alignItems: "flex-end" }}>
            <Field label="Admin setup code"><input className="input mono" value={adminCode} onChange={(e) => setAdminCode(e.target.value)} required autoComplete="off" /></Field>
            <button className="btn" disabled={!adminCode}>Claim admin access</button>
          </div>
          <ErrorText error={error} />
        </form>
      )}
    </div>
  );
}

function AIKeysCard() {
  const toast = useToast();
  const providers = useLoad(() => api.get<{ providers: Provider[] }>("/api/ai/providers").then((r) => r.providers));
  const keys = useLoad(() => api.get<{ keys: { provider: string; hint: string; createdAt: string }[] }>("/api/settings/api-keys").then((r) => r.keys));
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent, provider: string) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/settings/api-keys/${provider}`, { apiKey: value, verify });
      toast("Key saved and encrypted");
      setEditing(null);
      setValue("");
      keys.reload();
      providers.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: string) {
    await api.del(`/api/settings/api-keys/${provider}`);
    keys.reload();
    providers.reload();
  }

  return (
    <div className="card" id="ai-keys">
      <div className="card-head">
        <div>
          <h2>AI provider keys</h2>
          <p className="muted small" style={{ marginTop: 4 }}>
            Bring your own keys to use any provider. Keys are encrypted (AES-256-GCM) on the server and never shown again; usage is billed by the provider to your account.
          </p>
        </div>
      </div>
      <div className="list">
        {(providers.data ?? []).filter((p) => p.keyRequired).map((p) => {
          const mine = keys.data?.find((k) => k.provider === p.id);
          return (
            <div key={p.id} className="list-item" style={{ flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="faint small">{p.description}</div>
              </div>
              {mine ? (
                <span className="pill good">Your key ••••{mine.hint}</span>
              ) : p.source === "server" ? (
                <span className="pill brand">Provided by server</span>
              ) : (
                <span className="pill">Not connected</span>
              )}
              <div className="row" style={{ gap: 6 }}>
                {p.keyUrl && <a className="btn ghost sm" href={p.keyUrl} target="_blank" rel="noopener noreferrer">Get key</a>}
                <button className="btn secondary sm" onClick={() => { setEditing(editing === p.id ? null : p.id); setValue(""); setError(null); }}>
                  {mine ? "Replace" : "Add key"}
                </button>
                {mine && <button className="btn ghost sm" onClick={() => remove(p.id)}>Remove</button>}
              </div>
              {editing === p.id && (
                <form className="row wrap" style={{ width: "100%", marginTop: 8 }} onSubmit={(e) => save(e, p.id)}>
                  <input className="input grow" type="password" autoComplete="off" placeholder={`${p.name} API key`} value={value} onChange={(e) => setValue(e.target.value)} required minLength={8} style={{ minWidth: 220 }} />
                  <label className="row small muted"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Test key first</label>
                  <button className="btn" disabled={busy}>{busy ? "Checking…" : "Save"}</button>
                  <div style={{ width: "100%" }}><ErrorText error={error} /></div>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradingCard() {
  const toast = useToast();
  const { meta } = useAuth();
  const state = useLoad(() => api.get<{ settings: TradingSettings }>("/api/trading/account").then((r) => r.settings));
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = state.data;

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ settings: TradingSettings }>("/api/trading/alpaca-keys", { keyId, secretKey: secret });
      state.setData(r.settings);
      setKeyId("");
      setSecret("");
      toast(`Alpaca ${r.settings.alpacaEnv} account connected`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setBroker(broker: "paper" | "alpaca") {
    try {
      const r = await api.put<{ settings: TradingSettings }>("/api/trading/broker", { broker });
      state.setData(r.settings);
      toast(broker === "paper" ? "Using the built-in paper account" : "Orders now route to Alpaca");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function disconnect() {
    const r = await api.del<{ settings: TradingSettings }>("/api/trading/alpaca-keys");
    state.setData(r.settings);
  }

  return (
    <div className="card stack" id="trading">
      <div>
        <h2>Brokerage</h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          Trade with the built-in paper account, or connect your own <a href="https://alpaca.markets" target="_blank" rel="noopener noreferrer">Alpaca</a> account for real market data and paper or live brokerage.
          {meta?.trading.liveTradingAllowed ? " Live (real-money) Alpaca accounts are allowed on this server." : " This server only accepts Alpaca paper keys."}
        </p>
      </div>
      {s && (
        <div className="row wrap">
          <span className="small muted">Route orders to:</span>
          <div className="seg">
            <button className={s.broker === "paper" ? "on" : ""} onClick={() => setBroker("paper")}>Built-in paper</button>
            <button className={s.broker === "alpaca" ? "on" : ""} onClick={() => setBroker("alpaca")} disabled={!s.alpacaConnected}>
              Alpaca {s.alpacaEnv ? `(${s.alpacaEnv})` : ""}
            </button>
          </div>
          <span className={`pill ${s.dataSource === "alpaca" ? "good" : "warn"}`}>{s.dataSource === "alpaca" ? "Live market data" : "Simulated market data"}</span>
        </div>
      )}
      {s?.alpacaConnected ? (
        <div className="row">
          <span className="pill good">Alpaca {s.alpacaEnv} keys connected</span>
          <button className="btn ghost sm" onClick={disconnect}>Disconnect</button>
        </div>
      ) : (
        <form className="grid grid-3" onSubmit={connect} style={{ alignItems: "end" }}>
          <Field label="Alpaca API key ID"><input className="input" value={keyId} onChange={(e) => setKeyId(e.target.value)} required autoComplete="off" /></Field>
          <Field label="Alpaca secret key"><input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoComplete="off" /></Field>
          <button className="btn" disabled={busy}>{busy ? "Verifying…" : "Connect Alpaca"}</button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function SecurityLog() {
  const log = useLoad(() => api.get<{ events: { id: number; action: string; ip: string | null; createdAt: string }[] }>("/api/settings/security-log").then((r) => r.events));
  return (
    <div className="card">
      <div className="card-head"><h2>Recent account activity</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Event</th><th>IP</th><th className="r">When</th></tr></thead>
          <tbody>
            {(log.data ?? []).map((e) => (
              <tr key={e.id}>
                <td>{e.action.replace(/[._]/g, " ")}</td>
                <td className="mono faint">{e.ip ?? "—"}</td>
                <td className="r faint">{timeAgo(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
