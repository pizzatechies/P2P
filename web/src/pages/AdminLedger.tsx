import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, downloadFile } from "../api";
import { Delta, Empty, ErrorText, Field, Modal } from "../components/ui";
import { money, price, qty as fmtQty, timeAgo, usd } from "../format";
import { MARKET_LABEL } from "../markets";
import { useAuth, useLoad, useToast } from "../state";
import type { AssetClass } from "../types";

type Tab = "books" | "journals" | "snapshots" | "trading";

interface TrialRow {
  currency: string;
  customerFunds: string;
  customersWithBalance: number;
  external: string;
  clearing: string;
  fees: string;
  fx: string;
  total: string;
  balanced: boolean;
}

interface JournalSummary {
  id: string;
  kind: string;
  memo: string | null;
  createdAt: string;
  amounts: { currency: string; amount: string }[];
  customers: { id: string; handle: string }[];
}

interface JournalDetail {
  id: string;
  kind: string;
  memo: string | null;
  createdAt: string;
  initiator: { id: string; handle: string } | null;
  metadata: Record<string, unknown>;
  balanced: boolean;
  entries: {
    id: number;
    account: { kind: string; userId: string | null; handle: string | null; name: string | null; accountNumber: string | null };
    currency: string;
    amount: string;
    balanceAfter: string;
    createdAt: string;
  }[];
  externalTransfer: { id: string; direction: string; rail: string; status: string; providerRef: string | null; userId: string } | null;
  paymentRequest: { id: string; status: string } | null;
}

interface Snapshot {
  day: string;
  currency: string;
  customerFunds: string;
  external: string;
  clearing: string;
  fees: string;
  fx: string;
  journals: number;
  volume: string;
  balanced: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const GROUP_LABEL: Record<string, string> = { customer: "Customer", external: "External", clearing: "Clearing", fees: "Fees", fx: "FX" };

/** The books: trial balance, journal explorer, end-of-day snapshots, exports and trading activity. */
export function AdminLedgerPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("books");
  if (user && user.role !== "admin") return <Navigate to="/app" replace />;
  const tabs: [Tab, string][] = [
    ["books", "Trial balance"],
    ["journals", "Journals"],
    ["snapshots", "Daily snapshots"],
    ["trading", "Trading"],
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/app/admin" className="small">← Admin</Link>
          <h1>Ledger &amp; records</h1>
          <p className="muted">The books, every journal, end-of-day totals and trading across the platform. Everything here is built from the immutable ledger.</p>
        </div>
      </div>
      <div className="seg" role="tablist" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "books" && <Books />}
      {tab === "journals" && <Journals />}
      {tab === "snapshots" && <Snapshots />}
      {tab === "trading" && <Trading />}
    </>
  );
}

