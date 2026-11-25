import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Logo, MAKER } from "../components/Logo";
import { Empty, ErrorText } from "../components/ui";
import { money } from "../format";
import { useLoad } from "../state";

interface Statement {
  accountNumber: string | null;
  holder: string;
  handle: string;
  currency: string;
  period: string;
  from: string;
  to: string;
  openingBalance: string;
  moneyIn: string;
  moneyOut: string;
  closingBalance: string;
  lines: { date: string; description: string; reference: string; moneyIn: string | null; moneyOut: string | null; balance: string }[];
  generatedAt: string;
}

/** A printable monthly statement: "Print / Save as PDF" uses the browser's own PDF export. */
export function StatementPage() {
  const [params] = useSearchParams();
  const period = params.get("period") ?? "";
  const currency = params.get("currency") ?? "";
  const st = useLoad(
    () => api.get<{ statement: Statement }>(`/api/account/statements/${encodeURIComponent(period)}?currency=${encodeURIComponent(currency)}`).then((r) => r.statement),
    [period, currency],
  );
  const s = st.data;
  const last = s ? new Date(new Date(s.to).getTime() - 86_400_000) : null;
  const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <div className="page-head no-print">
        <div>
          <Link to="/app/account#statements" className="small">← Account</Link>
          <h1>Statement</h1>
        </div>
        {s && (
          <div className="row" style={{ gap: 8 }}>
            <a className="btn secondary" href={`/api/account/statements/${s.period}?currency=${s.currency}&format=csv`}>Download CSV</a>
            <button className="btn" onClick={() => window.print()}>Print / Save as PDF</button>
          </div>
        )}
      </div>
      <ErrorText error={st.error} />
      {!s ? (
        !st.error && <div className="skeleton" style={{ height: 400 }} />
      ) : (
        <div className="card statement">
          <div className="row between wrap" style={{ alignItems: "flex-start", marginBottom: 16 }}>
            <div className="row" style={{ gap: 10 }}>
              <Logo size={36} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>Aurex</div>
                <div className="faint xs">by {MAKER} · Account statement</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 650 }}>{s.holder}</div>
              <div className="small muted">Account {s.accountNumber} · {s.currency}</div>
              <div className="small muted">{fmtDate(s.from)} – {fmtDate(last!)}</div>
            </div>
          </div>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div><div className="stat-label">Opening balance</div><div className="num" style={{ fontWeight: 650 }}>{money(s.openingBalance, s.currency)}</div></div>
            <div><div className="stat-label">Money in</div><div className="num good" style={{ fontWeight: 650 }}>{money(s.moneyIn, s.currency)}</div></div>
            <div><div className="stat-label">Money out</div><div className="num" style={{ fontWeight: 650 }}>{money(s.moneyOut, s.currency)}</div></div>
            <div><div className="stat-label">Closing balance</div><div className="num" style={{ fontWeight: 750 }}>{money(s.closingBalance, s.currency)}</div></div>
          </div>
          {s.lines.length === 0 ? (
            <Empty>No transactions in this period.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Date</th><th>Description</th><th className="r">Money in</th><th className="r">Money out</th><th className="r">Balance</th></tr>
                </thead>
                <tbody>
                  {s.lines.map((l) => (
                    <tr key={l.reference + l.date}>
                      <td className="nowrap">{fmtDate(l.date)}</td>
                      <td>
                        {l.description}
                        <div className="faint xs mono">{l.reference}</div>
                      </td>
                      <td className="r num good">{l.moneyIn ? money(l.moneyIn, s.currency) : ""}</td>
                      <td className="r num">{l.moneyOut ? money(l.moneyOut, s.currency) : ""}</td>
                      <td className="r num">{money(l.balance, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="faint xs" style={{ marginTop: 16 }}>
            Generated {new Date(s.generatedAt).toLocaleString()}. Times are in UTC. Balances come from Aurex's double-entry ledger. Questions about a transaction? Quote its reference.
          </p>
        </div>
      )}
    </>
  );
}
