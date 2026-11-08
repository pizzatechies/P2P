import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import { CurrencySelect, ErrorText, Field } from "../components/ui";
import { timeAgo } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import type { Provider, TradingSettings, User } from "../types";

export function SettingsPage() {
  const { hash } = useLocation();
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
        <div className="grid grid-2">
          <ProfileCard />
          <PasswordCard />
        </div>
        <TwoFactorCard />
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
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/settings/password", { currentPassword: current, newPassword: next });
      toast("Password changed. Other devices were signed out.");
      setCurrent("");
      setNext("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>Password</h2>
      <Field label="Current password">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 10 characters with a letter and a number. Changing it signs out your other sessions.">
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
      </Field>
      <ErrorText error={error} />
      <button className="btn" style={{ alignSelf: "flex-start" }}>Change password</button>
    </form>
  );
}

function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
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
      await api.post("/api/settings/2fa/confirm", { code });
      toast("Two-factor authentication is on");
      setSetup(null);
      setCode("");
      await refresh();
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
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="card stack" id="security">
      <div className="row between">
        <h2>Two-factor authentication</h2>
        <span className={`pill ${user?.totpEnabled ? "good" : "warn"}`}>{user?.totpEnabled ? "On" : "Off"}</span>
      </div>
      <p className="muted small">Require a code from an authenticator app (Google Authenticator, 1Password, Authy…) when you sign in. Strongly recommended for accounts that hold money.</p>
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
        <form className="row wrap" onSubmit={disable} style={{ alignItems: "flex-end" }}>
          <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Field label="Current code"><input className="input num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required /></Field>
          <button className="btn secondary">Turn off</button>
        </form>
      )}
      <ErrorText error={error} />
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
