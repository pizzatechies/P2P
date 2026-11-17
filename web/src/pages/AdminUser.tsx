import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorText, Field } from "../components/ui";
import { money, timeAgo, usd } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import { KycSubmissionCard, type KycSubmission } from "./Admin";

interface Detail {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    handle: string;
    displayName: string;
    role: string;
    status: string;
    closedAt: string | null;
    accountNumber: string | null;
    kycLevel: number;
    twoFactor: boolean;
    createdAt: string;
    lockedUntil: string | null;
    securityHoldUntil: string | null;
  };
  limits: { level: number; tiered: boolean; txUsd: number; dailyUsd: number; overridden: boolean; overrideTxUsd: number | null; overrideDailyUsd: number | null };
  verification: KycSubmission[];
  balances: { currency: string; balance: string }[];
  activity: { date: string; kind: string; description: string | null; currency: string; amount: string; reference: string }[];
  transfers: { id: string; direction: string; rail: string; currency: string; amount: number; status: string; failureReason: string | null; createdAt: string }[];
  trading: { account: { broker: string; cash: number; startingCash: number } | null; positions: { symbol: string; qty: number; avgCost: number }[]; orders: number; realApplication: { status: string } | null; fills?: { id: string; executedAt: string; symbol: string; side: string; qty: number; price: number; notional: number; accountType: string; realizedPl: number | null }[] };
  sessions: { createdAt: string; expiresAt: string; ip: string | null; userAgent: string | null }[];
  events: { action: string; ip: string | null; details: string; createdAt: string }[];
  notes: { id: number; note: string; createdAt: string; author: string | null }[];
}

const LEVELS = ["Basic", "Verified identity", "Enhanced"];

