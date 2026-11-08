import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Sparkline } from "../components/charts";
import { Icon } from "../components/icons";
import { ActivityList, ConvertDialog, DepositDialog, RequestDialog, SendDialog } from "../components/money";
import { Delta } from "../components/ui";
import { money, pct, usd } from "../format";
import { useAuth, useLoad } from "../state";
import type { Activity, Balance, Bar, PaymentRequest, Provider, Quote, TradingAccount, TradingSettings } from "../types";

type Dialog = null | "send" | "request" | "deposit" | "convert";

export function DashboardPage() {
  const { user, meta } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);

  const balances = useLoad(() => api.get<{ balances: Balance[] }>("/api/payments/balances").then((r) => r.balances));
  const activity = useLoad(() => api.get<{ items: Activity[] }>("/api/payments/activity?limit=6").then((r) => r.items));
  const requests = useLoad(() => api.get<{ incoming: PaymentRequest[] }>("/api/payments/requests").then((r) => r.incoming.filter((x) => x.status === "pending")));
  const trading = useLoad(() => api.get<{ account: TradingAccount; settings: TradingSettings }>("/api/trading/account"));
  const watch = useLoad(async () => {
    const wl = await api.get<{ items: { symbol: string; quote: Quote | null }[] }>("/api/trading/watchlist");
    const items = wl.items.filter((i) => i.quote).slice(0, 5);
    return Promise.all(
      items.map(async (i) => {
        const bars = await api.get<{ bars: Bar[] }>(`/api/trading/bars/${encodeURIComponent(i.symbol)}?days=30`).then((r) => r.bars).catch(() => []);
        return { ...i, closes: bars.map((b) => b.c) };
      }),
    );
  });
  const providers = useLoad(() => api.get<{ providers: Provider[] }>("/api/ai/providers").then((r) => r.providers));

  const refreshMoney = () => {
    balances.reload();
    activity.reload();
    requests.reload();
  };

  const primary = balances.data?.find((b) => b.currency === user?.defaultCurrency) ?? balances.data?.[0];
  const others = (balances.data ?? []).filter((b) => b !== primary && b.balanceMinor !== 0);
  const connectedAI = (providers.data ?? []).filter((p) => p.available && p.kind !== "demo");
  const sandbox = meta?.rails.some((r) => r.simulated);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hi, {user?.displayName.split(" ")[0]}</h1>
          <p className="muted">Here's your money, your AI tools and your portfolio at a glance.</p>
        </div>
      </div>

      {sandbox && (
        <div className="banner info">
          <Icon.Shield size={16} />
          <span>Sandbox mode: deposits and withdrawals use test money. Transfers between users work exactly as they will with real funds.</span>
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card span-2">
          <div className="row between wrap" style={{ alignItems: "flex-start" }}>
            <div>
              <div className="stat-label">{primary?.currency ?? user?.defaultCurrency} balance</div>
              <div className="stat-value" style={{ fontSize: 34 }}>
                {primary ? money(primary.balance, primary.currency) : "—"}
              </div>
              {others.length > 0 && (
                <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                  {others.map((b) => (
                    <span key={b.currency} className="pill num">{money(b.balance, b.currency)}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="row wrap">
              <button className="btn" onClick={() => setDialog("send")}><Icon.Send size={16} /> Send</button>
              <button className="btn secondary" onClick={() => setDialog("request")}>Request</button>
              <button className="btn secondary" onClick={() => setDialog("deposit")}><Icon.Plus size={16} /> Add money</button>
              <button className="btn secondary icon-btn" style={{ width: 38, height: 38 }} onClick={() => setDialog("convert")} title="Convert currency" aria-label="Convert currency">
                <Icon.Swap size={16} />
              </button>
            </div>
          </div>
          {requests.data && requests.data.length > 0 && (
            <Link to="/app/payments" className="banner" style={{ marginTop: 16, marginBottom: 0, color: "var(--text)" }}>
              <span>
                You have {requests.data.length} pending payment request{requests.data.length > 1 ? "s" : ""} — review them in Payments.
              </span>
            </Link>
          )}
        </div>

        <div className="card">
          <div className="row between">
            <div className="stat-label">Portfolio ({trading.data?.account.broker === "alpaca" ? (trading.data.account.live ? "live" : "Alpaca paper") : "paper"})</div>
            <Link to="/app/trading" className="small">Trade</Link>
          </div>
          <div className="stat-value">{trading.data ? usd(trading.data.account.equity) : "—"}</div>
          {trading.data?.account.totalReturnPct !== null && trading.data && (
            <div className="stat-sub">
              <Delta value={trading.data.account.totalReturnPct ?? 0}>{pct(trading.data.account.totalReturnPct)}</Delta> since start
            </div>
          )}
          <div className="stat-sub">{trading.data ? `${trading.data.account.positions.length} positions · ${usd(trading.data.account.cash)} cash` : ""}</div>
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card span-2">
          <div className="card-head">
            <h2>Recent activity</h2>
            <Link to="/app/wallet" className="small">See all</Link>
          </div>
          {activity.data ? <ActivityList items={activity.data} compact /> : <div className="skeleton" style={{ height: 120 }} />}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Watchlist</h2>
              <Link to="/app/trading" className="small">Open</Link>
            </div>
            {(watch.data ?? []).map((w) => (
              <Link to={`/app/trading?symbol=${encodeURIComponent(w.symbol)}`} key={w.symbol} className="ticker-row" style={{ textDecoration: "none" }}>
                <div>
                  <div style={{ fontWeight: 650 }}>{w.symbol}</div>
                  <div className="faint xs num">{usd(w.quote!.price)}</div>
                </div>
                <Delta value={w.quote!.changePct}>{pct(w.quote!.changePct)}</Delta>
                <Sparkline values={w.closes} label={`${w.symbol} 30-day trend`} />
              </Link>
            ))}
            {!watch.data && <div className="skeleton" style={{ height: 120 }} />}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>AI Hub</h2>
              <Link to="/app/ai" className="small">Open</Link>
            </div>
            <p className="muted small">
              {connectedAI.length > 0
                ? `Connected: ${connectedAI.map((p) => p.name).join(", ")}.`
                : "No AI providers connected yet. The demo assistant works offline; add a key to unlock Claude, GPT, Gemini and more."}
            </p>
            <div className="row wrap" style={{ marginTop: 12 }}>
              <Link className="btn sm" to="/app/ai"><Icon.Sparkle size={14} /> Start a chat</Link>
              {connectedAI.length === 0 && <Link className="btn sm secondary" to="/app/settings#ai-keys">Add API key</Link>}
            </div>
          </div>
        </div>
      </div>

      {dialog === "send" && <SendDialog onClose={() => setDialog(null)} onDone={refreshMoney} />}
      {dialog === "request" && <RequestDialog onClose={() => setDialog(null)} onDone={refreshMoney} />}
      {dialog === "deposit" && <DepositDialog onClose={() => setDialog(null)} onDone={refreshMoney} />}
      {dialog === "convert" && <ConvertDialog onClose={() => setDialog(null)} onDone={refreshMoney} />}
    </>
  );
}
