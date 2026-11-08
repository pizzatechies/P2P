import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { ActivityList, ConvertDialog, DepositDialog, WithdrawDialog } from "../components/money";
import { Empty, StatusPill } from "../components/ui";
import { money, timeAgo } from "../format";
import { useAuth, useLoad, useToast } from "../state";
import type { Activity, Balance } from "../types";

interface ExternalTransfer {
  id: string;
  direction: "deposit" | "withdrawal";
  rail: string;
  currency: string;
  amount: string;
  fee: string;
  status: string;
  failureReason: string | null;
  destination: { type: string; name: string; accountLast4: string } | null;
  createdAt: string;
}

export function WalletPage() {
  const { meta } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<null | "deposit" | "withdraw" | "convert">(null);
  const balances = useLoad(() => api.get<{ balances: Balance[] }>("/api/payments/balances").then((r) => r.balances));
  const transfers = useLoad(() => api.get<{ transfers: ExternalTransfer[] }>("/api/payments/transfers").then((r) => r.transfers));
  const [items, setItems] = useState<Activity[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  async function loadActivity(reset = true) {
    const r = await api.get<{ items: Activity[]; nextCursor: number | null }>(
      `/api/payments/activity?limit=25${!reset && cursor ? `&before=${cursor}` : ""}`,
    );
    setItems((prev) => (reset || !prev ? r.items : [...prev, ...r.items]));
    setCursor(r.nextCursor);
  }

  useEffect(() => {
    loadActivity();
    const status = params.get("deposit");
    if (status === "success") toast("Payment received. Your wallet updates as soon as the provider confirms it.");
    if (status === "canceled") toast("Checkout canceled. No money was taken.", "error");
    if (status) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    balances.reload();
    transfers.reload();
    loadActivity();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Wallet</h1>
          <p className="muted">Balances in every currency you hold, plus money in and out.</p>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setDialog("deposit")}><Icon.Plus size={16} /> Add money</button>
          <button className="btn secondary" onClick={() => setDialog("withdraw")}><Icon.Bank size={16} /> Withdraw</button>
          <button className="btn secondary" onClick={() => setDialog("convert")}><Icon.Swap size={16} /> Convert</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {(balances.data ?? []).map((b) => (
          <div className="card" key={b.currency}>
            <div className="stat-label">{meta?.currencies.find((c) => c.code === b.currency)?.name ?? b.currency}</div>
            <div className="stat-value">{money(b.balance, b.currency)}</div>
          </div>
        ))}
        {!balances.data && <div className="card skeleton" style={{ height: 92 }} />}
      </div>

      <div className="grid grid-3">
        <div className="card span-2">
          <div className="card-head"><h2>All activity</h2></div>
          {items ? <ActivityList items={items} /> : <div className="skeleton" style={{ height: 200 }} />}
          {cursor && (
            <button className="btn secondary block" style={{ marginTop: 12 }} onClick={() => loadActivity(false)}>
              Load more
            </button>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h2>Deposits & withdrawals</h2></div>
          {transfers.data && transfers.data.length === 0 && <Empty>Nothing here yet.</Empty>}
          <div className="list">
            {(transfers.data ?? []).map((t) => (
              <div className="list-item" key={t.id} style={{ alignItems: "flex-start" }}>
                <span className={`tx-icon ${t.direction === "deposit" ? "in" : "out"}`}>
                  {t.direction === "deposit" ? <Icon.ArrowDown size={16} /> : <Icon.ArrowUp size={16} />}
                </span>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>
                    {t.direction === "deposit" ? "Deposit" : `To ${t.destination?.name ?? "account"} ••${t.destination?.accountLast4 ?? ""}`}
                  </div>
                  <div className="faint small">{t.rail} · {timeAgo(t.createdAt)}</div>
                  {t.failureReason && <div className="error-text">{t.failureReason}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="num" style={{ fontWeight: 600 }}>{money(t.amount, t.currency)}</div>
                  <StatusPill status={t.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {dialog === "deposit" && <DepositDialog onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "withdraw" && <WithdrawDialog onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "convert" && <ConvertDialog onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}
