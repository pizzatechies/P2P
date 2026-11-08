import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorText } from "../components/ui";
import { money, timeAgo } from "../format";
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
      <ErrorText error={overview.error} />
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
