import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api, downloadFile } from "../api";
import { ErrorText, Field } from "../components/ui";
import { COUNTRIES } from "../countries";
import { money, timeAgo } from "../format";
import { Icon } from "../components/icons";
import { useAuth, useLoad, useToast } from "../state";

interface Overview {
  users: number;
  journals: number;
  systemAccounts: { code: string; currency: string; balance: string }[];
  customerFunds: { currency: string; total: string }[];
  ledger: { ok: boolean; unbalanced: unknown[]; drift: unknown[]; totals: unknown[] };
  integrity?: { ok: boolean; journals: { checked: number; brokenAt: string | null }; audit: { checked: number; brokenAt: string | null } };
  pendingPayouts?: number;
  openAlerts?: number;
  openSupport?: number;
  safeguarding?: { currency: string; status: "covered" | "shortfall" | "unverified"; difference: string }[];
}

interface PayoutReview {
  id: string;
  rail: string;
  currency: string;
  amount: string;
  fee: string;
  createdAt: string;
  reasons: string[];
  destinationName: string | null;
  destination: { type: string; name: string; accountLast4: string | null; country: string | null } | null;
  user: { id: string; handle: string; email: string; name: string; kycLevel: number; accountNumber: string | null; since: string };
}

export interface ComplianceAlert {
  id: string;
  rule: string;
  label: string;
  severity: "low" | "medium" | "high";
  summary: string;
  status: "open" | "cleared" | "escalated";
  reviewNote: string | null;
  reviewedAt: string | null;
  report: { decision: "report" | "no_report"; reason: string | null; reference: string | null; reportedOn: string | null; decidedAt: string | null } | null;
  notes: number;
  createdAt: string;
  user: { id: string; handle?: string; email?: string; accountNumber?: string | null };
}

interface CaseFileData {
  alert: ComplianceAlert;
  notes: { id: string; body: string; createdAt: string; author: { handle: string | null; name: string | null } }[];
  reviewedBy: { handle: string; name: string } | null;
  decidedBy: { handle: string; name: string } | null;
  canDecide: boolean;
}

