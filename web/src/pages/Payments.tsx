import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { ActivityList, RequestDialog, SendDialog } from "../components/money";
import { PayLinkCard } from "../components/share";
import { Empty, StatusPill } from "../components/ui";
import { money, timeAgo } from "../format";
import { useLoad, useToast } from "../state";
import type { Activity, PaymentRequest } from "../types";

export function PaymentsPage() {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | "send" | "request">(null);
  const [sendTo, setSendTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const requests = useLoad(() => api.get<{ incoming: PaymentRequest[]; outgoing: PaymentRequest[] }>("/api/payments/requests"));
  const transfers = useLoad(() =>
    api.get<{ items: Activity[] }>("/api/payments/activity?limit=50").then((r) => r.items.filter((a) => a.kind === "transfer")),
  );

  const refresh = () => {
    requests.reload();
    transfers.reload();
  };

  async function act(id: string, action: "pay" | "decline" | "cancel") {
    setBusy(id + action);
    try {
      await api.post(`/api/payments/requests/${id}/${action}`);
      toast(action === "pay" ? "Request paid" : action === "decline" ? "Request declined" : "Request canceled");
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  // Frequent contacts from recent transfers, for one-tap sending.
  const contacts = Array.from(
    new Map((transfers.data ?? []).filter((t) => t.counterparty).map((t) => [t.counterparty!.id, t.counterparty!])).values(),
  ).slice(0, 6);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="muted">Send to anyone by @handle or email, and settle up with requests.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => { setSendTo(""); setDialog("send"); }}><Icon.Send size={16} /> Send money</button>
          <button className="btn secondary" onClick={() => setDialog("request")}>Request money</button>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <PayLinkCard />
      </div>

      {contacts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Send again</h2></div>
          <div className="row wrap">
            {contacts.map((c) => (
              <button key={c.id} className="btn secondary sm" onClick={() => { setSendTo(`@${c.handle}`); setDialog("send"); }}>
                {c.displayName} <span className="faint">@{c.handle}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><h2>Requests to you</h2></div>
          {requests.data?.incoming.length === 0 && <Empty>No one has asked you for money.</Empty>}
          <div className="list">
            {(requests.data?.incoming ?? []).map((r) => (
              <div className="list-item" key={r.id}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{r.requester.displayName} <span className="faint small">@{r.requester.handle}</span></div>
                  <div className="faint small">{r.memo ? `${r.memo} · ` : ""}{timeAgo(r.createdAt)}</div>
                </div>
                <strong className="num">{money(r.amount, r.currency)}</strong>
                {r.status === "pending" ? (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" disabled={!!busy} onClick={() => act(r.id, "pay")}>Pay</button>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => act(r.id, "decline")}>Decline</button>
                  </div>
                ) : (
                  <StatusPill status={r.status} />
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Your requests</h2></div>
          {requests.data?.outgoing.length === 0 && <Empty>You haven't requested money yet.</Empty>}
          <div className="list">
            {(requests.data?.outgoing ?? []).map((r) => (
              <div className="list-item" key={r.id}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{r.payer.displayName} <span className="faint small">@{r.payer.handle}</span></div>
                  <div className="faint small">{r.memo ? `${r.memo} · ` : ""}{timeAgo(r.createdAt)}</div>
                </div>
                <strong className="num">{money(r.amount, r.currency)}</strong>
                {r.status === "pending" ? (
                  <button className="btn sm ghost" disabled={!!busy} onClick={() => act(r.id, "cancel")}>Cancel</button>
                ) : (
                  <StatusPill status={r.status} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Transfers</h2></div>
        {transfers.data ? <ActivityList items={transfers.data} /> : <div className="skeleton" style={{ height: 160 }} />}
      </div>

      {dialog === "send" && <SendDialog initialTo={sendTo} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "request" && <RequestDialog onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}