function Books() {
  const toast = useToast();
  const [asOf, setAsOf] = useState("");
  const tb = useLoad(
    () => api.get<{ trialBalance: { asOf: string | null; balanced: boolean; generatedAt: string; rows: TrialRow[] } }>(`/api/admin/ledger/trial-balance${asOf ? `?asOf=${asOf}` : ""}`).then((r) => r.trialBalance),
    [asOf],
  );
  const [range, setRange] = useState({ from: today().slice(0, 8) + "01", to: today(), kind: "" });
  const [busy, setBusy] = useState(false);
  async function exportEntries() {
    setBusy(true);
    try {
      await downloadFile(`/api/admin/ledger/export?from=${range.from}&to=${range.to}${range.kind ? `&kind=${encodeURIComponent(range.kind)}` : ""}`, `aurex-ledger-${range.from}-to-${range.to}.csv`);
      toast("Ledger exported");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const t = tb.data;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Trial balance</h2>
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input" type="date" aria-label="As of the end of" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} style={{ height: 34, width: "auto" }} />
            {asOf && <button className="btn ghost sm" onClick={() => setAsOf("")}>Now</button>}
            <button className="btn secondary sm" onClick={() => downloadFile(`/api/admin/ledger/trial-balance?format=csv${asOf ? `&asOf=${asOf}` : ""}`, "aurex-trial-balance.csv").catch((e) => toast((e as Error).message, "error"))}>
              Download CSV
            </button>
          </div>
        </div>
        <ErrorText error={tb.error} />
        {t && (
          <>
            <p className={`small ${t.balanced ? "good" : "bad"}`} style={{ marginTop: 0 }}>
              {t.balanced ? "✓ Balanced" : "✗ Out of balance"}: every currency must sum to zero across all accounts.{" "}
              <span className="faint">{t.asOf ? `At the end of ${t.asOf} (UTC).` : `As of ${new Date(t.generatedAt).toLocaleString()}.`}</span>
            </p>
            {t.rows.length === 0 ? (
              <Empty>No money has moved yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Currency</th>
                      <th className="r">Customer funds</th>
                      <th className="r hide-sm">Holders</th>
                      <th className="r">External</th>
                      <th className="r hide-sm">Clearing</th>
                      <th className="r hide-sm">Fees</th>
                      <th className="r hide-sm">FX</th>
                      <th className="r">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r) => (
                      <tr key={r.currency}>
                        <td><strong>{r.currency}</strong></td>
                        <td className="r num">{money(r.customerFunds, r.currency)}</td>
                        <td className="r num hide-sm">{r.customersWithBalance}</td>
                        <td className="r num">{money(r.external, r.currency)}</td>
                        <td className="r num hide-sm">{money(r.clearing, r.currency)}</td>
                        <td className="r num hide-sm">{money(r.fees, r.currency)}</td>
                        <td className="r num hide-sm">{money(r.fx, r.currency)}</td>
                        <td className={`r num ${r.balanced ? "" : "bad"}`}>{r.balanced ? "0 ✓" : money(r.total, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="faint xs" style={{ marginBottom: 0 }}>
              Customer funds is what Aurex owes its customers. External is money that came in or went out through payment rails (negative when more came in);
              clearing holds withdrawals in flight; fees and FX are Aurex's income.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Export ledger entries</h2></div>
        <p className="muted small" style={{ marginTop: 0 }}>Every entry in a date range as CSV (debit and credit columns), for accounting software. Up to a year at a time. Exports are recorded in the audit log.</p>
        <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
          <Field label="From"><input className="input" type="date" value={range.from} max={today()} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><input className="input" type="date" value={range.to} max={today()} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Field label="Kind (optional)"><input className="input" style={{ width: 160 }} placeholder="Any" value={range.kind} onChange={(e) => setRange({ ...range, kind: e.target.value.trim() })} /></Field>
          <button className="btn" style={{ marginBottom: 2 }} disabled={busy || !range.from || !range.to} onClick={exportEntries}>{busy ? "Preparing…" : "Download CSV"}</button>
        </div>
      </div>
    </>
  );
}

function Journals() {
  const [f, setF] = useState({ q: "", kind: "", currency: "", from: "", to: "" });
  const [applied, setApplied] = useState(f);
  const [more, setMore] = useState<JournalSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const list = useLoad(async () => {
    const r = await api.get<{ journals: JournalSummary[]; kinds: string[]; nextBefore: string | null }>(`/api/admin/ledger/journals?${qs}`);
    setMore([]);
    setCursor(r.nextBefore);
    return r;
  }, [qs]);
  async function loadMore() {
    if (!cursor) return;
    const r = await api.get<{ journals: JournalSummary[]; nextBefore: string | null }>(`/api/admin/ledger/journals?${qs}${qs ? "&" : ""}before=${encodeURIComponent(cursor)}`);
    setMore((m) => [...m, ...r.journals]);
    setCursor(r.nextBefore);
  }
  const rows = [...(list.data?.journals ?? []), ...more];
  return (
    <div className="card">
      <form
        className="row wrap"
        style={{ gap: 8, alignItems: "flex-end", marginBottom: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(f);
        }}
      >
        <Field label="Journal, transfer or provider reference"><input className="input" style={{ width: 260 }} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        <Field label="Kind">
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="">All</option>
            {(list.data?.kinds ?? []).map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <Field label="Currency"><input className="input" style={{ width: 80 }} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <button className="btn secondary" style={{ marginBottom: 2 }}>Search</button>
      </form>
      <ErrorText error={list.error} />
      {list.data && rows.length === 0 ? (
        <Empty>No journals match.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Kind</th><th className="hide-sm">Memo</th><th>Customers</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} onClick={() => setOpen(j.id)} style={{ cursor: "pointer" }}>
                  <td className="nowrap small">{new Date(j.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}<div className="faint xs mono">{j.id}</div></td>
                  <td>{j.kind.replace(/_/g, " ")}</td>
                  <td className="hide-sm muted small">{j.memo ?? ""}</td>
                  <td className="small">{j.customers.map((c) => `@${c.handle}`).join(", ") || <span className="faint">—</span>}</td>
                  <td className="r num">{j.amounts.map((a) => money(a.amount, a.currency)).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={loadMore}>Load more</button>}
      {open && <JournalModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function JournalModal({ id, onClose }: { id: string; onClose: () => void }) {
  const j = useLoad(() => api.get<{ journal: JournalDetail }>(`/api/admin/ledger/journals/${encodeURIComponent(id)}`).then((r) => r.journal), [id]);
  const d = j.data;
  return (
    <Modal title="Journal" onClose={onClose} wide>
      <ErrorText error={j.error} />
      {!d ? (
        !j.error && <div className="skeleton" style={{ height: 200 }} />
      ) : (
        <div className="stack">
          <div className="kv">
            <div><span>Reference</span><strong className="mono small">{d.id}</strong></div>
            <div><span>Kind</span><strong>{d.kind.replace(/_/g, " ")}</strong></div>
            <div><span>When</span><strong>{new Date(d.createdAt).toLocaleString()}</strong></div>
            <div><span>Started by</span><strong>{d.initiator ? <Link to={`/app/admin/users/${d.initiator.id}`} onClick={onClose}>@{d.initiator.handle}</Link> : "System"}</strong></div>
            {d.memo && <div style={{ gridColumn: "1 / -1" }}><span>Memo</span><strong>{d.memo}</strong></div>}
          </div>
          <p className={`small ${d.balanced ? "good" : "bad"}`} style={{ margin: 0 }}>{d.balanced ? "✓ Entries balance (each currency sums to zero)" : "✗ Entries don't balance"}</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Account</th><th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance after</th></tr></thead>
              <tbody>
                {d.entries.map((e) => {
                  const neg = e.amount.startsWith("-");
                  return (
                    <tr key={e.id}>
                      <td>
                        {e.account.kind === "customer" ? (
                          <>
                            <Link to={`/app/admin/users/${e.account.userId}`} onClick={onClose}>@{e.account.handle}</Link> <span className="faint xs">{e.account.accountNumber}</span>
                          </>
                        ) : (
                          <span>{GROUP_LABEL[e.account.kind] ?? e.account.kind} <span className="faint xs">system</span></span>
                        )}
                      </td>
                      <td className="r num">{neg ? money(e.amount.slice(1), e.currency) : ""}</td>
                      <td className="r num">{neg ? "" : money(e.amount, e.currency)}</td>
                      <td className="r num faint">{money(e.balanceAfter, e.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.externalTransfer && (
            <div className="small">
              {d.externalTransfer.direction === "deposit" ? "Deposit" : "Withdrawal"} via <strong>{d.externalTransfer.rail}</strong> · {d.externalTransfer.status}
              {d.externalTransfer.providerRef && <> · provider ref <span className="mono">{d.externalTransfer.providerRef}</span></>} · <span className="mono faint">{d.externalTransfer.id}</span>
            </div>
          )}
          {d.paymentRequest && <div className="small">Pays request <span className="mono">{d.paymentRequest.id}</span> ({d.paymentRequest.status})</div>}
        </div>
      )}
    </Modal>
  );
}

function Snapshots() {
  const [currency, setCurrency] = useState("");
  const data = useLoad(
    () =>
      api.get<{ snapshots: Snapshot[]; verification: { checked: number; ok: boolean; mismatches: { day: string; currency: string; group: string; stored: string; recomputed: string }[] } }>(
        `/api/admin/ledger/snapshots?days=90${currency ? `&currency=${currency}` : ""}`,
      ),
    [currency],
  );
  const v = data.data?.verification;
  return (
    <div className="card">
      <div className="card-head">
        <h2>End-of-day totals</h2>
        <input className="input" aria-label="Currency" placeholder="All currencies" maxLength={3} style={{ height: 34, width: 140 }} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().length === 3 || !e.target.value ? e.target.value.toUpperCase() : currency)} />
      </div>
      <ErrorText error={data.error} />
      {v && (
        <p className={`small ${v.ok ? "good" : "bad"}`} style={{ marginTop: 0 }}>
          {v.ok
            ? `✓ ${v.checked} stored day${v.checked === 1 ? "" : "s"} recomputed from the entries and unchanged.`
            : `✗ ${v.mismatches.length} figure${v.mismatches.length === 1 ? "" : "s"} no longer match the entries: the ledger or a snapshot was changed after the day closed.`}
        </p>
      )}
      {v && !v.ok && (
        <ul className="small bad">
          {v.mismatches.slice(0, 10).map((m) => (
            <li key={`${m.day}${m.currency}${m.group}`}>{m.day} {m.currency} {GROUP_LABEL[m.group] ?? m.group}: stored {m.stored}, entries say {m.recomputed}</li>
          ))}
        </ul>
      )}
      {data.data && data.data.snapshots.length === 0 ? (
        <Empty>Snapshots are written after each day ends (UTC). The first appears tomorrow.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Day</th><th>Currency</th><th className="r">Customer funds</th><th className="r hide-sm">Clearing</th><th className="r hide-sm">Fees</th><th className="r">Moved that day</th><th className="r hide-sm">Journals</th><th /></tr>
            </thead>
            <tbody>
              {(data.data?.snapshots ?? []).map((s) => (
                <tr key={s.day + s.currency}>
                  <td className="nowrap">{s.day}</td>
                  <td>{s.currency}</td>
                  <td className="r num">{money(s.customerFunds, s.currency)}</td>
                  <td className="r num hide-sm">{money(s.clearing, s.currency)}</td>
                  <td className="r num hide-sm">{money(s.fees, s.currency)}</td>
                  <td className="r num">{money(s.volume, s.currency)}</td>
                  <td className="r num hide-sm">{s.journals}</td>
                  <td className={s.balanced ? "good" : "bad"}>{s.balanced ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface TradingActivity {
  days: number;
  byAssetClass: { assetClass: AssetClass; accountType: "demo" | "real"; trades: number; volume: number; traders: number; realizedPl: number | null }[];
  topSymbols: { symbol: string; trades: number; volume: number }[];
  recent: { id: string; executedAt: string; userId: string; handle: string; symbol: string; assetClass: AssetClass; side: string; qty: number; price: number; notional: number; accountType: string; realizedPl: number | null; placedBy: string }[];
  integrity: { ok: boolean; cashMismatches: { userId: string; cash: number; journal: number }[]; missingFills: number };
}

function Trading() {
  const [days, setDays] = useState(30);
  const data = useLoad(() => api.get<TradingActivity>(`/api/admin/trading?days=${days}`), [days]);
  const d = data.data;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Trading activity</h2>
          <select className="input" aria-label="Period" style={{ height: 34, width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
        <ErrorText error={data.error} />
        {d && (
          <>
            <p className={`small ${d.integrity.ok ? "good" : "bad"}`} style={{ marginTop: 0 }}>
              {d.integrity.ok
                ? "✓ Trading records check out: every demo cash journal adds up to its cash, and every filled order has a trade record."
                : `✗ ${d.integrity.cashMismatches.length} cash journal mismatch(es), ${d.integrity.missingFills} filled order(s) without a trade record.`}
            </p>
            {d.byAssetClass.length === 0 ? (
              <Empty>No trades in this period.</Empty>
            ) : (
              <div className="grid grid-2">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Market</th><th>Account</th><th className="r">Trades</th><th className="r">Traders</th><th className="r">Volume</th><th className="r">Realised</th></tr></thead>
                    <tbody>
                      {d.byAssetClass.map((r) => (
                        <tr key={r.assetClass + r.accountType}>
                          <td>{MARKET_LABEL[r.assetClass]}</td>
                          <td>{r.accountType}</td>
                          <td className="r num">{r.trades}</td>
                          <td className="r num">{r.traders}</td>
                          <td className="r num">{usd(r.volume)}</td>
                          <td className="r num">{r.realizedPl === null ? "—" : <Delta value={r.realizedPl}>{usd(r.realizedPl, true)}</Delta>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Most traded</th><th className="r">Trades</th><th className="r">Volume</th></tr></thead>
                    <tbody>
                      {d.topSymbols.map((s) => (
                        <tr key={s.symbol}><td><strong>{s.symbol}</strong></td><td className="r num">{s.trades}</td><td className="r num">{usd(s.volume)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h2>Latest trades</h2></div>
        {d && d.recent.length === 0 ? (
          <Empty>No trades yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Customer</th><th>Trade</th><th className="r">Price</th><th className="r hide-sm">Value</th><th className="r">Realised</th></tr></thead>
              <tbody>
                {(d?.recent ?? []).map((f) => (
                  <tr key={f.id}>
                    <td className="nowrap small">{timeAgo(f.executedAt)}</td>
                    <td><Link to={`/app/admin/users/${f.userId}`}>@{f.handle}</Link> <span className="faint xs">{f.accountType}</span></td>
                    <td><span className={f.side === "buy" ? "good" : "bad"}>{f.side}</span> {fmtQty(f.qty)} <strong>{f.symbol}</strong>{f.placedBy !== "user" && <span className="faint xs"> · {f.placedBy}</span>}</td>
                    <td className="r num">{price(f.price)}</td>
                    <td className="r num hide-sm">{usd(f.notional)}</td>
                    <td className="r num">{f.realizedPl === null ? "—" : <Delta value={f.realizedPl}>{usd(f.realizedPl, true)}</Delta>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