/** An alert's case file: the running notes, and the decision on reporting an escalated case to the FIU. */
function CaseFile({ id, onChanged }: { id: string; onChanged: () => void }) {
  const toast = useToast();
  const file = useLoad(() => api.get<CaseFileData>(`/api/admin/compliance/${id}`), [id]);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<"report" | "no_report">("report");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [reportedOn, setReportedOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = file.data;
  if (!f) return <div className="faint small" style={{ padding: "8px 0" }}>Opening the case file…</div>;
  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      file.setData(await api.post<CaseFileData>(`/api/admin/compliance/${id}/notes`, { body: note }));
      setNote("");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function decide(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(decision === "report" ? "Record that this case was reported to the FIU? This can't be changed afterwards." : "Record that this case won't be reported, and close it? This can't be changed afterwards.")) return;
    setBusy(true);
    setError(null);
    try {
      file.setData(await api.post<CaseFileData>(`/api/admin/compliance/${id}/decision`, { decision, reason, reference: decision === "report" ? reference : undefined, reportedOn: decision === "report" ? reportedOn : undefined }));
      toast("Decision recorded");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const a = f.alert;
  return (
    <div className="stack-sm" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)", width: "100%" }}>
      <div className="xs faint">Case file · never shown to the customer · notes can't be edited or deleted</div>
      <ol className="stack-sm small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><span className="faint">{new Date(a.createdAt).toLocaleString()}</span> · Alert raised: {a.summary}</li>
        {f.notes.map((n) => (
          <li key={n.id}><span className="faint">{new Date(n.createdAt).toLocaleString()} · @{n.author.handle ?? "former admin"}</span><div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div></li>
        ))}
        {a.reviewedAt && a.status !== "open" && (
          <li><span className="faint">{new Date(a.reviewedAt).toLocaleString()} · @{f.reviewedBy?.handle ?? "admin"}</span> · {a.status === "escalated" || a.report ? "Escalated" : "Cleared"}: {a.reviewNote}</li>
        )}
        {a.report && (
          <li>
            <span className="faint">{a.report.decidedAt ? new Date(a.report.decidedAt).toLocaleString() : ""} · @{f.decidedBy?.handle ?? "admin"}</span> ·{" "}
            <strong>{a.report.decision === "report" ? `Reported to the FIU on ${a.report.reportedOn} (reference ${a.report.reference})` : "Not reported"}</strong>: {a.report.reason}
          </li>
        )}
      </ol>
      <form className="row wrap" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={addNote}>
        <textarea className="input" rows={2} style={{ flex: "1 1 280px" }} placeholder="Add a note: calls, documents asked for or received, what you found" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn secondary sm" disabled={busy || note.trim().length < 3}>Add note</button>
      </form>
      {f.canDecide && (
        <form className="stack-sm" onSubmit={decide} style={{ padding: 10, background: "var(--surface-2, rgba(0,0,0,.03))", borderRadius: 10 }}>
          <strong className="small">Reporting decision</strong>
          <div className="row wrap small" style={{ gap: 14 }}>
            <label className="row" style={{ gap: 6 }}><input type="radio" checked={decision === "report"} onChange={() => setDecision("report")} /> Reported to the FIU</label>
            <label className="row" style={{ gap: 6 }}><input type="radio" checked={decision === "no_report"} onChange={() => setDecision("no_report")} /> Not reporting (closes the case)</label>
          </div>
          {decision === "report" && (
            <div className="grid grid-2">
              <Field label="FIU reference"><input className="input" required maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="From goAML or the FIU's receipt" /></Field>
              <Field label="Filed on"><input className="input" type="date" required value={reportedOn} onChange={(e) => setReportedOn(e.target.value)} /></Field>
            </div>
          )}
          <Field label={decision === "report" ? "Why it was reported" : "Why it isn't suspicious"}>
            <textarea className="input" rows={3} required minLength={20} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorText error={error} />
          <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={busy}>Record decision</button>
        </form>
      )}
    </div>
  );
}

interface AdminUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  role: string;
  status: string;
  kycLevel: number;
  accountNumber: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface KycSubmission {
  id: string;
  level: 1 | 2;
  status: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  user: { id: string; email: string; handle: string; displayName: string; kycLevel: number };
  data: Record<string, unknown> | null;
  documents: { kind: string; label: string; id: string | null; mime: string | null; size: number | null; uploadedAt: string | null }[];
  check?: { provider: string; status: string | null; result: { status?: string; product?: string | null; faceMatch?: boolean | null; liveness?: boolean | null; reason?: string | null; message?: string | null; nameMatch?: number | null; dobMatch?: boolean | null; recordName?: string | null; recordDob?: string | null } | null } | null;
  selfieCheck?: { status: string; result: { matched?: boolean | null; reason?: string | null; message?: string | null } | null } | null;
}

export function AdminPage() {
  const { user } = useAuth();
  const toast = useToast();
  const overview = useLoad(() => api.get<Overview>("/api/admin/overview"));
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const users = useLoad(() => api.get<{ users: AdminUser[] }>(`/api/admin/users${search ? `?q=${encodeURIComponent(search)}` : ""}`).then((r) => r.users), [search]);
  if (user?.role !== "admin") return <Navigate to="/app" replace />;

  async function setStatus(id: string, status: "active" | "frozen") {
    try {
      await api.post(`/api/admin/users/${id}/status`, { status });
      users.reload();
      toast(status === "frozen" ? "Account frozen" : "Account reactivated");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const o = overview.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="muted">Ledger health, customer funds and accounts.</p>
        </div>
        <Link className="btn secondary sm" to="/app/admin/support">Support{overview.data?.openSupport ? ` (${overview.data.openSupport})` : ""}</Link>
        <Link className="btn secondary sm" to="/app/admin/ledger">Ledger &amp; records</Link>
      </div>
      {overview.error && /two-factor/i.test(overview.error) ? (
        <div className="banner">
          <Icon.Shield size={16} />
          <span className="grow">Admin tools require two-factor authentication. Turn it on in Settings, then come back.</span>
          <Link className="btn sm" to="/app/settings#two-factor">Turn on 2FA</Link>
        </div>
      ) : (
        <ErrorText error={overview.error} />
      )}
      {o && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="stat-label">Ledger integrity</div>
            <div className={`stat-value ${o.ledger.ok ? "good" : "bad"}`}>{o.ledger.ok ? "✓ Balanced" : "✗ Mismatch"}</div>
            <div className="stat-sub">{o.journals.toLocaleString()} journals · {o.users} users</div>
            {o.integrity && (
              <div className={`small ${o.integrity.ok ? "good" : "bad"}`} style={{ marginTop: 4 }}>
                {o.integrity.ok ? "✓ Seals intact (books and audit log)" : `✗ Broken seal at ${o.integrity.journals.brokenAt ?? `audit event ${o.integrity.audit.brokenAt}`}`}
              </div>
            )}
          </div>
          <div className="card">
            <div className="stat-label">Customer funds held</div>
            {o.customerFunds.length === 0 && <div className="stat-sub">None yet</div>}
            {o.customerFunds.map((c) => (
              <div key={c.currency} className="num" style={{ fontWeight: 600 }}>{money(c.total, c.currency)}</div>
            ))}
          </div>
          <div className="card">
            <div className="stat-label">Customers' money held</div>
            {(o.safeguarding ?? []).length === 0 && <div className="stat-sub">No safeguarding accounts recorded</div>}
            {(o.safeguarding ?? []).map((s) => (
              <div key={s.currency} className="row between small">
                <span className="muted">{s.currency}</span>
                <span className={s.status === "covered" ? "good" : s.status === "shortfall" ? "bad" : "muted"}>
                  {s.status === "covered" ? "✓ Covered" : s.status === "shortfall" ? `✗ Short ${money(s.difference.replace("-", ""), s.currency)}` : "Not verified"}
                </span>
              </div>
            ))}
            <Link to="/app/admin/ledger?tab=safeguarding" className="small">Safeguarding →</Link>
          </div>
          <div className="card">
            <div className="stat-label">System accounts</div>
            {o.systemAccounts.map((a) => (
              <div key={a.code + a.currency} className="row between small">
                <span className="muted">{a.code} · {a.currency}</span>
                <span className="num">{money(a.balance, a.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!overview.error && <SecurityChecklist />}
      {!overview.error && <BetaCard />}
      {!overview.error && <PayoutQueue onChange={overview.reload} />}
      {!overview.error && <ComplianceQueue onChange={overview.reload} />}
      {!overview.error && <SanctionsCard />}
      {!overview.error && <PepCard />}
      {!overview.error && <KycQueue />}
      {!overview.error && <ApprovalQueue />}
      {!overview.error && <BusinessQueue />}
      {!overview.error && <UpgradeQueue />}
      <div className="card flush">
        <div className="card-head">
          <h2>Customers</h2>
          <input
            className="input"
            style={{ height: 34, maxWidth: 320 }}
            placeholder="Search name, @handle, email or account number"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search customers"
          />
        </div>
        <div className="table-wrap" style={{ padding: "0 8px 8px" }}>
          <table className="table">
            <thead><tr><th>Customer</th><th className="hide-sm">Account</th><th>Level</th><th className="hide-sm">Joined</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => {
                const status = u.closedAt ? "closed" : u.status;
                return (
                  <tr key={u.id} onClick={() => navigate(`/app/admin/users/${u.id}`)} style={{ cursor: "pointer" }}>
                    <td>
                      <strong>{u.displayName}</strong> <span className="faint">@{u.handle}</span>
                      <div className="faint xs">{u.email}{u.role === "admin" ? " · admin" : ""}</div>
                    </td>
                    <td className="mono small hide-sm">{u.accountNumber ?? "—"}</td>
                    <td><span className={`pill ${u.kycLevel >= 1 ? "good" : ""}`}>{["Basic", "Verified", "Enhanced"][u.kycLevel] ?? u.kycLevel}</span></td>
                    <td className="faint hide-sm">{timeAgo(u.createdAt)}</td>
                    <td><span className={`pill ${status === "active" ? "good" : "bad"}`}>{status}</span></td>
                    <td className="r" onClick={(e) => e.stopPropagation()}>
                      {u.id !== user.id && !u.closedAt && (
                        <button className="btn ghost sm" onClick={() => setStatus(u.id, u.status === "active" ? "frozen" : "active")}>
                          {u.status === "active" ? "Freeze" : "Unfreeze"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {users.data?.length === 0 && <p className="muted small" style={{ padding: "0 8px" }}>No customers match.</p>}
        </div>
      </div>
    </>
  );
}

interface Application {
  userId: string;
  handle: string;
  email: string;
  status: string;
  submittedAt: string | null;
  legalName: string | null;
  age: number | null;
  country: string | null;
  experience: string | null;
  objective: string | null;
  riskTolerance: string | null;
  annualIncome: string | null;
  liquidNetWorth: string | null;
  sourceOfFunds: string | null;
  assessment: { result: string; warnings: string[] } | null;
  emailVerified: boolean;
  twoFactor: boolean;
  lessonsPassed: number;
  demoTrades: number;
}

const human = (v: string | null) => (v ?? "—").replace(/_/g, " ").replace(/^under /, "< ").replace(/^over /, "> ");

/** Real-account applications waiting for a decision. */
function UpgradeQueue() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ applications: Application[] }>("/api/admin/upgrades").then((r) => r.applications));
  async function review(a: Application, decision: "approve" | "reject") {
    const note = decision === "reject" ? prompt("Reason shown to the applicant (optional):") ?? undefined : undefined;
    try {
      list.setData((await api.post<{ applications: Application[] }>(`/api/admin/upgrades/${a.userId}/review`, { decision, note })).applications);
      toast(decision === "approve" ? `Approved @${a.handle}` : `Declined @${a.handle}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Real-account applications</h2><span className="faint small">{list.data?.length ?? 0} waiting</span></div>
      {list.data?.length === 0 && <p className="muted small">No applications waiting for review.</p>}
      <div className="stack">
        {(list.data ?? []).map((a) => (
          <div key={a.userId} className="card" style={{ boxShadow: "none", background: "var(--surface-2)" }}>
            <div className="row between wrap">
              <div>
                <strong>{a.legalName}</strong> <span className="faint">@{a.handle} · {a.email}</span>
                <div className="faint xs">Age {a.age ?? "—"} · {a.country} · submitted {a.submittedAt ? timeAgo(a.submittedAt) : "—"}</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => review(a, "approve")}>Approve</button>
                <button className="btn ghost sm" onClick={() => review(a, "reject")}>Decline</button>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
              <span className={`pill ${a.emailVerified ? "good" : "bad"}`}>Email {a.emailVerified ? "verified" : "unverified"}</span>
              <span className={`pill ${a.twoFactor ? "good" : "bad"}`}>2FA {a.twoFactor ? "on" : "off"}</span>
              <span className="pill">{a.lessonsPassed} lessons</span>
              <span className="pill">{a.demoTrades} demo trades</span>
              <span className={`pill ${a.assessment?.result === "warning" ? "warn" : "good"}`}>{a.assessment?.result === "warning" ? "Warnings acknowledged" : "Appropriate"}</span>
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>
              Experience {human(a.experience)} · goal {human(a.objective)} · risk {human(a.riskTolerance)} · income {human(a.annualIncome)} · savings {human(a.liquidNetWorth)} · funds from {human(a.sourceOfFunds)}
            </div>
            {a.assessment?.warnings.length ? <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{a.assessment.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  legalName: "Legal name",
  dateOfBirth: "Date of birth",
  nationality: "Nationality",
  phone: "Phone",
  idType: "ID type",
  idNumber: "ID number",
  idCountry: "ID issued by",
  idExpiry: "ID expires",
  occupation: "Occupation",
  employer: "Employer",
  sourceOfFunds: "Source of funds",
  sourceDetails: "Details",
  expectedMonthlyUsd: "Expected monthly",
  pep: "Politically exposed",
  pepDetails: "Public role",
  proofOfAddressDate: "Proof of address dated",
};

const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

function detailValue(key: string, v: unknown): string {
  if (key === "address" && v && typeof v === "object") {
    const a = v as Record<string, string>;
    return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country && countryName(a.country)].filter(Boolean).join(", ");
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if ((key === "nationality" || key === "idCountry") && typeof v === "string") return countryName(v);
  return human(v === null || v === undefined ? null : String(v));
}

/** One identity submission: the customer's details, their documents (opened inline) and the decision. */
export function KycSubmissionCard({ s, onReviewed }: { s: KycSubmission; onReviewed: () => void }) {
  const toast = useToast();
  async function review(decision: "approve" | "reject") {
    const note = decision === "reject" ? prompt("What should the customer fix? (shown to them)") : undefined;
    if (decision === "reject" && !note) return;
    try {
      await api.post(`/api/admin/kyc/${s.id}/review`, { decision, note: note ?? undefined });
      toast(decision === "approve" ? `Approved @${s.user.handle}` : `Sent back to @${s.user.handle}`);
      onReviewed();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className="card" style={{ boxShadow: "none", background: "var(--surface-2)" }}>
      <div className="row between wrap">
        <div>
          <strong>{s.level === 1 ? "Identity" : "Enhanced"} verification</strong>{" "}
          <Link to={`/app/admin/users/${s.user.id}`} className="faint">@{s.user.handle}</Link>
          <div className="faint xs">{s.user.email} · submitted {s.submittedAt ? timeAgo(s.submittedAt) : "—"}</div>
        </div>
        {s.status === "submitted" ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => review("approve")}>Approve</button>
            <button className="btn ghost sm" onClick={() => review("reject")}>Send back</button>
          </div>
        ) : (
          <span className={`pill ${s.status === "approved" ? "good" : s.status === "rejected" ? "bad" : ""}`}>{s.status}</span>
        )}
      </div>
      {s.reviewNote && <div className="small muted" style={{ marginTop: 6 }}>Note: {s.reviewNote}</div>}
      {s.check && <GovernmentCheck check={s.check} />}
      {s.selfieCheck && <SelfieCheck check={s.selfieCheck} />}
      {s.data && (
        <div className="kv" style={{ marginTop: 8 }}>
          {Object.entries(s.data).filter(([k, v]) => v !== "" && k !== "address").map(([k, v]) => (
            <div key={k}><span>{FIELD_LABELS[k] ?? k}</span><strong>{detailValue(k, v)}</strong></div>
          ))}
          {"address" in s.data && <div style={{ gridColumn: "1 / -1" }}><span>Address</span><strong>{detailValue("address", s.data.address)}</strong></div>}
        </div>
      )}
      <div className="row wrap" style={{ gap: 10, marginTop: 10 }}>
        {s.documents.map((d) =>
          d.id ? (
            <a key={d.kind} href={`/api/admin/kyc/documents/${d.id}`} target="_blank" rel="noopener" className="kyc-doc" title={`Open ${d.label}`}>
              {d.mime?.startsWith("image/") ? <img src={`/api/admin/kyc/documents/${d.id}`} alt={d.label} loading="lazy" /> : <span className="kyc-pdf">PDF</span>}
              <span className="xs">{d.label}</span>
            </a>
          ) : (
            <span key={d.kind} className="pill bad">{d.label} missing</span>
          ),
        )}
      </div>
      <p className="faint xs" style={{ margin: "8px 0 0" }}>Opening a document is recorded in the audit log.</p>
    </div>
  );
}

/** Identity submissions waiting for review. */
function KycQueue() {
  const list = useLoad(() => api.get<{ submissions: KycSubmission[] }>("/api/admin/kyc").then((r) => r.submissions));
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Identity verification</h2><span className="faint small">{list.data?.length ?? 0} waiting</span></div>
      {list.data?.length === 0 && <p className="muted small">No identity checks waiting for review.</p>}
      <div className="stack">
        {(list.data ?? []).map((s) => (
          <KycSubmissionCard key={s.id} s={s} onReviewed={list.reload} />
        ))}
      </div>
    </div>
  );
}

/** Withdrawals waiting for a second person before the money is sent. */
function PayoutQueue({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const list = useLoad(() => api.get<{ payouts: PayoutReview[] }>("/api/admin/payouts").then((r) => r.payouts));
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.data || list.data.length === 0) return null;
  async function decide(p: PayoutReview, approve: boolean) {
    const note = approve ? undefined : prompt("Why isn't it being sent? (the customer sees this)") ?? "";
    if (!approve && (!note || note.trim().length < 3)) return;
    setBusy(p.id);
    try {
      const r = await api.post<{ transfer: { status: string; failureReason: string | null } }>(`/api/admin/payouts/${p.id}/${approve ? "approve" : "reject"}`, { note });
      if (approve) toast(r.transfer.status === "failed" ? `The provider refused it: ${r.transfer.failureReason}. The money was returned.` : `Sent ${money(p.amount, p.currency)} to ${p.destinationName ?? "the customer"}`, r.transfer.status === "failed" ? "error" : undefined);
      else toast(`Returned ${money(p.amount, p.currency)} to @${p.user.handle}`);
      list.reload();
      onChange();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Withdrawals to review</h2><span className="faint small">{list.data.length} waiting</span></div>
      <p className="muted small" style={{ marginTop: 0 }}>The money is set aside. Approving sends it to the payment provider now; returning puts it back in the customer's wallet. You can't review your own.</p>
      <div className="stack">
        {list.data.map((p) => (
          <div key={p.id} className="row between wrap" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div>
              <strong className="num">{money(p.amount, p.currency)}</strong> to {p.destinationName ?? "an account"}
              {p.destination?.accountLast4 && <span className="faint"> ••{p.destination.accountLast4}</span>} via {p.rail}
              <div className="small">
                <Link to={`/app/admin/users/${p.user.id}`}>@{p.user.handle}</Link> <span className="faint">· {["Basic", "Verified", "Enhanced"][p.user.kycLevel] ?? p.user.kycLevel} · customer since {new Date(p.user.since).toLocaleDateString()}</span>
              </div>
              <div className="faint xs">{p.reasons.join(" · ")} · requested {timeAgo(p.createdAt)}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={busy === p.id} onClick={() => decide(p, true)}>Approve &amp; send</button>
              <button className="btn ghost sm" disabled={busy === p.id} onClick={() => decide(p, false)}>Return money</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SEVERITY_PILL: Record<string, string> = { high: "bad", medium: "warn", low: "" };

/** One monitoring alert, with clear / escalate. Used on the Admin page and a customer's page. */
export function ComplianceAlertRow({ a, onReviewed, showUser = true }: { a: ComplianceAlert; onReviewed: () => void; showUser?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  async function review(action: "clear" | "escalate") {
    const note = prompt(action === "clear" ? "What did you find? (kept in the audit log)" : "Why escalate? (kept in the audit log)");
    if (!note || note.trim().length < 3) return;
    const freeze = action === "escalate" && confirm("Freeze the account too? The customer will be signed out and can't move money.");
    try {
      await api.post(`/api/admin/compliance/${a.id}`, { action, note, freeze });
      toast(action === "clear" ? "Alert cleared" : freeze ? "Escalated and account frozen" : "Escalated");
      onReviewed();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className="row between wrap" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div>
        <span className={`pill ${SEVERITY_PILL[a.severity]}`}>{a.severity}</span> <strong>{a.label}</strong>
        {showUser && a.user.handle && <> · <Link to={`/app/admin/users/${a.user.id}`}>@{a.user.handle}</Link></>}
        <div className="small">{a.summary}</div>
        <div className="faint xs">
          {timeAgo(a.createdAt)}
          {a.status !== "open" && ` · ${a.status}${a.reviewNote ? `: ${a.reviewNote}` : ""}`}
          {a.report ? ` · ${a.report.decision === "report" ? `reported to the FIU (${a.report.reference})` : "not reported"}` : a.status === "escalated" ? " · reporting decision needed" : ""}
          {a.notes ? ` · ${a.notes} note${a.notes === 1 ? "" : "s"}` : ""}
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? "Hide case file" : "Case file"}</button>
        {a.status !== "cleared" && <button className="btn secondary sm" onClick={() => review("clear")}>Clear</button>}
        {a.status === "open" && <button className="btn ghost sm" onClick={() => review("escalate")}>Escalate</button>}
      </div>
      {open && <CaseFile id={a.id} onChanged={onReviewed} />}
    </div>
  );
}

/** Transaction-monitoring alerts waiting for a look, and escalated cases. */
function ComplianceQueue({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const list = useLoad(() =>
    Promise.all([api.get<{ alerts: ComplianceAlert[] }>("/api/admin/compliance"), api.get<{ alerts: ComplianceAlert[] }>("/api/admin/compliance?status=escalated")]).then(([o, e]) => ({ open: o.alerts, escalated: e.alerts })),
  );
  if (!list.data) return null;
  const { open, escalated } = list.data;
  const reload = () => { list.reload(); onChange(); };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Monitoring alerts</h2>
        <span className="row" style={{ gap: 10 }}>
          <span className="faint small">{open.length} open · {escalated.length} escalated</span>
          <button className="btn ghost sm" onClick={() => downloadFile("/api/admin/compliance/register.csv", "aurex-reporting-decisions.csv").catch((e) => toast((e as Error).message, "error"))}>Reporting register (CSV)</button>
        </span>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>Patterns worth a look. Customers never see these. Withdrawals from a customer with an open or escalated medium or high alert wait for review. Each alert has a case file for notes; escalated cases need a reporting decision.</p>
      {open.length === 0 && escalated.length === 0 && <p className="faint small" style={{ margin: 0 }}>Nothing waiting.</p>}
      <div className="stack">
        {open.map((a) => <ComplianceAlertRow key={a.id} a={a} onReviewed={reload} />)}
      </div>
      {escalated.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: "16px 0 8px" }}>Escalated cases</h3>
          <div className="stack">
            {escalated.map((a) => <ComplianceAlertRow key={a.id} a={a} onReviewed={reload} />)}
          </div>
        </>
      )}
    </div>
  );
}

interface Posture {
  score: number;
  failing: number;
  warnings: number;
  checks: { id: string; area: string; label: string; status: "pass" | "warn" | "fail"; detail: string; fix?: string }[];
}

const CHECK_ICON = { pass: "✓", warn: "!", fail: "✗" } as const;
const CHECK_CLASS = { pass: "good", warn: "warn-text", fail: "bad" } as const;

/** What's protected and what still needs doing, worst first. */
function SecurityChecklist() {
  const data = useLoad(() => api.get<Posture>("/api/admin/security"));
  const d = data.data;
  if (!d) return null;
  const open = d.checks.filter((c) => c.status !== "pass");
  const passed = d.checks.filter((c) => c.status === "pass");
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2><Icon.Shield size={16} /> Security checklist</h2>
        <span className={`pill ${d.failing ? "bad" : d.warnings ? "warn" : "good"}`}>
          {passed.length} of {d.checks.length} in place{d.failing ? ` · ${d.failing} to fix` : ""}
        </span>
      </div>
      {open.length === 0 && <p className="good small" style={{ marginTop: 0 }}>Everything on the list is in place.</p>}
      <div className="stack-sm">
        {open.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: "flex-start", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 10 }}>
            <strong className={CHECK_CLASS[c.status]} style={{ width: 16, textAlign: "center" }} aria-label={c.status}>{CHECK_ICON[c.status]}</strong>
            <div className="grow">
              <div><strong>{c.label}</strong> <span className="faint xs">{c.area}</span></div>
              <div className="small muted">{c.detail}</div>
              {c.fix && <div className="small" style={{ marginTop: 2 }}>{c.fix}</div>}
            </div>
          </div>
        ))}
      </div>
      {passed.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: "pointer" }}>{passed.length} in place</summary>
          <div className="stack-sm" style={{ marginTop: 6 }}>
            {passed.map((c) => (
              <div key={c.id} className="small"><span className="good">✓</span> <strong>{c.label}</strong> <span className="muted">· {c.detail}</span></div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

interface SanctionsStatus {
  enabled: boolean;
  lists: { list: string; downloaded: boolean; name: string; entries: number; fetchedAt: string | null; error: string | null }[];
  openMatches: number;
  checks: number;
  possibleMatches: number;
}
interface SanctionsHit {
  list: string;
  listName: string;
  ref: string;
  kind: string;
  listedName: string;
  matchedName: string;
  score: number;
  birthYears: number[];
  programs: string;
  countries: string[];
}

/** The sanctions lists in use, and a way to check a name by hand. */
function SanctionsCard() {
  const toast = useToast();
  const status = useLoad(() => api.get<SanctionsStatus>("/api/admin/sanctions"));
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [entities, setEntities] = useState(false);
  const [hits, setHits] = useState<SanctionsHit[] | null>(null);
  async function refresh() {
    setBusy(true);
    try {
      const r = await api.post<{ results: { list: string; ok: boolean; entries: number; error?: string }[]; rescreened: { customers: number; matches: number } }>("/api/admin/sanctions/refresh");
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? `Couldn't update: ${failed.map((f) => f.error).join("; ")}` : `Lists updated; ${r.rescreened.customers} customers re-screened`, failed.length ? "error" : undefined);
      status.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function uploadOwn(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8_000_000) return toast("That file is over 8 MB.", "error");
    setBusy(true);
    try {
      const r = await api.put<{ entries: number; rescreened: { customers: number; matches: number } }>("/api/admin/sanctions/own-list", { csv: await file.text() });
      toast(`Your list has ${r.entries.toLocaleString()} names; ${r.rescreened.customers} customers re-screened, ${r.rescreened.matches} possible matches`);
      status.reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function removeOwn() {
    if (!confirm("Remove your own list? Customers will no longer be screened against it. Open alerts stay open.")) return;
    try {
      await api.del("/api/admin/sanctions/own-list");
      toast("Your list was removed");
      status.reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  async function check(e: React.FormEvent) {
    e.preventDefault();
    try {
      setHits((await api.post<{ matches: SanctionsHit[] }>("/api/admin/sanctions/check", { name, birthYear: year ? Number(year) : undefined, includeEntities: entities })).matches);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  const d = status.data;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Sanctions lists</h2>
        <button className="btn secondary sm" disabled={busy} onClick={refresh}>{busy ? "Updating…" : "Update now"}</button>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Customers are screened on their legal name and date of birth, and on their sign-up name; payout recipients before money is sent; and everyone again when the lists change (checked daily). SANCTIONS_LISTS chooses the official lists.
        A possible match pauses that customer's payments until someone clears it under Monitoring alerts.
      </p>
      {d && !d.enabled && <div className="banner">Sanctions screening is switched off (SANCTIONS_SCREENING=false).</div>}
      <div className="stack-sm">
        {(d?.lists ?? []).map((l) => (
          <div key={l.list} className="row between wrap small" style={{ gap: 8 }}>
            <span><strong>{l.name}</strong></span>
            <span className={l.entries ? (l.error ? "warn-text" : "muted") : "bad"}>
              {l.entries ? `${l.entries.toLocaleString()} entries · ${l.downloaded ? "updated" : "uploaded"} ${l.fetchedAt ? timeAgo(l.fetchedAt) : "—"}` : "Not downloaded yet"}
              {l.error ? ` · last attempt failed: ${l.error}` : ""}
            </span>
          </div>
        ))}
        {d && <div className="faint xs">{d.checks.toLocaleString()} screenings so far · {d.possibleMatches} possible matches · {d.openMatches} open</div>}
      </div>
      <div className="row between wrap" style={{ gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <div className="small" style={{ flex: "1 1 260px" }}>
          <strong>Your own list</strong>
          <div className="faint xs">
            For national designations and anyone else you must screen for. Upload a CSV with a header row: <span className="mono">name</span>, and optionally <span className="mono">type</span> (individual or entity), <span className="mono">aliases</span> (separated by ;), <span className="mono">born</span>, <span className="mono">reference</span>, <span className="mono">programme</span>, <span className="mono">country</span>. A new upload replaces the old one.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className={`btn secondary sm${busy ? " disabled" : ""}`}>
            {d?.lists.some((l) => l.list === "own") ? "Replace" : "Upload CSV"}
            <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={uploadOwn} />
          </label>
          {d?.lists.some((l) => l.list === "own") && <button className="btn ghost sm" onClick={removeOwn}>Remove</button>}
        </div>
      </div>
      <form className="row wrap" style={{ gap: 8, alignItems: "flex-end", marginTop: 12 }} onSubmit={check}>
        <Field label="Check a name"><input className="input" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name or company" /></Field>
        <Field label="Year of birth"><input className="input" inputMode="numeric" style={{ width: 110 }} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Optional" /></Field>
        <label className="row small" style={{ gap: 6, marginBottom: 10 }}><input type="checkbox" checked={entities} onChange={(e) => setEntities(e.target.checked)} /> Include companies</label>
        <button className="btn sm" style={{ marginBottom: 4 }}>Check</button>
      </form>
      {hits && (hits.length === 0 ? (
        <p className="good small">No possible matches.</p>
      ) : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>Listed as</th><th>List</th><th className="hide-sm">Born</th><th className="r">Match</th></tr></thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.list + h.ref}>
                  <td><strong>{h.listedName}</strong>{h.matchedName !== h.listedName && <div className="faint xs">matched alias: {h.matchedName}</div>}<div className="faint xs">{h.kind}{h.programs ? ` · ${h.programs}` : ""}{h.countries.length ? ` · ${h.countries.join(", ")}` : ""}</div></td>
                  <td className="small">{h.listName}<div className="faint xs mono">{h.ref}</div></td>
                  <td className="hide-sm small">{h.birthYears.length ? h.birthYears.join(", ") : "—"}</td>
                  <td className="r num">{Math.round(h.score * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

interface BetaData {
  mode: "open" | "invite" | "closed";
  full: boolean;
  maxUsers: number;
  customers: number;
  invites: { id: string; hint: string; label: string | null; maxUses: number; uses: number; expiresAt: string | null; status: string; createdAt: string }[];
  waitlist: { id: string; email: string; name: string | null; createdAt: string; invitedAt: string | null; joinedAt: string | null }[];
}

const MODE_TEXT = { open: "Open: anyone can sign up", invite: "Invite-only: others join the waitlist", closed: "Closed: no new sign-ups" } as const;

/** Who can sign up: invite codes and the waitlist (REGISTRATION_MODE, MAX_USERS). */
function BetaCard() {
  const toast = useToast();
  const data = useLoad(() => api.get<BetaData>("/api/admin/beta"));
  const [label, setLabel] = useState("");
  const [uses, setUses] = useState("1");
  const [days, setDays] = useState("30");
  const [fresh, setFresh] = useState<{ code: string; link?: string; emailed?: boolean; label: string } | null>(null);
  const d = data.data;
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ code: string }>("/api/admin/beta/invites", { label: label || undefined, maxUses: Number(uses) || 1, expiresInDays: Number(days) || undefined });
      setFresh({ code: r.code, label: label || "Invite", link: `${location.origin}/register?invite=${r.code}` });
      setLabel("");
      data.reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  async function invite(id: string, who: string) {
    try {
      const r = await api.post<{ code: string; link: string; emailed: boolean }>(`/api/admin/beta/waitlist/${id}/invite`);
      setFresh({ code: r.code, link: r.link, emailed: r.emailed, label: who });
      data.reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  async function revoke(id: string) {
    if (!confirm("Revoke this invite code? Nobody else can sign up with it.")) return;
    await api.post(`/api/admin/beta/invites/${id}/revoke`).catch((e) => toast((e as Error).message, "error"));
    data.reload();
  }
  if (!d) return null;
  const waiting = d.waitlist.filter((w) => !w.invitedAt);
  return (
    <details className="card" style={{ marginBottom: 16 }} open={d.mode !== "open" && waiting.length > 0}>
      <summary style={{ cursor: "pointer" }}>
        <strong>Beta access</strong>{" "}
        <span className="faint small">· {MODE_TEXT[d.mode]} · {d.customers} customer{d.customers === 1 ? "" : "s"}{d.maxUsers ? ` of ${d.maxUsers}` : ""}{waiting.length ? ` · ${waiting.length} waiting` : ""}</span>
      </summary>
      <p className="muted small">Set REGISTRATION_MODE (open, invite or closed) and MAX_USERS in the server settings. Admin addresses can always sign up.</p>
      {fresh && (
        <div className="banner info" style={{ alignItems: "center" }}>
          <span className="grow small">
            Invite for <strong>{fresh.label}</strong>: <strong className="mono">{fresh.code}</strong>
            {fresh.emailed ? " · emailed to them" : fresh.link ? <> · share this link: <span className="mono xs">{fresh.link}</span></> : null}
            <div className="faint xs">The code is shown only now.</div>
          </span>
          <button className="btn sm secondary" onClick={() => navigator.clipboard?.writeText(fresh.link ?? fresh.code).then(() => toast("Copied"))}>Copy</button>
        </div>
      )}
      <form className="row wrap" style={{ gap: 8, alignItems: "flex-end", margin: "8px 0 12px" }} onSubmit={create}>
        <Field label="Who it's for"><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Pilot group A" /></Field>
        <Field label="Uses"><input className="input" inputMode="numeric" style={{ width: 80 }} value={uses} onChange={(e) => setUses(e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label="Expires in (days)"><input className="input" inputMode="numeric" style={{ width: 110 }} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /></Field>
        <button className="btn sm" style={{ marginBottom: 4 }}>Create invite code</button>
      </form>
      {waiting.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="table">
            <thead><tr><th>Waitlist</th><th className="hide-sm">Joined</th><th /></tr></thead>
            <tbody>
              {waiting.slice(0, 50).map((w) => (
                <tr key={w.id}>
                  <td>{w.name ?? "—"} <div className="faint xs">{w.email}</div></td>
                  <td className="hide-sm faint small">{timeAgo(w.createdAt)}</td>
                  <td className="r"><button className="btn sm secondary" onClick={() => invite(w.id, w.name ?? w.email)}>Invite</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.invites.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Invite</th><th className="r">Used</th><th>Status</th><th /></tr></thead>
            <tbody>
              {d.invites.slice(0, 50).map((i) => (
                <tr key={i.id}>
                  <td><span className="mono">{i.hint}…</span> <span className="faint small">{i.label ?? ""}</span><div className="faint xs">{i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleDateString()}` : "no expiry"}</div></td>
                  <td className="r num">{i.uses} / {i.maxUses}</td>
                  <td><span className={`pill ${i.status === "active" ? "good" : ""}`}>{i.status}</span></td>
                  <td className="r">{i.status === "active" && <button className="btn ghost sm" onClick={() => revoke(i.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

/** What the government record said (Smile ID), next to what the customer entered. */
function GovernmentCheck({ check }: { check: NonNullable<KycSubmission["check"]> }) {
  const r = check.result;
  const status = check.status ?? r?.status ?? "pending";
  const tone = status === "clear" && r?.nameMatch !== undefined && (r?.nameMatch ?? 0) >= 0.85 && r?.dobMatch !== false ? "good" : status === "pending" || status === "skipped" ? "" : "bad";
  return (
    <div className="small" style={{ marginTop: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
      <strong>Government record check</strong> <span className="faint xs">({check.provider === "smileid" ? "Smile ID" : check.provider})</span>{" "}
      <span className={`pill ${tone}`}>{status === "pending" ? "waiting for result" : status === "skipped" ? "not checked" : status}</span>
      {r?.reason && <span className="faint"> · {String(r.reason).replace(/_/g, " ")}</span>}
      {r && (r.nameMatch !== undefined && r.nameMatch !== null || r.dobMatch !== undefined && r.dobMatch !== null) && (
        <div style={{ marginTop: 4 }}>
          {r.nameMatch !== null && r.nameMatch !== undefined && <span className={r.nameMatch >= 0.85 ? "good" : "bad"}>Name {Math.round(r.nameMatch * 100)}% match</span>}
          {r.dobMatch !== null && r.dobMatch !== undefined && <span className={r.dobMatch ? "good" : "bad"}> · birth date {r.dobMatch ? "matches" : "differs"}</span>}
          {r.recordName && <div className="faint xs">On record: {r.recordName}{r.recordDob ? `, born ${r.recordDob}` : ""}</div>}
          {r.product === "biometric_kyc" && (
            <div style={{ marginTop: 2 }}>
              <span className={r.faceMatch ? "good" : r.faceMatch === false ? "bad" : "faint"}>Live selfie {r.faceMatch ? "matches" : r.faceMatch === false ? "doesn't match" : "not compared with"} the government photo</span>
              <span className={r.liveness ? "good" : r.liveness === false ? "bad" : "faint"}> · liveness {r.liveness ? "passed" : r.liveness === false ? "failed (possible spoof)" : "unknown"}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Smile ID's comparison of the selfie with the photo on the front of the ID document. */
function SelfieCheck({ check }: { check: NonNullable<KycSubmission["selfieCheck"]> }) {
  const r = check.result;
  const label =
    check.status === "pending" ? "waiting for result" : check.status === "skipped" ? "not compared" : r?.matched === true ? "same face" : r?.matched === false ? "different face" : "couldn't compare";
  const tone = r?.matched === true && check.status === "clear" ? "good" : r?.matched === false || check.status === "block" ? "bad" : "";
  return (
    <div className="small" style={{ marginTop: 6, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
      <strong>Selfie vs ID photo</strong> <span className="faint xs">(Smile ID, without a liveness check)</span> <span className={`pill ${tone}`}>{label}</span>
      {check.status === "attention" && <span className="faint"> · same face, but Smile ID flagged a risk</span>}
      {r?.reason && <span className="faint"> · {String(r.reason).replace(/_/g, " ")}</span>}
    </div>
  );
}

interface PersonReview {
  status: "invited" | "submitted";
  invitedAt: string | null;
  submittedAt: string | null;
  linkExpired: boolean;
  details: { idType: string; idNumber: string; idCountry: string; idExpiry: string; dateOfBirth: string; nationality: string } | null;
  documents: { id: string; kind: string; label: string }[];
  government: { status?: string; reason?: string | null; message?: string | null; nameMatch?: number | null; dobMatch?: boolean | null; recordName?: string | null } | null;
}
interface BusinessApplication {
  businessName: string;
  businessType: "sole_trader" | "company";
  people: { key: string; name: string; role: string; ownershipPct: number | null; dateOfBirth: string; nationality: string; isApplicant?: boolean }[];
  personChecks: Record<string, PersonReview>;
  personChecksRequired: boolean;
  documents: { id: string; kind: string; label: string; size: number }[];
  category: string;
  registrationNumber: string | null;
  country: string;
  website: string | null;
  status: string;
  createdAt: string;
  user: { id: string; handle: string; email: string; name: string; kycLevel: number };
}

/** One director's or owner's identity check: what they sent, the photos, and the government record. */
function PersonCheckLine({ person, check, applicantLevel }: { person: { dateOfBirth: string; isApplicant?: boolean }; check: PersonReview | undefined; applicantLevel: number }) {
  if (person.isApplicant) return <div className={applicantLevel >= 1 ? "good" : "warn-text"}>The applicant: covered by their own identity check (level {applicantLevel})</div>;
  if (!check) return <div className="bad">No identity check (applied before checks started): send it back so they can add an email</div>;
  if (check.status === "invited") return <div className="warn-text">Waiting for them to confirm their identity{check.linkExpired ? " (their link expired)" : check.invitedAt ? ` · link sent ${timeAgo(check.invitedAt)}` : ""}</div>;
  const d = check.details;
  const g = check.government;
  return (
    <div>
      <span className="good">Identity sent {check.submittedAt ? timeAgo(check.submittedAt) : ""}</span>
      {d && <span className="faint"> · {d.idType.replace("_", " ")} {d.idNumber} ({d.idCountry}, expires {d.idExpiry}){d.dateOfBirth !== person.dateOfBirth ? <span className="bad"> · born {d.dateOfBirth} on their ID, not {person.dateOfBirth}</span> : null}</span>}
      {check.documents.map((doc) => (
        <a key={doc.id} href={`/api/admin/businesses/person-documents/${doc.id}`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>{doc.label}</a>
      ))}
      {g && (
        <div className={g.status === "clear" && (g.nameMatch ?? 0) >= 0.85 && g.dobMatch !== false ? "good" : g.status === "pending" || g.status === "skipped" ? "faint" : "bad"}>
          Government record: {g.status === "pending" ? "checking…" : g.status === "skipped" ? `not checked (${g.reason})` : g.status === "clear" ? `ID valid${g.recordName ? ` for ${g.recordName}` : ""}${g.nameMatch != null ? ` · name ${Math.round(g.nameMatch * 100)}% match` : ""}${g.dobMatch === false ? " · different birth date" : g.dobMatch ? " · birth date matches" : ""}` : `${g.status}${g.reason ? ` (${String(g.reason).replace(/_/g, " ")})` : ""}`}
        </div>
      )}
    </div>
  );
}

/** Business account applications waiting for review (know-your-business). */
function BusinessQueue() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ applications: BusinessApplication[]; feeBps: number }>("/api/admin/businesses"));
  if (!list.data || list.data.applications.length === 0) return null;
  async function review(a: BusinessApplication, decision: "approve" | "reject") {
    const note = decision === "reject" ? prompt("What should they fix? (shown to them)") ?? "" : undefined;
    if (decision === "reject" && !note?.trim()) return;
    try {
      await api.post(`/api/admin/businesses/${a.user.id}/review`, { decision, note });
      toast(decision === "approve" ? `${a.businessName} is now a business account` : "Sent back for changes");
      list.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Business accounts to review</h2><span className="faint small">{list.data.applications.length} waiting</span></div>
      <p className="muted small" style={{ marginTop: 0 }}>Check the business exists (registration number, website, what they sell) and that the owner is who they say. For companies, check the documents name the same directors and owners, and that each person's ID photo, selfie and details agree. A company can't be approved until everyone has sent their identity check. Business names and the people listed are screened against sanctions lists automatically.</p>
      <div className="stack">
        {list.data.applications.map((a) => (
          <div key={a.user.id} className="row between wrap" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div>
              <strong>{a.businessName}</strong> <span className="faint small">· {a.businessType === "company" ? "registered company" : "sole trader"} · {a.category} · {a.country}</span>
              <div className="small">
                Owner <Link to={`/app/admin/users/${a.user.id}`}>@{a.user.handle}</Link> <span className="faint">· identity level {a.user.kycLevel}</span>
              </div>
              <div className="faint xs">
                {a.registrationNumber ? `Registration ${a.registrationNumber}` : "No registration number"}
                {a.website && <> · {/^https?:\/\//i.test(a.website) ? <a href={a.website} target="_blank" rel="noopener noreferrer nofollow">{a.website}</a> : a.website}</>} · applied {timeAgo(a.createdAt)}
              </div>
              {a.people.length > 0 && (
                <div className="xs" style={{ marginTop: 4 }}>
                  {a.people.map((p) => (
                    <div key={p.key} style={{ marginBottom: 4 }}>
                      {p.name} · {p.role === "director_owner" ? "director and owner" : p.role}{p.ownershipPct ? ` (${p.ownershipPct}%)` : ""} · born {p.dateOfBirth} · {p.nationality}
                      {a.personChecksRequired && <PersonCheckLine person={p} check={a.personChecks[p.key]} applicantLevel={a.user.kycLevel} />}
                    </div>
                  ))}
                </div>
              )}
              {a.documents.length > 0 && (
                <div className="xs" style={{ marginTop: 4 }}>
                  {a.documents.map((d) => (
                    <span key={d.id} style={{ marginRight: 10 }}>
                      <a href={`/api/admin/businesses/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{d.label}</a>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => review(a, "approve")}>Approve</button>
              <button className="btn ghost sm" onClick={() => review(a, "reject")}>Send back</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ApprovalRequest {
  id: string;
  kind: "limits" | "kyc_level";
  summary: string;
  payload: { note?: string };
  target: { id: string; handle: string | null };
  requestedBy: { id: string; handle: string | null };
  createdAt: string;
}

/** Changes another admin asked for (custom limits, hand-set identity levels) waiting for a second person. */
function ApprovalQueue() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ requests: ApprovalRequest[]; me: string }>("/api/admin/approvals"));
  if (!list.data || list.data.requests.length === 0) return null;
  const me = list.data.me;
  async function act(r: ApprovalRequest, action: "approve" | "reject" | "cancel") {
    const note = action === "reject" ? prompt("Why? (shown to the admin who asked)") ?? "" : undefined;
    if (action === "reject" && !note?.trim()) return;
    try {
      await api.post(`/api/admin/approvals/${r.id}/${action}`, note ? { note } : {});
      toast(action === "approve" ? "Approved: the change is in effect" : action === "reject" ? "Turned down" : "Request withdrawn");
      list.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Waiting for approval</h2><span className="faint small">{list.data.requests.length}</span></div>
      <p className="muted small" style={{ marginTop: 0 }}>Raising a customer's limits or setting their identity level by hand needs a second admin. Check the reason and the customer's record before approving.</p>
      <div className="stack">
        {list.data.requests.map((r) => (
          <div key={r.id} className="row between wrap" style={{ gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div>
              <div className="small">
                Set <Link to={`/app/admin/users/${r.target.id}`}>@{r.target.handle}</Link>'s {r.summary}
              </div>
              <div className="faint xs">
                Asked by @{r.requestedBy.handle} {timeAgo(r.createdAt)}{r.payload.note ? ` · "${r.payload.note}"` : ""}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {r.requestedBy.id === me ? (
                <button className="btn ghost sm" onClick={() => act(r, "cancel")}>Withdraw</button>
              ) : (
                <>
                  <button className="btn sm" onClick={() => act(r, "approve")}>Approve</button>
                  <button className="btn ghost sm" onClick={() => act(r, "reject")}>Turn down</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PepStatus { enabled: boolean; rescreenDays: number; due: number; openMatches: number; confirmed: number; checks: number; possibleMatches: number; lastCheckAt: string | null }

/** Screening for politically exposed persons (OpenSanctions): status, people due again, and a run-now button. */
function PepCard() {
  const toast = useToast();
  const status = useLoad(() => api.get<PepStatus>("/api/admin/pep"));
  const [busy, setBusy] = useState(false);
  const s = status.data;
  if (!s) return null;
  async function rescreen() {
    setBusy(true);
    try {
      const r = await api.post<{ due: number; screened: number; matches: number; failed: number }>("/api/admin/pep/rescreen");
      toast(r.failed ? `Checked ${r.screened}; ${r.failed} couldn't be checked (OpenSanctions unreachable?)` : `Checked ${r.screened} of ${r.due} due${r.matches ? `: ${r.matches} possible match${r.matches === 1 ? "" : "es"} (see Compliance)` : ", no new matches"}`);
      status.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Politically exposed persons</h2>
        <span className={`pill ${s.enabled ? "good" : "warn"}`}>{s.enabled ? "Screening on" : "Off"}</span>
      </div>
      {!s.enabled ? (
        <p className="muted small" style={{ margin: 0 }}>Set OPENSANCTIONS_API_KEY to check verified customers and company directors and owners against OpenSanctions' data on politically exposed people and their relatives and associates.</p>
      ) : (
        <>
          <div className="grid grid-3">
            <div><div className="stat-label">Checks made</div><div className="num" style={{ fontSize: 20 }}>{s.checks}</div></div>
            <div><div className="stat-label">Open possible matches</div><div className={`num ${s.openMatches ? "bad" : ""}`} style={{ fontSize: 20 }}>{s.openMatches}</div></div>
            <div><div className="stat-label">Confirmed PEPs</div><div className="num" style={{ fontSize: 20 }}>{s.confirmed}</div></div>
          </div>
          <div className="row between wrap" style={{ marginTop: 12, gap: 8 }}>
            <span className="small muted">
              {s.rescreenDays > 0 ? `Everyone is checked again every ${s.rescreenDays} days. ${s.due} due now.` : "Re-screening is off (PEP_RESCREEN_DAYS=0)."}
              {s.lastCheckAt && ` Last check ${timeAgo(s.lastCheckAt)}.`}
            </span>
            {s.rescreenDays > 0 && s.due > 0 && <button className="btn secondary sm" disabled={busy} onClick={rescreen}>{busy ? "Checking…" : "Re-screen now"}</button>}
          </div>
        </>
      )}
    </div>
  );
}
