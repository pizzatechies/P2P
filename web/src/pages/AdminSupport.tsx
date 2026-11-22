import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, downloadFile } from "../api";
import { Empty, ErrorText, Field } from "../components/ui";
import { timeAgo } from "../format";
import { useLoad, useToast } from "../state";
import { day, STATUS_LABEL, statusPill, type SupportCase, type SupportMessage } from "./Help";

type StaffCase = SupportCase & { customer: { id: string; handle: string; name: string }; assignedTo: string | null };
interface Detail {
  case: SupportCase & { assignedTo: string | null };
  customer: { id: string; handle: string; name: string; email: string; kycLevel: number; status: string };
  messages: SupportMessage[];
}
interface Report {
  received: number;
  resolved: number;
  open: number;
  overdueOpen: number;
  resolvedLate: number;
  outcomes: Record<string, number>;
  medianDaysToResolve: number | null;
  byCategory: Record<string, number>;
  withinDeadline: number;
  withinDeadlinePct: number | null;
  referred: number;
  redress: Record<string, string>;
  categories: { category: string; label: string; received: number; resolved: number; upheld: number; withinDeadline: number }[];
  months: { month: string; received: number; resolved: number; withinDeadline: number; upheld: number }[];
}

const FILTERS = [
  ["active", "Open", ""],
  ["active", "Complaints", "1"],
  ["resolved", "Resolved", ""],
  ["all", "All", ""],
] as const;
const OUTCOMES: [string, string][] = [["upheld", "Upheld"], ["partly_upheld", "Partly upheld"], ["not_upheld", "Not upheld"], ["withdrawn", "Withdrawn"]];

