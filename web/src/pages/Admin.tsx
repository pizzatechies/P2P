import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
import { ErrorText } from "../components/ui";
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
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="stat-label">Ledger integrity</div>
            <div className={`stat-value ${o.ledger.ok ? "good" : "bad"}`}>{o.ledger.ok ? "✓ Balanced" : "✗ Mismatch"}</div>
            <div className="stat-sub">{o.journals.toLocaleString()} journals · {o.users} users</div>
          </div>
          <div className="card">
            <div className="stat-label">Customer funds held</div>
            {o.customerFunds.length === 0 && <div className="stat-sub">None yet</div>}
            {o.customerFunds.map((c) => (
              <div key={c.currency} className="num" style={{ fontWeight: 600 }}>{money(c.total, c.currency)}</div>
            ))}
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
