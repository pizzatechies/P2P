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
  destination: { type: string; name: string; accountLast4: string | null } | null;
  payoutReference: string | null;
  review?: "required" | "approved" | "rejected" | null;
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
    const ref = params.get("ref");
    if (status === "canceled") toast("Checkout canceled. No money was taken.", "error");
    else if (status && ref) {
      // Ask the provider (through Aurex) what actually happened; the redirect alone proves nothing.
      api
        .post<{ transfer: ExternalTransfer }>(`/api/payments/transfers/${encodeURIComponent(ref)}/refresh`)
        .then(({ transfer }) => {
          if (transfer.status === "completed") toast(`${money(transfer.amount, transfer.currency)} added to your wallet`);
          else if (transfer.status === "failed") toast("The payment didn't go through. No money was added.", "error");
          else toast("Payment received. Your wallet updates as soon as the provider confirms it.");
          refresh();
        })
        .catch(() => toast("We'll update your wallet as soon as the provider confirms the payment."));
    }
    if (status) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    balances.reload();
    transfers.reload();
    loadActivity();
  };

  async function checkTransfer(id: string) {
    try {
      const { transfer } = await api.post<{ transfer: ExternalTransfer }>(`/api/payments/transfers/${encodeURIComponent(id)}/refresh`);
      if (transfer.status === "completed") toast(transfer.direction === "deposit" ? `${money(transfer.amount, transfer.currency)} added to your wallet` : "Withdrawal completed");
      else if (transfer.status === "failed") toast(transfer.direction === "deposit" ? "The payment didn't go through. No money was added." : "The withdrawal failed and your money was returned.", "error");
      else toast("Still waiting for the provider to confirm.");
      refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

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
                    {t.direction === "deposit"
                      ? "Deposit"
                      : `To ${t.destination?.name ?? "account"}${t.destination?.accountLast4 ? ` ${t.destination.accountLast4.includes("@") ? "" : "••"}${t.destination.accountLast4}` : ""}`}
                  </div>
                  <div className="faint small">{t.rail} · {timeAgo(t.createdAt)}</div>
                  {t.payoutReference && t.status !== "failed" && (
                    <div className="small">Pickup reference <strong className="mono">{t.payoutReference}</strong></div>
                  )}
                  {t.failureReason && <div className="error-text">{t.failureReason}</div>}
                  {t.status === "pending" && t.review === "required" && (
                    <div className="faint small">We check larger withdrawals before sending them, usually within one business day. The money is set aside meanwhile.</div>
                  )}
                  {t.status === "pending" && t.rail !== "sandbox" && t.review !== "required" && (
                    <button className="btn ghost sm" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => checkTransfer(t.id)}>
                      Check status
                    </button>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="num" style={{ fontWeight: 600 }}>{money(t.amount, t.currency)}</div>
                  {t.status === "pending" && t.review === "required" ? <span className="pill warn">in review</span> : <StatusPill status={t.status} />}
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
