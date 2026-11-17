import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { api, downloadFile } from "../api";
import { Delta, Empty, ErrorText, Field, Modal } from "../components/ui";
import { money, price, qty as fmtQty, timeAgo, usd } from "../format";
import { MARKET_LABEL } from "../markets";
import { useAuth, useLoad, useToast } from "../state";
import type { AssetClass } from "../types";

type Tab = "books" | "journals" | "snapshots" | "safeguarding" | "trading";

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
  const [params, setParams] = useSearchParams();
  const tab = (["books", "journals", "snapshots", "safeguarding", "trading"].includes(params.get("tab") ?? "") ? params.get("tab") : "books") as Tab;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  if (user && user.role !== "admin") return <Navigate to="/app" replace />;
  const tabs: [Tab, string][] = [
    ["books", "Trial balance"],
    ["journals", "Journals"],
    ["snapshots", "Daily snapshots"],
    ["safeguarding", "Safeguarding"],
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
      {tab === "safeguarding" && <Safeguarding />}
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

interface SafeguardingData {
  position: { currency: string; owed: string; wallets: string; inFlight: string; held: string; difference: string; accounts: number; staleAccounts: number; status: "covered" | "shortfall" | "unverified" }[];
  accounts: {
    id: string;
    name: string;
    kind: string;
    institution: string;
    currency: string;
    purpose: "safeguarding" | "operating";
    source: string;
    active: boolean;
    hasDetails: boolean;
    balance: string | null;
    balanceAsOf: string | null;
    balanceSource: string | null;
    stale: boolean;
  }[];
  reconciliations: { id: string; runAt: string; runBy: string; currency: string; owed: string; held: string; difference: string; status: string; staleAccounts: number }[];
  income: { from: "fees" | "fx"; currency: string; amount: string }[];
  assets: {
    wallets: { currency: string; total: string; holders: number; custodian: string }[];
    brokerageAccounts: { connected: number; custodian: string };
    linkedAccounts: { connections: number; customers: number; custodian: string };
    demo: { accounts: number; virtualCash: string; custodian: string };
  };
  staleAfterHours: number;
}

const STATUS_TEXT = { covered: "✓ Covered", shortfall: "✗ Shortfall", unverified: "Not verified" } as const;
const KIND_LABEL: Record<string, string> = { bank: "Bank", mobile_money: "Mobile money", payment_provider: "Payment provider", custodian: "Custodian", other: "Other" };
const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Where customers' money actually is, and whether it covers what Aurex owes them. */
function Safeguarding() {
  const toast = useToast();
  const data = useLoad(() => api.get<SafeguardingData>("/api/admin/safeguarding"));
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const d = data.data;
  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast(ok);
      data.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  async function showDetails(id: string) {
    try {
      const r = await api.get<{ details: string | null }>(`/api/admin/safeguarding/accounts/${id}/details`);
      alert(r.details ?? "No details saved for this account.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Is customers' money all there?</h2>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn secondary sm" onClick={() => act(() => api.post("/api/admin/safeguarding/refresh"), "Provider balances fetched")}>Fetch provider balances</button>
            <button className="btn sm" onClick={() => act(() => api.post("/api/admin/safeguarding/reconcile"), "Reconciled")}>Reconcile now</button>
          </div>
        </div>
        <ErrorText error={data.error} />
        <p className="muted small" style={{ marginTop: 0 }}>
          Owed is every customer wallet plus withdrawals not yet paid out. Held is the latest balance of each safeguarding account. Balances older than {d?.staleAfterHours ?? 48} hours don't count as verified.
          Reconciliation runs every 6 hours and alerts every admin to a shortfall.
        </p>
        {d && d.position.length === 0 ? (
          <Empty>Nothing owed to customers yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Currency</th><th className="r">Owed</th><th className="r hide-sm">In flight</th><th className="r">Held</th><th className="r">Difference</th><th>Status</th></tr></thead>
              <tbody>
                {(d?.position ?? []).map((p) => (
                  <tr key={p.currency}>
                    <td><strong>{p.currency}</strong></td>
                    <td className="r num">{money(p.owed, p.currency)}</td>
                    <td className="r num hide-sm">{money(p.inFlight, p.currency)}</td>
                    <td className="r num">{money(p.held, p.currency)}</td>
                    <td className={`r num ${p.difference.startsWith("-") ? "bad" : ""}`}>{money(p.difference, p.currency)}</td>
                    <td>
                      <span className={`pill ${p.status === "covered" ? "good" : p.status === "shortfall" ? "bad" : "warn"}`}>{STATUS_TEXT[p.status]}</span>
                      {p.accounts === 0 ? <div className="faint xs">No safeguarding account for {p.currency}</div> : p.staleAccounts > 0 ? <div className="faint xs">{p.staleAccounts} balance{p.staleAccounts === 1 ? "" : "s"} out of date</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Where the money is held</h2>
          <button className="btn secondary sm" onClick={() => setAdding(true)}>Add account</button>
        </div>
        {d && d.accounts.length === 0 && <Empty>Add the bank, mobile-money and provider accounts that hold customers' money, then record their balances from statements.</Empty>}
        <div className="stack">
          {(d?.accounts ?? []).map((a) => (
            <div key={a.id} style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, opacity: a.active ? 1 : 0.6 }}>
              <div className="row between wrap" style={{ gap: 8 }}>
                <div>
                  <strong>{a.name}</strong> <span className="faint small">{a.institution} · {KIND_LABEL[a.kind] ?? a.kind} · {a.currency}</span>{" "}
                  <span className={`pill ${a.purpose === "safeguarding" ? "brand" : ""}`}>{a.purpose}</span>{!a.active && <span className="pill">closed</span>}
                  <div className="small">
                    {a.balance === null ? (
                      <span className="faint">No balance recorded</span>
                    ) : (
                      <>
                        <strong className="num">{money(a.balance, a.currency)}</strong>{" "}
                        <span className={a.stale ? "bad xs" : "faint xs"}>
                          as of {new Date(a.balanceAsOf!).toLocaleString()} ({a.balanceSource === "api" ? `from ${a.source}` : "statement"}){a.stale ? " · out of date" : ""}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {a.active && <button className="btn secondary sm" onClick={() => setRecording(a.id)}>Record balance</button>}
                  {a.hasDetails && <button className="btn ghost sm" onClick={() => showDetails(a.id)}>Account details</button>}
                  <button className="btn ghost sm" onClick={() => act(() => api.patch(`/api/admin/safeguarding/accounts/${a.id}`, { active: !a.active }), a.active ? "Account closed" : "Account reopened")}>
                    {a.active ? "Close" : "Reopen"}
                  </button>
                </div>
              </div>
              {recording === a.id && <RecordBalance accountId={a.id} currency={a.currency} onDone={() => { setRecording(null); data.reload(); }} />}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <IncomeCard income={d?.income ?? []} onSwept={data.reload} />
        <div className="card">
          <div className="card-head"><h2>Who holds customers' assets</h2></div>
          {d && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Asset</th><th>Held by</th><th className="r">Amount</th></tr></thead>
                <tbody>
                  {d.assets.wallets.map((w) => (
                    <tr key={w.currency}><td>{w.currency} wallets <span className="faint xs">({w.holders} customers)</span></td><td className="small">{w.custodian}</td><td className="r num">{money(w.total, w.currency)}</td></tr>
                  ))}
                  <tr><td>Stocks and crypto (real accounts)</td><td className="small">{d.assets.brokerageAccounts.custodian}</td><td className="r num">{d.assets.brokerageAccounts.connected} accounts</td></tr>
                  <tr><td>Linked outside accounts</td><td className="small">{d.assets.linkedAccounts.custodian}</td><td className="r num">{d.assets.linkedAccounts.connections}</td></tr>
                  <tr><td>Demo trading accounts</td><td className="small">{d.assets.demo.custodian}</td><td className="r num faint">{usd(Number(d.assets.demo.virtualCash))} virtual</td></tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="faint xs" style={{ marginBottom: 0 }}>Aurex holds only wallet money. Securities stay with the customer's own broker, and linked accounts are read-only.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Reconciliation history</h2></div>
        {d && d.reconciliations.length === 0 ? (
          <Empty>No reconciliations yet. Add accounts and balances, then reconcile.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Currency</th><th className="r">Owed</th><th className="r">Held</th><th className="r">Difference</th><th>Result</th><th className="hide-sm">By</th></tr></thead>
              <tbody>
                {(d?.reconciliations ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap small">{new Date(r.runAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{r.currency}</td>
                    <td className="r num">{money(r.owed, r.currency)}</td>
                    <td className="r num">{money(r.held, r.currency)}</td>
                    <td className={`r num ${r.difference.startsWith("-") ? "bad" : ""}`}>{money(r.difference, r.currency)}</td>
                    <td><span className={`pill ${r.status === "covered" ? "good" : r.status === "shortfall" ? "bad" : "warn"}`}>{STATUS_TEXT[r.status as keyof typeof STATUS_TEXT] ?? r.status}</span></td>
                    <td className="hide-sm small">{r.runBy === "scheduled" ? <span className="faint">scheduled</span> : `@${r.runBy}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && <AddAccount onClose={() => setAdding(false)} onAdded={() => { setAdding(false); data.reload(); }} />}
    </>
  );
}

function RecordBalance({ accountId, currency, onDone }: { accountId: string; currency: string; onDone: () => void }) {
  const toast = useToast();
  const [balance, setBalance] = useState("");
  const [asOf, setAsOf] = useState(nowLocal());
  const [note, setNote] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/admin/safeguarding/accounts/${accountId}/balances`, { balance: balance.replace(/,/g, ""), asOf: new Date(asOf).toISOString(), note: note || undefined });
      toast("Balance recorded");
      onDone();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <form className="row wrap" style={{ gap: 8, alignItems: "flex-end", marginTop: 10 }} onSubmit={save}>
      <Field label={`Balance (${currency})`}><input className="input" inputMode="decimal" required value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" style={{ width: 150 }} /></Field>
      <Field label="As of"><input className="input" type="datetime-local" required value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. statement 0423" /></Field>
      <button className="btn sm" style={{ marginBottom: 4 }}>Save</button>
    </form>
  );
}

function AddAccount({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", kind: "bank", institution: "", currency: "USD", purpose: "safeguarding", source: "manual", details: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/admin/safeguarding/accounts", { ...f, currency: f.currency.toUpperCase(), details: f.details || undefined });
      toast("Account added");
      onAdded();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <Modal title="Add an account that holds money" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name"><input className="input" required value={f.name} onChange={set("name")} placeholder="e.g. Safeguarding KES" /></Field>
        <Field label="Institution"><input className="input" required value={f.institution} onChange={set("institution")} placeholder="e.g. Equity Bank, Safaricom, Stripe" /></Field>
        <div className="grid grid-2">
          <Field label="Kind">
            <select className="input" value={f.kind} onChange={set("kind")}>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Currency"><input className="input" required maxLength={3} value={f.currency} onChange={set("currency")} /></Field>
          <Field label="Purpose">
            <select className="input" value={f.purpose} onChange={set("purpose")}>
              <option value="safeguarding">Safeguarding (customers' money)</option>
              <option value="operating">Operating (the business's own)</option>
            </select>
          </Field>
          <Field label="Balance from">
            <select className="input" value={f.source} onChange={set("source")}>
              <option value="manual">Statements (typed in)</option>
              <option value="stripe">Stripe API</option>
              <option value="wise">Wise API</option>
              <option value="flutterwave">Flutterwave API</option>
            </select>
          </Field>
        </div>
        <Field label="Account number, IBAN or paybill (optional)" hint="Stored encrypted; viewing it is recorded in the audit log.">
          <input className="input" value={f.details} onChange={set("details")} autoComplete="off" />
        </Field>
        <button className="btn block">Add account</button>
      </form>
    </Modal>
  );
}

function IncomeCard({ income, onSwept }: { income: { from: "fees" | "fx"; currency: string; amount: string }[]; onSwept: () => void }) {
  const toast = useToast();
  const [sel, setSel] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const pick = income.find((i) => `${i.from}:${i.currency}` === sel) ?? income[0];
  async function sweep(e: React.FormEvent) {
    e.preventDefault();
    if (!pick) return;
    try {
      await api.post("/api/admin/safeguarding/sweep", { from: pick.from, currency: pick.currency, amount: amount.replace(/,/g, ""), note });
      toast(`Recorded ${money(amount, pick.currency)} moved to the operating account`);
      setAmount("");
      setNote("");
      onSwept();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Income to move out</h2></div>
      <p className="muted small" style={{ marginTop: 0 }}>Fees and FX income are the business's money, not customers'. After moving them from the safeguarding account to the operating account at the bank, record it here so the books match.</p>
      {income.length === 0 ? (
        <Empty>No unswept income.</Empty>
      ) : (
        <>
          <div className="stack-sm" style={{ marginBottom: 10 }}>
            {income.map((i) => (
              <div key={i.from + i.currency} className="row between small"><span className="muted">{i.from === "fees" ? "Fees" : "FX"} · {i.currency}</span><strong className="num">{money(i.amount, i.currency)}</strong></div>
            ))}
          </div>
          <form className="row wrap" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={sweep}>
            <Field label="From">
              <select className="input" value={pick ? `${pick.from}:${pick.currency}` : ""} onChange={(e) => setSel(e.target.value)}>
                {income.map((i) => <option key={i.from + i.currency} value={`${i.from}:${i.currency}`}>{i.from === "fees" ? "Fees" : "FX"} {i.currency}</option>)}
              </select>
            </Field>
            <Field label="Amount"><input className="input" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} /></Field>
            <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bank ref 8812" /></Field>
            <button className="btn secondary sm" style={{ marginBottom: 4 }}>Record</button>
          </form>
        </>
      )}
    </div>
  );
}
