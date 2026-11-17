import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { EquityChart, PnlBars } from "../components/charts";
import { Delta, Empty, ErrorText, Field } from "../components/ui";
import { pct, price, qty as fmtQty, timeAgo, usd } from "../format";
import { MARKET_LABEL } from "../markets";
import { useLoad } from "../state";
import type { AssetClass } from "../types";

type AccountType = "demo" | "real";

interface Fill {
  id: string;
  executedAt: string;
  broker: "paper" | "alpaca";
  accountType: AccountType;
  orderId: string | null;
  symbol: string;
  assetClass: AssetClass;
  side: "buy" | "sell";
  qty: number;
  price: number;
  multiplier: number;
  notional: number;
  fee: number;
  closedQty: number;
  costBasis: number | null;
  realizedPl: number | null;
  positionAfter: number | null;
  avgCostAfter: number | null;
  cashAfter: number | null;
  placedBy: string;
  source: string;
}

interface Performance {
  broker: "paper" | "alpaca";
  accountType: AccountType;
  since: string | null;
  series: { day: string; equity: number; cash: number; unrealizedPl: number }[];
  changePct: number | null;
  maxDrawdownPct: number | null;
  trades: number;
  closingTrades: number;
  winRatePct: number | null;
  realizedPl: number;
  averageWin: number | null;
  averageLoss: number | null;
  profitFactor: number | null;
  bestTrade: { symbol: string; realizedPl: number; at: string } | null;
  worstTrade: { symbol: string; realizedPl: number; at: string } | null;
  fees: number;
}

interface Realized {
  year: number;
  accountType: AccountType;
  method: string;
  realizedPl: number;
  closingTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  proceeds: number;
  costBasis: number;
  fees: number;
  trades: number;
  unknownTrades: number;
  months: { month: string; realizedPl: number; trades: number }[];
  bySymbol: { symbol: string; assetClass: AssetClass; trades: number; wins: number; losses: number; realizedPl: number; proceeds: number; costBasis: number }[];
  byAssetClass: { assetClass: AssetClass; trades: number; realizedPl: number }[];
}

const signedUsd = (n: number) => <Delta value={n}>{usd(n, true)}</Delta>;

/** Trading records: how the portfolio has done, realised profit and loss, every execution, and the demo cash journal. */
export function TradingRecordsPage() {
  const perf = useLoad(() => api.get<{ performance: Performance }>("/api/trading/records/performance").then((r) => r.performance));
  const p = perf.data;
  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/app/trading" className="small">← Trading</Link>
          <h1>Trading records</h1>
          <p className="muted">Every trade you've made, what you gained or lost, and how your portfolio has done.</p>
        </div>
      </div>
      <ErrorText error={perf.error} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Performance · {p?.accountType === "real" ? "real account" : "demo account"}</h2>
          {p?.since && <span className="faint small">Since your demo reset {timeAgo(p.since)}</span>}
        </div>
        {!p ? (
          <div className="skeleton" style={{ height: 240 }} />
        ) : (
          <>
            <div className="grid grid-4" style={{ marginBottom: 12 }}>
              <Stat label="Change in value" value={p.changePct === null ? "—" : <Delta value={p.changePct}>{pct(p.changePct)}</Delta>} sub={p.series.length ? `over ${p.series.length} day${p.series.length === 1 ? "" : "s"}` : "No valuations yet"} />
              <Stat label="Realised P&L" value={signedUsd(p.realizedPl)} sub={`${p.closingTrades} closing trade${p.closingTrades === 1 ? "" : "s"}`} />
              <Stat label="Win rate" value={p.winRatePct === null ? "—" : `${p.winRatePct}%`} sub={p.profitFactor === null ? "Profit factor —" : `Profit factor ${p.profitFactor}`} />
              <Stat label="Largest fall" value={p.maxDrawdownPct === null ? "—" : `${p.maxDrawdownPct}%`} sub="From a peak in value" />
            </div>
            <EquityChart points={p.series} title="Portfolio value by day" />
            {(p.bestTrade || p.worstTrade) && (
              <div className="row wrap small" style={{ gap: 16, marginTop: 10 }}>
                {p.bestTrade && p.bestTrade.realizedPl > 0 && <span>Best trade: <strong>{p.bestTrade.symbol}</strong> {signedUsd(p.bestTrade.realizedPl)}</span>}
                {p.worstTrade && p.worstTrade.realizedPl < 0 && <span>Worst trade: <strong>{p.worstTrade.symbol}</strong> {signedUsd(p.worstTrade.realizedPl)}</span>}
                {p.averageWin !== null && <span className="muted">Average win {usd(p.averageWin)}</span>}
                {p.averageLoss !== null && <span className="muted">Average loss {usd(p.averageLoss)}</span>}
              </div>
            )}
          </>
        )}
      </div>

      <RealizedCard defaultType={p?.accountType ?? "demo"} />
      <TradesCard />
      {p?.broker !== "alpaca" && <CashJournalCard />}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="num" style={{ fontWeight: 700, fontSize: 20 }}>{value}</div>
      {sub && <div className="faint xs">{sub}</div>}
    </div>
  );
}

