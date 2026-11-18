import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
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
  createdAt: string;
  user: { id: string; handle?: string; email?: string; accountNumber?: string | null };
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
      {!overview.error && <KycQueue />}
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
        </div>
      </div>
      {a.status !== "cleared" && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn secondary sm" onClick={() => review("clear")}>Clear</button>
          {a.status === "open" && <button className="btn ghost sm" onClick={() => review("escalate")}>Escalate</button>}
        </div>
      )}
    </div>
  );
}

/** Transaction-monitoring alerts waiting for a look. */
function ComplianceQueue({ onChange }: { onChange: () => void }) {
  const list = useLoad(() => api.get<{ alerts: ComplianceAlert[] }>("/api/admin/compliance").then((r) => r.alerts));
  if (!list.data || list.data.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>Monitoring alerts</h2><span className="faint small">{list.data.length} open</span></div>
      <p className="muted small" style={{ marginTop: 0 }}>Patterns worth a look. Customers never see these. Withdrawals from a customer with an open medium or high alert wait for review.</p>
      <div className="stack">
        {list.data.map((a) => (
          <ComplianceAlertRow key={a.id} a={a} onReviewed={() => { list.reload(); onChange(); }} />
        ))}
      </div>
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
  lists: { list: string; name: string; entries: number; fetchedAt: string | null; error: string | null }[];
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
        Customers are screened on their legal name and date of birth, and on their sign-up name; payout recipients before money is sent; and everyone again when the lists change (checked daily).
        A possible match pauses that customer's payments until someone clears it under Monitoring alerts.
      </p>
      {d && !d.enabled && <div className="banner">Sanctions screening is switched off (SANCTIONS_SCREENING=false).</div>}
      <div className="stack-sm">
        {(d?.lists ?? []).map((l) => (
          <div key={l.list} className="row between wrap small" style={{ gap: 8 }}>
            <span><strong>{l.name}</strong></span>
            <span className={l.entries ? (l.error ? "warn-text" : "muted") : "bad"}>
              {l.entries ? `${l.entries.toLocaleString()} entries · updated ${l.fetchedAt ? timeAgo(l.fetchedAt) : "—"}` : "Not downloaded yet"}
              {l.error ? ` · last attempt failed: ${l.error}` : ""}
            </span>
          </div>
        ))}
        {d && <div className="faint xs">{d.checks.toLocaleString()} screenings so far · {d.possibleMatches} possible matches · {d.openMatches} open</div>}
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
