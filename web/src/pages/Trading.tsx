import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AutopilotPanel } from "../components/Autopilot";
import { PriceChart } from "../components/charts";
import { Icon } from "../components/icons";
import { Delta, Empty, ErrorText, Field, Modal, StatusPill } from "../components/ui";
import { num, pct, qty as fmtQty, timeAgo, usd } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import type { Bar, Order, Provider, Quote, Signal, TradingAccount, TradingSettings } from "../types";

export function TradingPage() {
  const toast = useToast();
  const { meta } = useAuth();
  const [params, setParams] = useSearchParams();
  const symbol = (params.get("symbol") ?? "AAPL").toUpperCase();
  const setSymbol = (s: string) => setParams({ symbol: s }, { replace: true });

  const account = useLoad(() => api.get<{ account: TradingAccount; settings: TradingSettings }>("/api/trading/account"));
  const watchlist = useLoad(() => api.get<{ source: string; items: { symbol: string; quote: Quote | null; error: string | null }[] }>("/api/trading/watchlist"));
  const orders = useLoad(() => api.get<{ orders: Order[] }>("/api/trading/orders").then((r) => r.orders));
  const signals = useLoad(() => api.get<{ signals: Signal[] }>("/api/trading/signals").then((r) => r.signals));
  const chart = useLoad(
    () =>
      Promise.all([
        api.get<{ quote: Quote }>(`/api/trading/quote/${encodeURIComponent(symbol)}`).then((r) => r.quote),
        api.get<{ bars: Bar[] }>(`/api/trading/bars/${encodeURIComponent(symbol)}?days=180`).then((r) => r.bars),
      ]).then(([quote, bars]) => ({ quote, bars })),
    [symbol],
  );

  // Refresh prices every 15s while the page is open.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      watchlist.reload();
      api.get<{ quote: Quote }>(`/api/trading/quote/${encodeURIComponent(symbol)}`).then((r) => chart.setData((d) => (d ? { ...d, quote: r.quote } : d))).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const refreshAll = () => {
    account.reload();
    orders.reload();
    signals.reload();
  };

  const settings = account.data?.settings;
  const acct = account.data?.account;
  const position = acct?.positions.find((p) => p.symbol === symbol);
  const simulated = settings?.dataSource === "simulated";
  const aiCapPct = Math.round((meta?.trading.aiMaxPositionPct ?? 0.1) * 100);

  async function resetPaper() {
    if (!confirm("Reset your paper account? Positions are cleared and cash goes back to the starting balance.")) return;
    await api.post("/api/trading/account/reset");
    toast("Paper account reset");
    refreshAll();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trading</h1>
          <p className="muted row wrap" style={{ gap: 6, marginTop: 6 }}>
            {settings && (
              <span className={`pill ${acct?.live ? "bad" : "brand"}`}>
                {settings.broker === "paper" ? "Paper account" : acct?.live ? "LIVE Alpaca account" : "Alpaca paper account"}
              </span>
            )}
            {settings && <span className={`pill ${simulated ? "warn" : "good"}`}>{simulated ? "Simulated market data" : "Live market data"}</span>}
            <Link to="/app/settings#trading" className="small">Broker settings</Link>
          </p>
        </div>
        {settings?.broker === "paper" && (
          <button className="btn secondary sm" onClick={resetPaper}>Reset paper account</button>
        )}
      </div>

      {simulated && (
        <div className="banner">
          Prices are synthetic so you can practise risk-free. Connect Alpaca in Settings for real market data and paper or live brokerage.
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat-label">Portfolio value</div>
          <div className="stat-value">{acct ? usd(acct.equity) : "—"}</div>
          {acct?.totalReturnPct !== null && acct && (
            <div className="stat-sub"><Delta value={acct.totalReturnPct ?? 0}>{pct(acct.totalReturnPct)}</Delta> all time</div>
          )}
        </div>
        <div className="card">
          <div className="stat-label">Cash</div>
          <div className="stat-value">{acct ? usd(acct.cash) : "—"}</div>
          <div className="stat-sub">Buying power {acct ? usd(acct.buyingPower) : "—"}</div>
        </div>
        <div className="card">
          <div className="stat-label">Unrealised P&L</div>
          <div className="stat-value">
            {acct ? <Delta value={acct.positions.reduce((s, p) => s + p.unrealizedPl, 0)}>{usd(acct.positions.reduce((s, p) => s + p.unrealizedPl, 0), true)}</Delta> : "—"}
          </div>
          <div className="stat-sub">{acct?.positions.length ?? 0} open positions</div>
        </div>
        <div className="card">
          <div className="stat-label">AI guardrail</div>
          <div className="stat-value" style={{ fontSize: 20 }}>Max {aiCapPct}% per AI trade</div>
          <div className="stat-sub">You confirm AI orders, or let <a href="#autopilot">Autopilot</a> trade within your limits</div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Watchlist
          items={watchlist.data?.items ?? []}
          selected={symbol}
          onSelect={setSymbol}
          onChange={() => watchlist.reload()}
        />
        <div className="card span-2">
          {chart.data ? (
            <>
              <div className="row between wrap" style={{ marginBottom: 12, alignItems: "flex-start" }}>
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <h2 style={{ fontSize: 20 }}>{chart.data.quote.symbol}</h2>
                    <span className="muted small">{chart.data.quote.name}</span>
                  </div>
                  <div className="row" style={{ gap: 10, marginTop: 4 }}>
                    <span className="stat-value" style={{ margin: 0 }}>{usd(chart.data.quote.price)}</span>
                    <Delta value={chart.data.quote.change}>
                      {usd(chart.data.quote.change, true)} ({pct(chart.data.quote.changePct)})
                    </Delta>
                  </div>
                  <div className="faint xs">
                    Day range {num(chart.data.quote.dayLow)} – {num(chart.data.quote.dayHigh)} · updated {timeAgo(chart.data.quote.asOf)}
                  </div>
                </div>
                {position && (
                  <div className="card" style={{ padding: "10px 14px", boxShadow: "none", background: "var(--surface-2)" }}>
                    <div className="faint xs">Your position</div>
                    <div className="num" style={{ fontWeight: 650 }}>{fmtQty(position.qty)} sh · {usd(position.marketValue)}</div>
                    <Delta value={position.unrealizedPl}>{usd(position.unrealizedPl, true)} ({pct(position.unrealizedPlPct)})</Delta>
                  </div>
                )}
              </div>
              <PriceChart bars={chart.data.bars} title={`${chart.data.quote.symbol} daily price`} />
            </>
          ) : chart.error ? (
            <ErrorText error={chart.error} />
          ) : (
            <div className="skeleton" style={{ height: 320 }} />
          )}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <OrderTicket symbol={symbol} quote={chart.data?.quote ?? null} held={position?.qty ?? 0} onPlaced={refreshAll} />
        <AnalystPanel symbol={symbol} onExecuted={refreshAll} onAnalyzed={() => signals.reload()} maxPct={aiCapPct} liveTradingNote={meta?.trading.liveTradingAllowed ?? false} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <AutopilotPanel onTraded={refreshAll} />
      </div>

      <div className="card flush" style={{ marginBottom: 16 }}>
        <div className="card-head"><h2>Positions</h2></div>
        <div className="table-wrap" style={{ padding: "0 8px 8px" }}>
          {acct && acct.positions.length === 0 ? (
            <Empty>No positions yet. Place an order or ask the AI analyst for an idea.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="r">Shares</th>
                  <th className="r">Avg cost</th>
                  <th className="r">Price</th>
                  <th className="r">Value</th>
                  <th className="r">P&L</th>
                </tr>
              </thead>
              <tbody>
                {(acct?.positions ?? []).map((p) => (
                  <tr key={p.symbol} onClick={() => setSymbol(p.symbol)} style={{ cursor: "pointer" }}>
                    <td style={{ fontWeight: 650 }}>{p.symbol}</td>
                    <td className="r num">{fmtQty(p.qty)}</td>
                    <td className="r num">{num(p.avgCost)}</td>
                    <td className="r num">{num(p.price)}</td>
                    <td className="r num">{usd(p.marketValue)}</td>
                    <td className="r"><Delta value={p.unrealizedPl}>{usd(p.unrealizedPl, true)} ({pct(p.unrealizedPlPct)})</Delta></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card flush">
          <div className="card-head"><h2>Orders</h2></div>
          <div className="table-wrap" style={{ padding: "0 8px 8px" }}>
            {orders.data?.length === 0 ? (
              <Empty>No orders yet.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Order</th><th className="r">Fill</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {(orders.data ?? []).slice(0, 25).map((o) => (
                    <tr key={o.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          <span className={o.side === "buy" ? "good" : "bad"}>{o.side.toUpperCase()}</span> {fmtQty(o.qty)} {o.symbol}
                          {o.placedBy === "autopilot" ? (
                            <span className="pill brand" style={{ marginLeft: 6 }}>Autopilot</span>
                          ) : (
                            o.source === "ai" && <span className="pill brand" style={{ marginLeft: 6 }}>AI</span>
                          )}
                        </div>
                        <div className="faint xs">{o.type}{o.limitPrice ? ` @ ${num(o.limitPrice)}` : ""} · {timeAgo(o.createdAt)}</div>
                        {o.rejectReason && <div className="error-text xs">{o.rejectReason}</div>}
                      </td>
                      <td className="r num">{o.filledAvgPrice ? num(o.filledAvgPrice) : "—"}</td>
                      <td><StatusPill status={o.status} /></td>
                      <td className="r">
                        {["new", "accepted", "pending_new", "partially_filled"].includes(o.status) && (
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              try {
                                await api.post(`/api/trading/orders/${o.id}/cancel`);
                                refreshAll();
                              } catch (e) {
                                toast((e as Error).message, "error");
                              }
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>AI signal history</h2></div>
          {signals.data?.length === 0 && <Empty>Run the analyst to see signals here.</Empty>}
          <div className="list">
            {(signals.data ?? []).slice(0, 10).map((s) => (
              <button key={s.id} className="list-item" style={{ background: "none", border: 0, borderBottom: "1px solid var(--border)", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }} onClick={() => setSymbol(s.symbol)}>
                <span className={`pill ${s.action === "buy" ? "good" : s.action === "sell" ? "bad" : ""}`} style={{ width: 52, justifyContent: "center" }}>{s.action.toUpperCase()}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{s.symbol} <span className="faint small">@ {num(s.price)}</span></div>
                  <div className="faint xs">{s.provider === "rules" ? "Rule-based" : s.model} · {Math.round(s.confidence * 100)}% confidence · {timeAgo(s.createdAt)}</div>
                </div>
                {s.executedOrderId && <span className="pill brand">executed</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Watchlist({
  items,
  selected,
  onSelect,
  onChange,
}: {
  items: { symbol: string; quote: Quote | null; error: string | null }[];
  selected: string;
  onSelect: (s: string) => void;
  onChange: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState("");
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<{ symbols: { symbol: string; name: string }[] }>(`/api/trading/symbols?q=${encodeURIComponent(adding)}`).then((r) => setSuggestions(r.symbols.slice(0, 6))).catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [adding]);

  async function add(e?: FormEvent, sym = adding) {
    e?.preventDefault();
    if (!sym.trim()) return;
    try {
      await api.post("/api/trading/watchlist", { symbol: sym.trim().toUpperCase() });
      setAdding("");
      onChange();
      onSelect(sym.trim().toUpperCase());
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Watchlist</h2></div>
      <form onSubmit={add} className="row" style={{ marginBottom: 8 }}>
        <input className="input" style={{ height: 34 }} placeholder="Add symbol, e.g. TSLA" value={adding} onChange={(e) => setAdding(e.target.value.toUpperCase())} list="symbol-suggestions" aria-label="Add symbol" />
        <datalist id="symbol-suggestions">
          {suggestions.map((s) => (
            <option key={s.symbol} value={s.symbol}>{s.name}</option>
          ))}
        </datalist>
        <button className="btn sm" aria-label="Add to watchlist"><Icon.Plus size={14} /></button>
      </form>
      <div>
        {items.map((it) => (
          <div key={it.symbol} className="row" style={{ gap: 2 }}>
            <button className={`ticker-row ${it.symbol === selected ? "active" : ""}`} onClick={() => onSelect(it.symbol)} style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontWeight: 650 }}>{it.symbol}</div>
                <div className="faint xs" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }}>{it.quote?.name ?? it.error}</div>
              </div>
              {it.quote && (
                <div style={{ textAlign: "right" }}>
                  <div className="num" style={{ fontWeight: 600 }}>{num(it.quote.price)}</div>
                  <div className="xs"><Delta value={it.quote.changePct}>{pct(it.quote.changePct)}</Delta></div>
                </div>
              )}
            </button>
            <button
              className="btn ghost icon-btn"
              style={{ width: 26, height: 26 }}
              aria-label={`Remove ${it.symbol}`}
              onClick={async () => {
                await api.del(`/api/trading/watchlist/${encodeURIComponent(it.symbol)}`);
                onChange();
              }}
            >
              <Icon.X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrderTicket({ symbol, quote, held, onPlaced }: { symbol: string; quote: Quote | null; held: number; onPlaced: () => void }) {
  const toast = useToast();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const price = type === "limit" && Number(limit) > 0 ? Number(limit) : quote?.price ?? 0;
  const estimate = Number(qty) > 0 ? Number(qty) * price : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ order: Order }>("/api/trading/orders", {
        symbol,
        side,
        type,
        qty: Number(qty),
        limitPrice: type === "limit" ? Number(limit) : undefined,
      });
      toast(r.order.status === "filled" ? `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(r.order.qty)} ${symbol} at ${num(r.order.filledAvgPrice)}` : `Order placed (${r.order.status})`);
      onPlaced();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Order ticket · {symbol}</h2>
        <div className="seg buy-sell">
          <button type="button" className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>Buy</button>
          <button type="button" className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>Sell</button>
        </div>
      </div>
      <form className="stack" onSubmit={submit}>
        <div className="grid grid-2">
          <Field label="Order type">
            <select className="input" value={type} onChange={(e) => setType(e.target.value as "market" | "limit")}>
              <option value="market">Market</option>
              <option value="limit">Limit</option>
            </select>
          </Field>
          <Field label="Shares" hint={side === "sell" ? `You hold ${fmtQty(held)}` : undefined}>
            <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} required />
          </Field>
        </div>
        {type === "limit" && (
          <Field label="Limit price" hint={side === "buy" ? "Fills at or below this price" : "Fills at or above this price"}>
            <input className="input num" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} placeholder={quote ? num(quote.price) : ""} required />
          </Field>
        )}
        <div className="row between small">
          <span className="muted">Estimated {side === "buy" ? "cost" : "proceeds"}</span>
          <strong className="num">{usd(estimate)}</strong>
        </div>
        <ErrorText error={error} />
        <button className={`btn block lg ${side === "sell" ? "danger" : ""}`} disabled={busy || !quote || !(Number(qty) > 0)}>
          {busy ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${qty || 0} ${symbol}`}
        </button>
      </form>
    </div>
  );
}

function AnalystPanel({ symbol, onExecuted, onAnalyzed, maxPct, liveTradingNote }: { symbol: string; onExecuted: () => void; onAnalyzed: () => void; maxPct: number; liveTradingNote: boolean }) {
  const toast = useToast();
  const providers = useLoad(() => api.get<{ providers: Provider[] }>("/api/ai/providers").then((r) => r.providers));
  const options = [
    { value: "rules", label: "Rule-based (offline)" },
    ...(providers.data ?? [])
      .filter((p) => p.available && p.kind !== "demo")
      .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m.id}`, label: `${p.name} · ${m.label}` }))),
  ];
  const [choice, setChoice] = useState<string>("");
  const [signal, setSignal] = useState<Signal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!choice && providers.data) setChoice(options.find((o) => o.value.startsWith("anthropic:"))?.value ?? options[1]?.value ?? "rules");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data]);

  useEffect(() => {
    setSignal(null);
    setError(null);
  }, [symbol]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const [provider, ...rest] = (choice || "rules").split(":");
      const r = await api.post<{ signal: Signal }>("/api/trading/analyze", { symbol, provider, model: rest.join(":") || undefined });
      setSignal(r.signal);
      onAnalyzed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2><Icon.Sparkle size={16} /> AI analyst</h2>
      </div>
      <div className="stack">
        <div className="row wrap">
          <select className="input grow" style={{ height: 38 }} value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Analyst model">
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button className="btn" onClick={run} disabled={busy}>{busy ? <><span className="spinner" /> Analysing…</> : `Analyse ${symbol}`}</button>
        </div>
        <ErrorText error={error} />
        {signal && (
          <div className="signal-card">
            <div className="row between">
              <div>
                <div className={`signal-action ${signal.action === "buy" ? "good" : signal.action === "sell" ? "bad" : ""}`}>
                  {signal.action === "buy" ? "▲ " : signal.action === "sell" ? "▼ " : "• "}
                  {signal.action.toUpperCase()}
                </div>
                <div className="faint xs">{signal.provider === "rules" ? "Rule-based model" : signal.model} · horizon: {signal.horizon}</div>
              </div>
              <div style={{ width: 140 }}>
                <div className="row between xs"><span className="muted">Confidence</span><strong className="num">{Math.round(signal.confidence * 100)}%</strong></div>
                <div className="meter" role="meter" aria-valuenow={Math.round(signal.confidence * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Confidence">
                  <div style={{ width: `${Math.round(signal.confidence * 100)}%` }} />
                </div>
              </div>
            </div>
            <p className="small">{signal.rationale}</p>
            <div className="kv">
              <div><span>Price</span><strong>{num(signal.price)}</strong></div>
              <div><span>Stop-loss</span><strong>{num(signal.stopLoss)}</strong></div>
              <div><span>Take-profit</span><strong>{num(signal.takeProfit)}</strong></div>
              <div><span>Suggested size</span><strong>{signal.suggestedQty ? `${fmtQty(signal.suggestedQty)} sh` : "—"}</strong></div>
              <div><span>RSI 14</span><strong>{num(signal.indicators.rsi14 ?? null, 1)}</strong></div>
              <div><span>20d return</span><strong>{signal.indicators.return20d !== null ? pct((signal.indicators.return20d ?? 0) * 100) : "—"}</strong></div>
            </div>
            {signal.risks.length > 0 && (
              <div>
                <div className="faint xs" style={{ marginBottom: 4 }}>Key risks</div>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {signal.risks.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {signal.action !== "hold" && signal.suggestedQty > 0 && !signal.executedOrderId && (
              <button className={`btn block ${signal.action === "sell" ? "danger" : ""}`} onClick={() => setConfirming(true)}>
                Review & {signal.action} {fmtQty(signal.suggestedQty)} {signal.symbol}
              </button>
            )}
            {signal.executedOrderId && <span className="pill brand">Order placed</span>}
          </div>
        )}
        <p className="faint xs">
          Signals are generated from price data and are not financial advice. AI orders are capped at {maxPct}% of your portfolio and need your confirmation, unless you switch on Autopilot below.
          {liveTradingNote ? " Live trading is enabled on this server." : ""}
        </p>
      </div>
      {confirming && signal && (
        <ConfirmAiOrder
          signal={signal}
          onClose={() => setConfirming(false)}
          onDone={(s) => {
            setSignal(s);
            onExecuted();
            toast("AI-suggested order placed");
          }}
        />
      )}
    </div>
  );
}

function ConfirmAiOrder({ signal, onClose, onDone }: { signal: Signal; onClose: () => void; onDone: (s: Signal) => void }) {
  const [qty, setQty] = useState(String(signal.suggestedQty));
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ order: Order }>(`/api/trading/signals/${signal.id}/execute`, { qty: Number(qty), confirm: true });
      onDone({ ...signal, executedOrderId: r.order.id });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Confirm AI ${signal.action} order`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          Market order to <strong>{signal.action}</strong> {signal.symbol} at about {usd(signal.price)} per share.
          {signal.stopLoss && ` Suggested stop-loss ${num(signal.stopLoss)}.`} {signal.takeProfit && `Take-profit ${num(signal.takeProfit)}.`}
        </p>
        <Field label="Shares" hint={`Estimated ${usd(Number(qty || 0) * signal.price)}`}>
          <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <label className="row small" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I've reviewed this AI suggestion and want to place the order. I understand it isn't financial advice.</span>
        </label>
        <ErrorText error={error} />
        <button className={`btn block lg ${signal.action === "sell" ? "danger" : ""}`} disabled={!ack || busy || !(Number(qty) > 0)}>
          {busy ? "Placing…" : `Place ${signal.action} order`}
        </button>
      </form>
    </Modal>
  );
}
