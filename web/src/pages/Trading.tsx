import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AutopilotPanel } from "../components/Autopilot";
import { PriceChart } from "../components/charts";
import { Icon } from "../components/icons";
import { Delta, Empty, ErrorText, Field, Modal, StatusPill } from "../components/ui";
import { num, pct, price, qty as fmtQty, timeAgo, usd } from "../format";
import { assetClassOf, fmtPrice, MARKET_LABEL, sourceLabel, units } from "../markets";
import { useAuth, useLoad, useToast } from "../state";
import type { AssetClass, Bar, Instrument, Order, Position, Provider, Quote, Signal, TradingAccount, TradingSettings } from "../types";

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
    if (!confirm("Restart your demo account? Positions are cleared and cash goes back to your starting balance. (Pick a different balance on the Learn page.)")) return;
    await api.post("/api/trading/account/reset", { startingCash: settings?.demoStartingCash });
    toast("Demo account restarted");
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
                {settings.broker === "paper" ? "Demo account · virtual money" : acct?.live ? "REAL account · Alpaca" : "Demo account · Alpaca paper"}
              </span>
            )}
            {settings?.accountType === "demo" && <Link to="/app/learn" className="small">Learn</Link>}
            {settings?.accountType === "demo" && !settings.realAccountApproved && <Link to="/app/upgrade" className="small">Upgrade to real</Link>}
            {settings && <span className={`pill ${simulated ? "warn" : "good"}`}>{simulated ? "Simulated stock prices" : "Live stock prices"}</span>}
            {settings?.markets?.crypto === "coinbase" && <span className="pill good">Live crypto prices</span>}
            <Link to="/app/settings#trading" className="small">Broker settings</Link>
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn secondary sm" to="/app/trading/records">Records &amp; P&amp;L</Link>
          {settings?.broker === "paper" && (
            <button className="btn ghost sm" onClick={resetPaper}>Restart demo account</button>
          )}
        </div>
      </div>

      {chart.data && <MarketBanner quote={chart.data.quote} futuresTradable={settings?.markets?.futuresTradable ?? true} />}

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
          <div className="stat-sub">
            Buying power {acct ? usd(acct.buyingPower) : "—"}
            {acct && acct.marginUsed > 0 ? ` · ${usd(acct.marginUsed)} futures margin` : ""}
          </div>
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
        <MarketsCard
          items={watchlist.data?.items ?? []}
          selected={symbol}
          onSelect={setSymbol}
          onChange={() => watchlist.reload()}
        />
        <div className="card span-2">
          {chart.data ? (
            <>
              <QuoteHeader quote={chart.data.quote} position={position} />
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
        <OrderTicket
          symbol={symbol}
          quote={chart.data?.quote ?? null}
          held={position?.qty ?? 0}
          futuresTradable={settings?.markets?.futuresTradable ?? true}
          onPlaced={refreshAll}
        />
        <AnalystPanel symbol={symbol} quote={chart.data?.quote ?? null} onExecuted={refreshAll} onAnalyzed={() => signals.reload()} maxPct={aiCapPct} liveTradingNote={meta?.trading.liveTradingAllowed ?? false} />
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
                  <th className="r">Quantity</th>
                  <th className="r">Avg price</th>
                  <th className="r">Price</th>
                  <th className="r">Value</th>
                  <th className="r">P&L</th>
                </tr>
              </thead>
              <tbody>
                {(acct?.positions ?? []).map((p) => (
                  <tr key={p.symbol} onClick={() => setSymbol(p.symbol)} style={{ cursor: "pointer" }}>
                    <td>
                      <div style={{ fontWeight: 650 }}>{p.symbol}</div>
                      <div className="faint xs">
                        {MARKET_LABEL[p.assetClass ?? "stock"]}
                        {p.assetClass === "future" ? ` · ${p.side === "short" ? "Short" : "Long"}` : ""}
                      </div>
                    </td>
                    <td className="r num">{fmtQty(p.qty)} <span className="faint xs">{units(p.symbol, p.qty)}</span></td>
                    <td className="r num">{price(p.avgCost)}</td>
                    <td className="r num">{price(p.price)}</td>
                    <td className="r num">
                      {p.assetClass === "future" ? (
                        <>
                          {usd(p.notional)}
                          <div className="faint xs">{usd(p.margin)} margin</div>
                        </>
                      ) : (
                        usd(p.marketValue)
                      )}
                    </td>
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
                          {o.placedBy === "system" ? (
                            <span className="pill bad" style={{ marginLeft: 6 }}>Margin call</span>
                          ) : o.placedBy === "autopilot" ? (
                            <span className="pill brand" style={{ marginLeft: 6 }}>Autopilot</span>
                          ) : (
                            o.source === "ai" && <span className="pill brand" style={{ marginLeft: 6 }}>AI</span>
                          )}
                        </div>
                        <div className="faint xs">{o.type}{o.limitPrice ? ` @ ${price(o.limitPrice)}` : ""} · {timeAgo(o.createdAt)}</div>
                        {o.rejectReason && <div className="error-text xs">{o.rejectReason}</div>}
                      </td>
                      <td className="r num">{o.filledAvgPrice ? price(o.filledAvgPrice) : "—"}</td>
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
                  <div style={{ fontWeight: 600 }}>{s.symbol} <span className="faint small">@ {price(s.price)}</span></div>
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

function MarketBanner({ quote, futuresTradable }: { quote: Quote; futuresTradable: boolean }) {
  if (quote.assetClass === "future") {
    return (
      <div className="banner">
        Futures prices are simulated: live futures data needs a paid exchange licence. Contract sizes, margin and leverage match the
        real {quote.contract?.exchange ?? "exchange"} contracts, and futures trade in your demo account
        {futuresTradable ? "." : ". Switch to your demo account in Settings to trade them."}
      </div>
    );
  }
  if (quote.source !== "simulated") return null;
  return (
    <div className="banner">
      {quote.assetClass === "crypto"
        ? "Crypto prices are simulated on this server, so you can practise risk-free."
        : "Stock prices are synthetic so you can practise risk-free. Connect Alpaca in Settings for real market data and paper or live brokerage."}
    </div>
  );
}

function QuoteHeader({ quote, position }: { quote: Quote; position?: Position }) {
  const c = quote.contract;
  return (
    <div className="stack" style={{ gap: 10, marginBottom: 12 }}>
      <div className="row between wrap" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="row wrap" style={{ gap: 8 }}>
            <h2 style={{ fontSize: 20 }}>{quote.symbol}</h2>
            <span className="muted small">{quote.name}</span>
            <span className={`pill ${quote.assetClass === "future" ? "warn" : quote.assetClass === "crypto" ? "brand" : ""}`}>{MARKET_LABEL[quote.assetClass ?? "stock"]}</span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 4 }}>
            <span className="stat-value" style={{ margin: 0 }}>${fmtPrice(quote.price, quote)}</span>
            <Delta value={quote.change}>
              {quote.change >= 0 ? "+" : "−"}
              {fmtPrice(Math.abs(quote.change), quote)} ({pct(quote.changePct)})
            </Delta>
          </div>
          <div className="faint xs">
            {quote.assetClass === "crypto" ? "24h" : "Day"} range {fmtPrice(quote.dayLow, quote)} – {fmtPrice(quote.dayHigh, quote)} · {sourceLabel(quote.source)} · {quote.hours} · updated {timeAgo(quote.asOf)}
          </div>
        </div>
        {position && (
          <div className="card" style={{ padding: "10px 14px", boxShadow: "none", background: "var(--surface-2)" }}>
            <div className="faint xs">Your position</div>
            <div className="num" style={{ fontWeight: 650 }}>
              {position.assetClass === "future" ? `${position.side === "short" ? "Short" : "Long"} ${fmtQty(Math.abs(position.qty))}` : fmtQty(position.qty)}{" "}
              {units(position.symbol, position.qty)} · {usd(position.assetClass === "future" ? position.notional : position.marketValue)}
            </div>
            <Delta value={position.unrealizedPl}>{usd(position.unrealizedPl, true)} ({pct(position.unrealizedPlPct)})</Delta>
          </div>
        )}
      </div>
      {c && (
        <div className="kv" style={{ background: "var(--surface-2)", borderRadius: 10, padding: "8px 12px" }}>
          <div><span>Contract</span><strong>{c.exchange} · {c.month} ({c.code})</strong></div>
          <div><span>Contract size</span><strong>{c.multiplier.toLocaleString()} × price ({c.unit})</strong></div>
          <div><span>Contract value</span><strong>{usd(quote.price * c.multiplier)}</strong></div>
          <div><span>Margin per contract</span><strong>{usd(c.marginPerContract)} ({c.leverage}x leverage)</strong></div>
          <div><span>Tick</span><strong>{c.tickSize} = {usd(c.tickValue)}</strong></div>
          <div><span>Maintenance margin</span><strong>{usd(c.maintenancePerContract)}</strong></div>
        </div>
      )}
    </div>
  );
}

type MarketTab = "watchlist" | AssetClass;
const TABS: { id: MarketTab; label: string }[] = [
  { id: "watchlist", label: "Watchlist" },
  { id: "stock", label: "Stocks" },
  { id: "crypto", label: "Crypto" },
  { id: "future", label: "Futures" },
];

function MarketsCard({
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
  const [tab, setTab] = useState<MarketTab>("watchlist");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[] | null>(null);
  const browse = useLoad(
    () => (tab === "watchlist" ? Promise.resolve([] as Instrument[]) : api.get<{ symbols: Instrument[] }>(`/api/trading/symbols?class=${tab}`).then((r) => r.symbols)),
    [tab],
  );
  const watched = new Set(items.map((i) => i.symbol));

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.get<{ symbols: Instrument[] }>(`/api/trading/symbols?q=${encodeURIComponent(query)}`).then((r) => setResults(r.symbols)).catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  async function watch(sym: string) {
    try {
      await api.post("/api/trading/watchlist", { symbol: sym });
      onChange();
      toast(`${sym} added to your watchlist`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  function open(e?: FormEvent) {
    e?.preventDefault();
    const first = results?.[0]?.symbol ?? query.trim().toUpperCase();
    if (!first) return;
    onSelect(first);
    setQuery("");
  }

  const instrumentRow = (it: Instrument) => (
    <div key={it.symbol} className="row" style={{ gap: 2 }}>
      <button className={`ticker-row ${it.symbol === selected ? "active" : ""}`} onClick={() => onSelect(it.symbol)} style={{ gridTemplateColumns: "1fr auto" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650 }}>{it.symbol}</div>
          <div className="faint xs" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 }}>{it.name}</div>
        </div>
        <span className="faint xs" style={{ textAlign: "right", maxWidth: 90 }}>{it.detail}</span>
      </button>
      {watched.has(it.symbol) ? (
        <span className="faint xs" style={{ width: 26, textAlign: "center" }} title="On your watchlist">✓</span>
      ) : (
        <button className="btn ghost icon-btn" style={{ width: 26, height: 26 }} aria-label={`Add ${it.symbol} to watchlist`} onClick={() => watch(it.symbol)}>
          <Icon.Plus size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div className="card">
      <div className="card-head"><h2>Markets</h2></div>
      <form onSubmit={open} style={{ marginBottom: 8 }}>
        <input
          className="input"
          style={{ height: 34 }}
          placeholder="Search stocks, crypto, futures…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search markets"
        />
      </form>
      {!results && (
        <div className="seg" role="tablist" style={{ marginBottom: 8, width: "100%" }}>
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} style={{ flex: 1 }} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ maxHeight: 440, overflowY: "auto" }}>
        {results ? (
          results.length === 0 ? (
            <Empty>No matches. Try a ticker (AAPL), a coin (BTC) or a contract (ES).</Empty>
          ) : (
            results.map(instrumentRow)
          )
        ) : tab === "watchlist" ? (
          items.length === 0 ? (
            <Empty>Your watchlist is empty. Browse Stocks, Crypto or Futures and tap + to add.</Empty>
          ) : (
            items.map((it) => (
              <div key={it.symbol} className="row" style={{ gap: 2 }}>
                <button className={`ticker-row ${it.symbol === selected ? "active" : ""}`} onClick={() => onSelect(it.symbol)} style={{ gridTemplateColumns: "1fr auto" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 650 }}>{it.symbol}</div>
                    <div className="faint xs" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }}>{it.quote?.name ?? it.error}</div>
                  </div>
                  {it.quote && (
                    <div style={{ textAlign: "right" }}>
                      <div className="num" style={{ fontWeight: 600 }}>{fmtPrice(it.quote.price, it.quote)}</div>
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
            ))
          )
        ) : browse.data ? (
          <>
            {tab === "stock" && <p className="faint xs" style={{ margin: "0 0 6px" }}>Popular picks. Search to find any of the 12,000 US-listed stocks and ETFs.</p>}
            {tab === "crypto" && <p className="faint xs" style={{ margin: "0 0 6px" }}>Popular coins, trading 24/7. Search for hundreds more.</p>}
            {tab === "future" && <p className="faint xs" style={{ margin: "0 0 6px" }}>Front-month contracts with real sizes and margin. Demo account only.</p>}
            {browse.data.map(instrumentRow)}
          </>
        ) : (
          <div className="skeleton" style={{ height: 200 }} />
        )}
      </div>
    </div>
  );
}

function OrderTicket({
  symbol,
  quote,
  held,
  futuresTradable,
  onPlaced,
}: {
  symbol: string;
  quote: Quote | null;
  held: number;
  futuresTradable: boolean;
  onPlaced: () => void;
}) {
  const toast = useToast();
  const cls = assetClassOf(symbol);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [spend, setSpend] = useState("");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const px = type === "limit" && Number(limit) > 0 ? Number(limit) : quote?.price ?? 0;
  const n = Number(qty) > 0 ? Number(qty) : 0;
  const contract = quote?.contract;

  // A sensible starting size for each market: 1 share, $100 of crypto, 1 contract.
  useEffect(() => {
    setError(null);
    setSide("buy");
    setType("market");
    setLimit("");
    setSpend(cls === "crypto" ? "100" : "");
    setQty(cls === "crypto" ? "" : "1");
  }, [symbol, cls]);
  useEffect(() => {
    if (cls === "crypto" && spend && quote?.price && !qty) setQty(String(Math.floor((Number(spend) / quote.price) * 1e8) / 1e8));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.price]);

  const opening = cls === "future" && Math.abs(held + (side === "buy" ? n : -n)) > Math.abs(held);
  const sideLabel =
    cls !== "future"
      ? side === "buy" ? "Buy" : "Sell"
      : side === "buy" ? (held < 0 ? "Buy to cover" : "Buy (long)") : held > 0 ? "Sell" : "Sell short";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ order: Order }>("/api/trading/orders", {
        symbol,
        side,
        type,
        qty: n,
        limitPrice: type === "limit" ? Number(limit) : undefined,
      });
      toast(
        r.order.status === "filled"
          ? `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(r.order.qty)} ${units(symbol, r.order.qty)}${cls === "crypto" ? "" : ` of ${symbol}`} at ${fmtPrice(r.order.filledAvgPrice, quote)}`
          : `Order placed (${r.order.status})`,
      );
      onPlaced();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (cls === "future" && !futuresTradable) {
    return (
      <div className="card">
        <div className="card-head"><h2>Order ticket · {symbol}</h2></div>
        <Empty>Futures trade in your demo account only (Alpaca doesn't offer futures). Switch to your demo account in Settings → Trading to trade {symbol}.</Empty>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Order ticket · {symbol}</h2>
        <div className="seg buy-sell">
          <button type="button" className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>{cls === "future" ? "Buy / Long" : "Buy"}</button>
          <button type="button" className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>{cls === "future" ? "Sell / Short" : "Sell"}</button>
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
          <Field
            label={cls === "future" ? "Contracts" : cls === "crypto" ? `Amount (${symbol.replace("-USD", "")})` : "Shares"}
            hint={
              held !== 0
                ? cls === "future"
                  ? `You're ${held < 0 ? "short" : "long"} ${fmtQty(Math.abs(held))}`
                  : `You hold ${fmtQty(held)}`
                : undefined
            }
          >
            <input
              className="input num"
              inputMode={cls === "future" ? "numeric" : "decimal"}
              value={qty}
              onChange={(e) => {
                setQty(e.target.value.replace(cls === "future" ? /[^\d]/g : /[^\d.]/g, ""));
                setSpend("");
              }}
              required
            />
          </Field>
        </div>
        {cls === "crypto" && (
          <Field label="Or spend (USD)" hint="Crypto trades in fractions, around the clock">
            <input
              className="input num"
              inputMode="decimal"
              value={spend}
              placeholder="100"
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                setSpend(v);
                if (quote?.price && Number(v) > 0) setQty(String(Math.floor((Number(v) / px) * 1e8) / 1e8));
              }}
            />
          </Field>
        )}
        {type === "limit" && (
          <Field label="Limit price" hint={side === "buy" ? "Fills at or below this price" : "Fills at or above this price"}>
            <input className="input num" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} placeholder={quote ? fmtPrice(quote.price, quote) : ""} required />
          </Field>
        )}
        {contract ? (
          <>
            <div className="row between small">
              <span className="muted">Contract value</span>
              <strong className="num">{usd(n * px * contract.multiplier)}</strong>
            </div>
            <div className="row between small">
              <span className="muted">{opening ? "Margin needed" : "Margin released"}</span>
              <strong className="num">{usd(n * contract.marginPerContract)}</strong>
            </div>
            <p className="faint xs" style={{ margin: 0 }}>
              Each {fmtPrice(contract.tickSize, quote)} move is {usd(contract.tickValue)} per contract. With {contract.leverage}x leverage, a{" "}
              {(100 / contract.leverage).toFixed(1)}% move against you would wipe out the margin.
            </p>
          </>
        ) : (
          <div className="row between small">
            <span className="muted">Estimated {side === "buy" ? "cost" : "proceeds"}</span>
            <strong className="num">{usd(n * px)}</strong>
          </div>
        )}
        <ErrorText error={error} />
        <button className={`btn block lg ${side === "sell" ? "danger" : ""}`} disabled={busy || !quote || !(n > 0)}>
          {busy ? "Placing…" : `${sideLabel} ${qty || 0} ${cls === "crypto" ? symbol.replace("-USD", "") : symbol}`}
        </button>
      </form>
    </div>
  );
}

function AnalystPanel({
  symbol,
  quote,
  onExecuted,
  onAnalyzed,
  maxPct,
  liveTradingNote,
}: {
  symbol: string;
  quote: Quote | null;
  onExecuted: () => void;
  onAnalyzed: () => void;
  maxPct: number;
  liveTradingNote: boolean;
}) {
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
              <div><span>Price</span><strong>{fmtPrice(signal.price, quote)}</strong></div>
              <div><span>Stop-loss</span><strong>{fmtPrice(signal.stopLoss, quote)}</strong></div>
              <div><span>Take-profit</span><strong>{fmtPrice(signal.takeProfit, quote)}</strong></div>
              <div><span>Suggested size</span><strong>{signal.suggestedQty ? `${fmtQty(signal.suggestedQty)} ${units(signal.symbol, signal.suggestedQty)}` : "—"}</strong></div>
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
          quote={quote?.symbol === signal.symbol ? quote : null}
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

function ConfirmAiOrder({ signal, quote, onClose, onDone }: { signal: Signal; quote: Quote | null; onClose: () => void; onDone: (s: Signal) => void }) {
  const cls = assetClassOf(signal.symbol);
  const contract = quote?.contract;
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
          Market order to <strong>{signal.action}</strong> {signal.symbol} at about ${fmtPrice(signal.price, quote)}
          {cls === "future" ? " per contract unit" : cls === "crypto" ? " per coin" : " per share"}.
          {signal.stopLoss && ` Suggested stop-loss ${fmtPrice(signal.stopLoss, quote)}.`} {signal.takeProfit && `Take-profit ${fmtPrice(signal.takeProfit, quote)}.`}
          {cls === "future" && " Futures are leveraged: losses can exceed the margin you put up."}
        </p>
        <Field
          label={cls === "future" ? "Contracts" : cls === "crypto" ? `Amount (${signal.symbol.replace("-USD", "")})` : "Shares"}
          hint={
            contract
              ? `Contract value ${usd(Number(qty || 0) * signal.price * contract.multiplier)} · margin ${usd(Number(qty || 0) * contract.marginPerContract)}`
              : `Estimated ${usd(Number(qty || 0) * signal.price)}`
          }
        >
          <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(cls === "future" ? /[^\d]/g : /[^\d.]/g, ""))} />
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