function RealizedCard({ defaultType }: { defaultType: AccountType }) {
  const [year, setYear] = useState<number | null>(null);
  const [type, setType] = useState<AccountType | null>(null);
  const accountType = type ?? defaultType;
  const q = `accountType=${accountType}${year ? `&year=${year}` : ""}`;
  const data = useLoad(() => api.get<{ years: number[]; report: Realized }>(`/api/trading/records/realized?${q}`), [q]);
  const r = data.data?.report;
  const monthName = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  return (
    <div className="card" style={{ marginBottom: 16 }} id="realised">
      <div className="card-head">
        <h2>Realised profit &amp; loss</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="input" style={{ height: 34, width: "auto" }} aria-label="Year" value={r?.year ?? ""} onChange={(e) => setYear(Number(e.target.value))}>
            {(data.data?.years.length ? data.data.years : [r?.year ?? new Date().getFullYear()]).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="input" style={{ height: 34, width: "auto" }} aria-label="Account" value={accountType} onChange={(e) => setType(e.target.value as AccountType)}>
            <option value="demo">Demo account</option>
            <option value="real">Real account</option>
          </select>
          {r && <a className="btn secondary sm" href={`/api/trading/records/realized?${q}&format=csv`}>Download CSV</a>}
        </div>
      </div>
      <ErrorText error={data.error} />
      {!r ? (
        !data.error && <div className="skeleton" style={{ height: 200 }} />
      ) : r.closingTrades === 0 ? (
        <Empty>
          No closed trades in {r.year} on your {r.accountType} account yet. Profit or loss is realised when you sell (or close a futures position).
          {r.unknownTrades > 0 && ` ${r.unknownTrades} earlier closing trade${r.unknownTrades === 1 ? " was" : "s were"} made before records began.`}
        </Empty>
      ) : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <Stat label={`Realised in ${r.year}`} value={signedUsd(r.realizedPl)} sub={`${r.closingTrades} closing trades · ${r.wins} won, ${r.losses} lost`} />
            <Stat label="Proceeds" value={usd(r.proceeds)} sub="Stocks and crypto sold" />
            <Stat label="Cost basis" value={usd(r.costBasis)} sub={`${r.method[0].toUpperCase()}${r.method.slice(1)} method`} />
            <Stat label="Fees" value={usd(r.fees)} sub={`${r.trades} trades in ${r.year}`} />
          </div>
          <PnlBars
            title={`Realised profit and loss by month, ${r.year}`}
            bars={r.months.map((m) => ({ label: monthName(m.month), value: m.realizedPl, detail: `${m.trades} closing trade${m.trades === 1 ? "" : "s"}` }))}
          />
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr><th>Symbol</th><th className="r">Closing trades</th><th className="r hide-sm">Won / lost</th><th className="r hide-sm">Proceeds</th><th className="r hide-sm">Cost basis</th><th className="r">Realised</th></tr>
              </thead>
              <tbody>
                {r.bySymbol.map((s) => (
                  <tr key={s.symbol}>
                    <td><Link to={`/app/trading?symbol=${encodeURIComponent(s.symbol)}`}><strong>{s.symbol}</strong></Link> <span className="faint xs">{MARKET_LABEL[s.assetClass]}</span></td>
                    <td className="r num">{s.trades}</td>
                    <td className="r num hide-sm">{s.wins} / {s.losses}</td>
                    <td className="r num hide-sm">{s.assetClass === "future" ? "—" : usd(s.proceeds)}</td>
                    <td className="r num hide-sm">{s.assetClass === "future" ? "—" : usd(s.costBasis)}</td>
                    <td className="r num">{signedUsd(s.realizedPl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint xs" style={{ marginBottom: 0 }}>
            Stocks and crypto use the average-cost method. Futures profit or loss is settled in cash as positions close.
            {r.unknownTrades > 0 && ` ${r.unknownTrades} closing trade${r.unknownTrades === 1 ? "" : "s"} made before records began ${r.unknownTrades === 1 ? "isn't" : "aren't"} included.`}
            {" "}This is a record of your trades, not tax advice.
          </p>
        </>
      )}
    </div>
  );
}

function TradesCard() {
  const [filters, setFilters] = useState({ from: "", to: "", symbol: "", assetClass: "", accountType: "" });
  const [applied, setApplied] = useState(filters);
  const [more, setMore] = useState<Fill[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const page = useLoad(async () => {
    const r = await api.get<{ fills: Fill[]; nextBefore: string | null }>(`/api/trading/records/trades?${qs}`);
    setMore([]);
    setCursor(r.nextBefore);
    return r.fills;
  }, [qs]);
  const fills = [...(page.data ?? []), ...more];
  async function loadMore() {
    if (!cursor) return;
    const r = await api.get<{ fills: Fill[]; nextBefore: string | null }>(`/api/trading/records/trades?${qs}${qs ? "&" : ""}before=${encodeURIComponent(cursor)}`);
    setMore((m) => [...m, ...r.fills]);
    setCursor(r.nextBefore);
  }
  const set = (k: keyof typeof filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  return (
    <div className="card" style={{ marginBottom: 16 }} id="trades">
      <div className="card-head">
        <h2>Trade history</h2>
        <a className="btn secondary sm" href={`/api/trading/records/trades?${qs}${qs ? "&" : ""}format=csv`}>Download CSV</a>
      </div>
      <form
        className="row wrap"
        style={{ gap: 8, alignItems: "flex-end", marginBottom: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label="From"><input className="input" type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)} /></Field>
        <Field label="Symbol"><input className="input" style={{ width: 110 }} value={filters.symbol} placeholder="Any" onChange={(e) => set("symbol")(e.target.value.toUpperCase())} /></Field>
        <Field label="Market">
          <select className="input" value={filters.assetClass} onChange={(e) => set("assetClass")(e.target.value)}>
            <option value="">All</option>
            <option value="stock">Stocks</option>
            <option value="crypto">Crypto</option>
            <option value="future">Futures</option>
          </select>
        </Field>
        <Field label="Account">
          <select className="input" value={filters.accountType} onChange={(e) => set("accountType")(e.target.value)}>
            <option value="">Both</option>
            <option value="demo">Demo</option>
            <option value="real">Real</option>
          </select>
        </Field>
        <button className="btn secondary" style={{ marginBottom: 2 }}>Show</button>
      </form>
      <ErrorText error={page.error} />
      {page.data && fills.length === 0 ? (
        <Empty>No trades match. Trades appear here as soon as an order fills.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Trade</th><th className="r">Price</th><th className="r hide-sm">Value</th><th className="r hide-sm">Position after</th><th className="r">Realised</th></tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id}>
                  <td className="nowrap small">
                    {new Date(f.executedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    <div className="faint xs">{f.accountType === "real" ? "Real" : "Demo"}{f.placedBy !== "user" ? ` · ${f.placedBy === "system" ? "margin call" : "Autopilot"}` : ""}</div>
                  </td>
                  <td>
                    <span className={f.side === "buy" ? "good" : "bad"} style={{ fontWeight: 600 }}>{f.side === "buy" ? "Buy" : "Sell"}</span> {fmtQty(f.qty)}{" "}
                    <strong>{f.symbol}</strong> <span className="faint xs">{MARKET_LABEL[f.assetClass]}</span>
                  </td>
                  <td className="r num">{price(f.price)}</td>
                  <td className="r num hide-sm">{usd(f.notional)}</td>
                  <td className="r num hide-sm">{f.positionAfter === null ? "—" : fmtQty(f.positionAfter)}</td>
                  <td className="r num">{f.realizedPl === null ? <span className="faint">{f.closedQty > 0 ? "unknown" : "—"}</span> : signedUsd(f.realizedPl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={loadMore}>Load more</button>}
    </div>
  );
}

function CashJournalCard() {
  const entries = useLoad(() =>
    api.get<{ entries: { id: number; kind: string; amount: number; balanceAfter: number; memo: string | null; at: string }[] }>("/api/trading/records/cash").then((r) => r.entries),
  );
  return (
    <details className="card" style={{ marginBottom: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>Demo cash journal</summary>
      <p className="faint small">Every change to your demo account's cash, newest first. It always adds up to your cash balance.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>What</th><th className="r">Amount</th><th className="r">Cash after</th></tr></thead>
          <tbody>
            {(entries.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="nowrap small">{new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{e.memo ?? e.kind}</td>
                <td className="r num">{signedUsd(e.amount)}</td>
                <td className="r num">{usd(e.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