/** Admin → Support: the help and complaints inbox, and the complaints report. */
export function AdminSupportPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState(0);
  const [status, , complaints] = FILTERS[filter];
  const list = useLoad(() => api.get<{ cases: StaffCase[]; open: number }>(`/api/admin/support/cases?status=${status}${complaints ? "&complaints=1" : ""}`), [filter]);
  const open = params.get("case");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Support</h1>
          <p className="muted"><Link to="/app/admin">Admin</Link> · Help requests and complaints. Complaints show their deadline; overdue ones are flagged.</p>
        </div>
      </div>
      <div className="seg" role="tablist" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {FILTERS.map(([, l], i) => (
          <button key={l} role="tab" aria-selected={filter === i} className={filter === i ? "on" : ""} onClick={() => setFilter(i)}>{l}</button>
        ))}
      </div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="card">
          {!list.data ? (
            <p className="muted small">Loading…</p>
          ) : list.data.cases.length === 0 ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {list.data.cases.map((c) => (
                <button key={c.id} className={`case-row${open === c.id ? " active" : ""}`} onClick={() => setParams({ case: c.id })}>
                  <div className="row between" style={{ gap: 8 }}>
                    <strong className="small">{c.priority === "high" && <span className="pill bad" style={{ marginRight: 6 }}>Urgent</span>}{c.subject}</strong>
                    <span className={`pill ${statusPill(c.status)}`}>{c.status === "open" ? "Needs reply" : STATUS_LABEL[c.status]}</span>
                  </div>
                  <div className="faint xs">
                    {c.reference} · @{c.customer.handle} · {c.complaint ? "Complaint" : c.categoryLabel} · {timeAgo(c.updatedAt)}
                    {c.complaint && c.dueAt && c.status !== "resolved" && <span className={c.overdue ? "bad" : ""}> · due {day(c.dueAt)}{c.overdue ? " (overdue)" : ""}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="stack">
          {open ? <StaffThread id={open} onChange={list.reload} /> : <ComplaintsReport />}
        </div>
      </div>
    </div>
  );
}

function StaffThread({ id, onChange }: { id: string; onChange: () => void }) {
  const toast = useToast();
  const data = useLoad(() => api.get<Detail>(`/api/admin/support/cases/${id}`), [id]);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const [outcome, setOutcome] = useState("");
  const [redress, setRedress] = useState({ amount: "", currency: "USD" });
  const [referring, setReferring] = useState(false);
  const [referral, setReferral] = useState({ to: "", on: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = data.data;
  if (data.error) return <div className="card"><ErrorText error={data.error} /></div>;
  if (!d) return <div className="card muted small">Loading…</div>;
  const c = d.case;

  async function run(path: string, body: object, done: string) {
    setBusy(true);
    setError(null);
    try {
      data.setData(await api.post<Detail>(`/api/admin/support/cases/${id}/${path}`, body));
      toast(done);
      onChange();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (await run("messages", { body: reply, internal }, internal ? "Note saved" : "Reply sent")) setReply("");
  }
  async function resolve(e: FormEvent) {
    e.preventDefault();
    const withRedress = c.complaint && (outcome === "upheld" || outcome === "partly_upheld") && redress.amount.trim();
    if (await run("resolve", { resolution, outcome: c.complaint ? outcome : undefined, redress: withRedress ? { amount: redress.amount.trim(), currency: redress.currency.trim().toUpperCase() } : undefined }, c.complaint ? "Final answer sent" : "Resolved")) setResolving(false);
  }
  async function refer(e: FormEvent) {
    e.preventDefault();
    if (await run("referral", referral, "Referral recorded")) setReferring(false);
  }

  return (
    <div className="card stack">
      <div className="card-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{c.subject}</h2>
          <div className="faint xs">
            {c.reference} · {c.complaint ? "Formal complaint" : c.categoryLabel} · opened {day(c.createdAt)}
            {c.complaint && c.dueAt && <> · answer due {day(c.dueAt)}</>}
          </div>
        </div>
        <span className={`pill ${statusPill(c.status)}`}>{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="small">
        Customer <Link to={`/app/admin/users/${d.customer.id}`}>@{d.customer.handle}</Link> ({d.customer.name}) · identity level {d.customer.kycLevel} · {d.customer.status}
        {" · "}
        <button className="link-btn" onClick={() => run("assign", { toSelf: !c.assignedTo }, c.assignedTo ? "Unassigned" : "Assigned to you")}>{c.assignedTo ? "Unassign" : "Assign to me"}</button>
      </div>
      {c.status === "resolved" && c.resolution && (
        <div className="banner" style={{ background: "var(--good-soft)" }}>
          <span className="small">
            <strong>Resolved{c.outcome ? ` (${c.outcome.replace("_", " ")})` : ""}:</strong> {c.resolution}
            {c.redress && <> · redress {c.redress.amount} {c.redress.currency}</>}
          </span>
        </div>
      )}
      {c.complaint && (
        c.referral ? (
          <div className="small warn-text">Referred to {c.referral.to} on {c.referral.on}.</div>
        ) : referring ? (
          <form className="row wrap" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={refer}>
            <Field label="Referred to"><input className="input" required minLength={2} maxLength={120} placeholder="e.g. the central bank's consumer protection unit" value={referral.to} onChange={(e) => setReferral({ ...referral, to: e.target.value })} /></Field>
            <Field label="On"><input className="input" type="date" required value={referral.on} onChange={(e) => setReferral({ ...referral, on: e.target.value })} /></Field>
            <button className="btn secondary sm" style={{ marginBottom: 4 }} disabled={busy}>Record</button>
            <button type="button" className="btn ghost sm" style={{ marginBottom: 4 }} onClick={() => setReferring(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="link-btn small" style={{ alignSelf: "flex-start" }} onClick={() => setReferring(true)}>The customer took this to the regulator or ombudsman</button>
        )
      )}
      <div className="thread">
        {d.messages.map((m) => (
          <div key={m.id} className={`msg ${m.from}${m.internal ? " internal" : ""}`}>
            <div className="faint xs">{m.internal ? "Internal note · " : ""}{m.from === "customer" ? `@${d.customer.handle}` : m.author} · {timeAgo(m.createdAt)}</div>
            <div className="msg-body">{m.body}</div>
          </div>
        ))}
      </div>
      {!resolving ? (
        <form className="stack" onSubmit={send}>
          <Field label={internal ? "Internal note (the customer never sees it)" : "Reply to the customer"}>
            <textarea className="input" rows={3} required minLength={2} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} />
          </Field>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
          </label>
          <ErrorText error={error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" disabled={busy}>{internal ? "Save note" : "Send reply"}</button>
            {c.status !== "resolved" && <button type="button" className="btn ghost" onClick={() => setResolving(true)}>{c.complaint ? "Send final answer" : "Resolve"}</button>}
          </div>
        </form>
      ) : (
        <form className="stack" onSubmit={resolve}>
          {c.complaint && (
            <Field label="Outcome">
              <select className="input" required value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">Choose…</option>
                {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          )}
          {c.complaint && (outcome === "upheld" || outcome === "partly_upheld") && (
            <div className="row wrap" style={{ gap: 8 }}>
              <Field label="Redress paid or offered (optional)" hint="A refund or compensation, for the complaints report">
                <input className="input num" inputMode="decimal" placeholder="0.00" value={redress.amount} onChange={(e) => setRedress({ ...redress, amount: e.target.value.replace(/[^\d.]/g, "") })} />
              </Field>
              <Field label="Currency"><input className="input" maxLength={3} style={{ width: 90 }} value={redress.currency} onChange={(e) => setRedress({ ...redress, currency: e.target.value.toUpperCase() })} /></Field>
            </div>
          )}
          <Field label={c.complaint ? "Our final answer (shown to the customer, with where they can refer it)" : "Resolution (shown to the customer)"}>
            <textarea className="input" rows={4} required minLength={5} maxLength={3000} value={resolution} onChange={(e) => setResolution(e.target.value)} />
          </Field>
          <ErrorText error={error} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={busy}>{c.complaint ? "Send final answer" : "Resolve"}</button>
            <button type="button" className="btn ghost" onClick={() => setResolving(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function quarterStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
}

function ComplaintsReport() {
  const [from, setFrom] = useState(quarterStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const report = useLoad(() => api.get<{ report: Report }>(`/api/admin/support/report?from=${from}&to=${to}`).then((r) => r.report), [from, to]);
  const r = report.data;
  return (
    <div className="card stack">
      <div className="card-head"><h2>Complaints report</h2></div>
      <div className="row wrap" style={{ gap: 8 }}>
        <Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <ErrorText error={report.error} />
      {r && (
        <>
          <div className="grid grid-3">
            <div><div className="stat-label">Received</div><div className="num" style={{ fontSize: 22 }}>{r.received}</div></div>
            <div><div className="stat-label">Resolved</div><div className="num" style={{ fontSize: 22 }}>{r.resolved}</div></div>
            <div><div className="stat-label">Median days</div><div className="num" style={{ fontSize: 22 }}>{r.medianDaysToResolve ?? "–"}</div></div>
          </div>
          <div className="small">
            Upheld {r.outcomes.upheld} · partly upheld {r.outcomes.partly_upheld} · not upheld {r.outcomes.not_upheld} · withdrawn {r.outcomes.withdrawn}
          </div>
          <div className={`small ${r.overdueOpen || r.resolvedLate ? "bad" : "muted"}`}>
            {r.overdueOpen} open past the deadline · {r.resolvedLate} answered late{r.withinDeadlinePct !== null ? ` · ${r.withinDeadlinePct}% answered on time` : ""}
          </div>
          <div className="small muted">
            {r.referred} referred to the regulator or ombudsman
            {Object.keys(r.redress).length > 0 && <> · redress {Object.entries(r.redress).map(([cur, amt]) => `${amt} ${cur}`).join(", ")}</>}
          </div>
          {r.months.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Month</th><th className="r">Received</th><th className="r">Answered</th><th className="r">On time</th><th className="r">Upheld</th></tr></thead>
                <tbody>{r.months.map((m) => <tr key={m.month}><td>{m.month}</td><td className="r num">{m.received}</td><td className="r num">{m.resolved}</td><td className="r num">{m.withinDeadline}</td><td className="r num">{m.upheld}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {r.categories.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>About</th><th className="r">Received</th><th className="r">Answered</th><th className="r">On time</th><th className="r">Upheld</th></tr></thead>
                <tbody>{r.categories.map((x) => <tr key={x.category}><td>{x.label}</td><td className="r num">{x.received}</td><td className="r num">{x.resolved}</td><td className="r num">{x.withinDeadline}</td><td className="r num">{x.upheld}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <button className="btn secondary" onClick={() => downloadFile(`/api/admin/support/report?from=${from}&to=${to}&format=csv`, `aurex-complaints-${from}-to-${to}.csv`)}>
            Download the complaints log (CSV)
          </button>
        </>
      )}
      <p className="faint xs" style={{ margin: 0 }}>Pick a case on the left to read and answer it.</p>
    </div>
  );
}
