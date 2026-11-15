import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorText } from "../components/ui";
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
  createdAt: string;
}

export function AdminPage() {
  const { user } = useAuth();
  const toast = useToast();
  const overview = useLoad(() => api.get<Overview>("/api/admin/overview"));
  const users = useLoad(() => api.get<{ users: AdminUser[] }>("/api/admin/users").then((r) => r.users));
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
      {!overview.error && <UpgradeQueue />}
      <div className="card flush">
        <div className="card-head"><h2>Users</h2></div>
        <div className="table-wrap" style={{ padding: "0 8px 8px" }}>
          <table className="table">
            <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Joined</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.displayName}</strong> <span className="faint">@{u.handle}</span></td>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td className="faint">{timeAgo(u.createdAt)}</td>
                  <td><span className={`pill ${u.status === "active" ? "good" : "bad"}`}>{u.status}</span></td>
                  <td className="r">
                    {u.id !== user.id && (
                      <button className="btn ghost sm" onClick={() => setStatus(u.id, u.status === "active" ? "frozen" : "active")}>
                        {u.status === "active" ? "Freeze" : "Unfreeze"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
