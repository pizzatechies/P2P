import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorText, Field } from "../components/ui";
import { timeAgo } from "../format";
import { useLegalInfo } from "../site/Legal";
import { useLoad, useToast } from "../state";

export interface SupportCase {
  id: string;
  reference: string;
  category: string;
  categoryLabel: string;
  complaint: boolean;
  priority: "normal" | "high";
  subject: string;
  status: "open" | "waiting_customer" | "resolved";
  resolution: string | null;
  outcome: string | null;
  dueAt: string | null;
  overdue: boolean;
  redress?: { amount: string; currency: string } | null;
  referral?: { to: string | null; on: string } | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
export interface SupportMessage { id: number; from: "customer" | "staff" | "system"; author: string; internal: boolean; body: string; createdAt: string }

const CATEGORIES: [string, string][] = [
  ["question", "A question"],
  ["payment", "A payment"],
  ["account", "My account"],
  ["security", "Security or fraud"],
  ["complaint", "A complaint"],
  ["other", "Something else"],
];

export const STATUS_LABEL: Record<SupportCase["status"], string> = { open: "With our team", waiting_customer: "Replied", resolved: "Resolved" };
export const statusPill = (s: SupportCase["status"]) => (s === "resolved" ? "good" : s === "waiting_customer" ? "brand" : "warn");
export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Help: contact details, a new request, and the customer's cases with their replies. */
export function HelpPage() {
  const [params, setParams] = useSearchParams();
  const open = params.get("case");
  const cases = useLoad(() => api.get<{ cases: SupportCase[] }>("/api/support/cases").then((r) => r.cases));
  const info = useLegalInfo();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Help</h1>
          <p className="muted">Ask a question, report a problem or make a complaint. Every request gets a reference number.</p>
        </div>
      </div>
      <div className="banner">
        <span className="small">
          <strong>Aurex will never ask for your password, two-factor codes or recovery codes</strong>, by email, phone or here. If you think someone else is in your account, change your password and sign out other devices under <Link to="/app/settings">Settings</Link>, then tell us under "Security or fraud".
        </span>
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack">
          {open ? (
            <CaseThread id={open} onBack={() => setParams({})} onChange={cases.reload} />
          ) : (
            <NewCase onOpened={(id) => { cases.reload(); setParams({ case: id }); }} />
          )}
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Your requests</h2></div>
            {!cases.data ? (
              <p className="muted small">Loading…</p>
            ) : cases.data.length === 0 ? (
              <Empty>No requests yet.</Empty>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {cases.data.map((c) => (
                  <button key={c.id} className={`case-row${open === c.id ? " active" : ""}`} onClick={() => setParams({ case: c.id })}>
                    <div className="row between" style={{ gap: 8 }}>
                      <strong className="small">{c.subject}</strong>
                      <span className={`pill ${statusPill(c.status)}`}>{STATUS_LABEL[c.status]}</span>
                    </div>
                    <div className="faint xs">
                      {c.reference} · {c.complaint ? "Complaint" : c.categoryLabel} · updated {timeAgo(c.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Other ways to reach us</h2></div>
            <div className="small stack" style={{ gap: 6 }}>
              {info?.contact.supportEmail && <div>Email: <a href={`mailto:${info.contact.supportEmail}`}>{info.contact.supportEmail}</a></div>}
              {info?.contact.supportPhone && <div>Phone: {info.contact.supportPhone}</div>}
              <div className="muted">
                How we handle complaints, and where to go if you're not satisfied: <Link to="/complaints">Complaints policy</Link>. Our <Link to="/fees">fees and limits</Link>.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewCase({ onOpened }: { onOpened: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ category: "question", subject: "", message: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ case: SupportCase }>("/api/support/cases", f);
      toast(`Sent. Your reference is ${r.case.reference}`);
      setF({ category: "question", subject: "", message: "" });
      onOpened(r.case.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="card-head"><h2>New request</h2></div>
      <Field label="What is it about?">
        <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      {f.category === "complaint" && (
        <p className="small muted" style={{ margin: 0 }}>
          We'll acknowledge your complaint straight away, and someone who wasn't involved will give you a written answer within 15 business days. <Link to="/complaints">How we handle complaints</Link>.
        </p>
      )}
      <Field label="Subject">
        <input className="input" required minLength={3} maxLength={120} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="For example: deposit not showing" />
      </Field>
      <Field label="Tell us what happened" hint="Include dates, amounts and references if it's about a payment. Don't include passwords or codes.">
        <textarea className="input" required minLength={2} maxLength={5000} rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
      </Field>
      <ErrorText error={error} />
      <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
    </form>
  );
}

function CaseThread({ id, onBack, onChange }: { id: string; onBack: () => void; onChange: () => void }) {
  const toast = useToast();
  const data = useLoad(() => api.get<{ case: SupportCase; messages: SupportMessage[] }>(`/api/support/cases/${id}`), [id]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = data.data;
  if (data.error) return <div className="card"><ErrorText error={data.error} /><button className="btn ghost sm" onClick={onBack}>Back</button></div>;
  if (!d) return <div className="card muted small">Loading…</div>;
  const c = d.case;

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      data.setData(await api.post(`/api/support/cases/${id}/messages`, { body: reply }));
      setReply("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function escalate() {
    if (!confirm("Make this a formal complaint? We'll give you a written answer within 15 business days.")) return;
    try {
      data.setData(await api.post(`/api/support/cases/${id}/complaint`));
      toast("It's now a formal complaint");
      onChange();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="card stack">
      <div className="card-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{c.subject}</h2>
          <div className="faint xs">{c.reference} · {c.complaint ? "Formal complaint" : c.categoryLabel} · opened {day(c.createdAt)}</div>
        </div>
        <span className={`pill ${statusPill(c.status)}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      {c.complaint && c.dueAt && c.status !== "resolved" && <p className="small muted" style={{ margin: 0 }}>Our written answer is due by {day(c.dueAt)}.</p>}
      <div className="thread">
        {d.messages.map((m) => (
          <div key={m.id} className={`msg ${m.from}`}>
            <div className="faint xs">{m.author} · {timeAgo(m.createdAt)}</div>
            <div className="msg-body">{m.body}</div>
          </div>
        ))}
      </div>
      <form className="stack" onSubmit={send}>
        <Field label={c.status === "resolved" ? "Need more help? Reply to reopen" : "Reply"}>
          <textarea className="input" rows={3} required minLength={2} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send reply"}</button>
          <button type="button" className="btn ghost" onClick={onBack}>New request</button>
          {!c.complaint && <button type="button" className="btn ghost" onClick={escalate}>Not happy? Make it a complaint</button>}
        </div>
      </form>
    </div>
  );
}