/** Everything about one customer, with the actions support and compliance need. Viewing is audited. */
export function AdminUserPage() {
  const { user: me } = useAuth();
  const { id = "" } = useParams();
  const toast = useToast();
  const d = useLoad(() => api.get<Detail>(`/api/admin/users/${encodeURIComponent(id)}`), [id]);
  if (me?.role !== "admin") return <Navigate to="/app" replace />;
  const u = d.data?.user;
  const self = u?.id === me.id;

  async function act(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast(label);
      d.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/app/admin" className="small">← Admin</Link>
          <h1>{u ? u.displayName : "Customer"}</h1>
          {u && (
            <p className="muted row wrap" style={{ gap: 6, marginTop: 6 }}>
              @{u.handle} · {u.email} · account {u.accountNumber ?? "—"}
              <span className={`pill ${u.status === "active" ? "good" : "bad"}`}>{u.status}</span>
              <span className={`pill ${u.kycLevel >= 1 ? "good" : "warn"}`}>{LEVELS[u.kycLevel]}</span>
              {u.role === "admin" && <span className="pill brand">admin</span>}
            </p>
          )}
        </div>
        {u && !self && (
          <div className="row" style={{ gap: 6 }}>
            {u.status === "active" ? (
              <button className="btn danger sm" onClick={() => confirm(`Freeze @${u.handle}? They're signed out and can't move money.`) && act("Account frozen", () => api.post(`/api/admin/users/${u.id}/status`, { status: "frozen" }))}>
                Freeze
              </button>
            ) : (
              <button className="btn sm" onClick={() => act(u.status === "closed" ? "Account reopened" : "Account unfrozen", () => api.post(`/api/admin/users/${u.id}/status`, { status: "active" }))}>
                {u.status === "closed" ? "Reopen" : "Unfreeze"}
              </button>
            )}
          </div>
        )}
      </div>
      <ErrorText error={d.error} />
      {!d.data ? (
        !d.error && <div className="skeleton" style={{ height: 400 }} />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-3">
            <div className="card">
              <div className="card-head"><h2>Profile</h2></div>
              <div className="kv">
                <div><span>Joined</span><strong>{new Date(u!.createdAt).toLocaleDateString()}</strong></div>
                <div><span>Email</span><strong>{u!.emailVerified ? "verified" : "unverified"}</strong></div>
                <div><span>2FA</span><strong>{u!.twoFactor ? "on" : "off"}</strong></div>
                <div><span>Locked until</span><strong>{u!.lockedUntil ? new Date(u!.lockedUntil).toLocaleString() : "—"}</strong></div>
                <div><span>Security hold</span><strong>{u!.securityHoldUntil && Date.parse(u!.securityHoldUntil) > Date.now() ? new Date(u!.securityHoldUntil).toLocaleString() : "—"}</strong></div>
                <div><span>Closed</span><strong>{u!.closedAt ? new Date(u!.closedAt).toLocaleDateString() : "—"}</strong></div>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Balances</h2></div>
              {d.data.balances.length === 0 && <Empty>No wallets yet.</Empty>}
              {d.data.balances.map((b) => (
                <div key={b.currency} className="row between"><span className="muted">{b.currency}</span><strong className="num">{money(b.balance, b.currency)}</strong></div>
              ))}
            </div>
            <LimitsAdmin d={d.data} disabled={self} onSaved={() => d.reload()} />
          </div>

          <div className="card">
            <div className="card-head"><h2>Identity verification</h2><span className="faint small">Level {u!.kycLevel}: {LEVELS[u!.kycLevel]}</span></div>
            {d.data.verification.length === 0 && <p className="muted small">Nothing submitted yet.</p>}
            <div className="stack">
              {d.data.verification.map((s) => (
                <KycSubmissionCard key={s.id} s={s} onReviewed={() => d.reload()} />
              ))}
            </div>
            {!self && <SetLevel userId={u!.id} current={u!.kycLevel} onSaved={() => d.reload()} />}
          </div>

          <div className="grid grid-2">
            <div className="card flush">
              <div className="card-head"><h2>Recent activity</h2></div>
              <div className="table-wrap" style={{ padding: "0 8px 8px", maxHeight: 360, overflowY: "auto" }}>
                {d.data.activity.length === 0 ? <Empty>No transactions.</Empty> : (
                  <table className="table">
                    <tbody>
                      {d.data.activity.map((a, i) => (
                        <tr key={a.reference + i}>
                          <td className="faint xs nowrap">{timeAgo(a.date)}</td>
                          <td className="small">{a.description ?? a.kind}<div className="faint xs mono">{a.reference}</div></td>
                          <td className={`r num ${Number(a.amount) > 0 ? "good" : ""}`}>{money(a.amount, a.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="card flush">
              <div className="card-head"><h2>Deposits and withdrawals</h2></div>
              <div className="table-wrap" style={{ padding: "0 8px 8px", maxHeight: 360, overflowY: "auto" }}>
                {d.data.transfers.length === 0 ? <Empty>None.</Empty> : (
                  <table className="table">
                    <tbody>
                      {d.data.transfers.map((t) => (
                        <tr key={t.id}>
                          <td className="faint xs nowrap">{timeAgo(t.createdAt)}</td>
                          <td className="small">{t.direction === "deposit" ? "Deposit" : "Withdrawal"} · {t.rail}{t.failureReason && <div className="error-text xs">{t.failureReason}</div>}</td>
                          <td className="small">{t.status}</td>
                          <td className="r num">{t.currency} {(t.amount / 100).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h2>Trading</h2></div>
              {d.data.trading.account ? (
                <div className="kv">
                  <div><span>Account</span><strong>{d.data.trading.account.broker === "paper" ? "Demo" : "Alpaca"}</strong></div>
                  <div><span>Demo cash</span><strong>{usd(d.data.trading.account.cash)}</strong></div>
                  <div><span>Positions</span><strong>{d.data.trading.positions.length}</strong></div>
                  <div><span>Orders</span><strong>{d.data.trading.orders}</strong></div>
                  <div><span>Real-account application</span><strong>{d.data.trading.realApplication?.status ?? "—"}</strong></div>
                </div>
              ) : null}
              {d.data.trading.fills && d.data.trading.fills.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="table">
                    <thead><tr><th>Recent trades</th><th className="r">Value</th><th className="r">Realised</th></tr></thead>
                    <tbody>
                      {d.data.trading.fills.slice(0, 10).map((f) => (
                        <tr key={f.id}>
                          <td className="small">
                            <span className={f.side === "buy" ? "good" : "bad"}>{f.side}</span> {f.qty} <strong>{f.symbol}</strong> @ {f.price}
                            <div className="faint xs">{new Date(f.executedAt).toLocaleString()} · {f.accountType}</div>
                          </td>
                          <td className="r num">{usd(f.notional)}</td>
                          <td className="r num">{f.realizedPl === null ? "—" : usd(f.realizedPl, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!d.data.trading.account && (
                <Empty>Hasn't opened trading.</Empty>
              )}
            </div>
            <Notes d={d.data} onSaved={() => d.reload()} />
          </div>

          <div className="grid grid-2">
            <div className="card flush">
              <div className="card-head"><h2>Signed-in devices</h2></div>
              <div className="table-wrap" style={{ padding: "0 8px 8px" }}>
                {d.data.sessions.length === 0 ? <Empty>None.</Empty> : (
                  <table className="table">
                    <tbody>
                      {d.data.sessions.map((s, i) => (
                        <tr key={i}><td className="small">{s.userAgent ?? "Unknown device"}<div className="faint xs">{s.ip ?? ""} · since {timeAgo(s.createdAt)}</div></td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="card flush">
              <div className="card-head"><h2>Account events</h2></div>
              <div className="table-wrap" style={{ padding: "0 8px 8px", maxHeight: 320, overflowY: "auto" }}>
                <table className="table">
                  <tbody>
                    {d.data.events.map((e, i) => (
                      <tr key={i}><td className="small mono">{e.action}</td><td className="faint xs">{e.ip ?? ""}</td><td className="faint xs nowrap r">{timeAgo(e.createdAt)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LimitsAdmin({ d, disabled, onSaved }: { d: Detail; disabled: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [tx, setTx] = useState(d.limits.overrideTxUsd?.toString() ?? "");
  const [daily, setDaily] = useState(d.limits.overrideDailyUsd?.toString() ?? "");
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/admin/users/${d.user.id}/limits`, { txUsd: tx ? Number(tx) : null, dailyUsd: daily ? Number(daily) : null });
      toast("Limits saved");
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Limits</h2>{d.limits.overridden && <span className="pill">custom</span>}</div>
      <div className="small">{usd(d.limits.txUsd)} per payment · {usd(d.limits.dailyUsd)} per day</div>
      {!disabled && (
        <form className="stack" onSubmit={save} style={{ marginTop: 8 }}>
          <div className="grid grid-2">
            <Field label="Per payment (USD)"><input className="input num" inputMode="decimal" value={tx} placeholder="Level default" onChange={(e) => setTx(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
            <Field label="Per day (USD)"><input className="input num" inputMode="decimal" value={daily} placeholder="Level default" onChange={(e) => setDaily(e.target.value.replace(/[^\d.]/g, ""))} /></Field>
          </div>
          <button className="btn secondary sm">Save limits</button>
          <p className="faint xs" style={{ margin: 0 }}>Leave both empty to use the verification level's limits.</p>
        </form>
      )}
    </div>
  );
}

function SetLevel({ userId, current, onSaved }: { userId: string; current: number; onSaved: () => void }) {
  const toast = useToast();
  const [level, setLevel] = useState(String(current));
  const [note, setNote] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/admin/users/${userId}/kyc-level`, { level: Number(level), note });
      toast("Verification level set");
      setNote("");
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <form className="row wrap" onSubmit={save} style={{ alignItems: "flex-end", marginTop: 12 }}>
      <Field label="Set level manually">
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l, i) => <option key={l} value={i}>{i}: {l}</option>)}
        </select>
      </Field>
      <Field label="Reason (kept in the audit log)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} /></Field>
      <button className="btn secondary sm">Set level</button>
    </form>
  );
}

function Notes({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/admin/users/${d.user.id}/notes`, { note });
      setNote("");
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Internal notes</h2></div>
      <form className="row" onSubmit={add} style={{ marginBottom: 8 }}>
        <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (only admins see this)" required />
        <button className="btn sm">Add</button>
      </form>
      {d.notes.length === 0 && <p className="faint small">No notes.</p>}
      {d.notes.map((n) => (
        <div key={n.id} className="small" style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
          {n.note}
          <div className="faint xs">@{n.author ?? "admin"} · {timeAgo(n.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}
