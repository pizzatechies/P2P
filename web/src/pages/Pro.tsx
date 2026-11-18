import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { ErrorText, Field } from "../components/ui";
import { money } from "../format";
import { useLoad, useToast } from "../state";

interface ProOverview {
  enabled: boolean;
  price: { amount: string; currency: string; periodDays: number };
  perks: { free: { aiDailyRequests: number; autopilot: boolean; web3Wallets: number }; pro: { aiDailyRequests: number; autopilot: boolean; web3Wallets: number } };
  payWith: { currency: string; price: string; affordable: boolean }[];
  pro: boolean;
  subscription: {
    status: "active" | "past_due" | "canceled";
    currency: string | null;
    amount: string | null;
    startedAt: string;
    renewsAt: string | null;
    endsAt: string | null;
    comped: boolean;
    graceEndsAt: string | null;
  } | null;
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** Aurex Pro: what it adds, its price, and the customer's plan. Paid from the wallet. */
export function ProPage() {
  const toast = useToast();
  const data = useLoad(() => api.get<ProOverview>("/api/pro"));
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = data.data;

  async function act(path: "subscribe" | "cancel" | "resume") {
    setBusy(true);
    setError(null);
    try {
      data.setData(await api.post<ProOverview>(`/api/pro/${path}`, path === "subscribe" ? { currency: currency || undefined } : {}));
      toast(path === "subscribe" ? "Welcome to Aurex Pro" : path === "cancel" ? "Pro won't renew. You keep it until the end of this month." : "Pro will renew as usual");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (data.error) return <ErrorText error={data.error} />;
  if (!d) return <div className="skeleton" style={{ height: 400 }} />;
  if (!d.enabled) {
    return (
      <div className="card"><p className="muted" style={{ margin: 0 }}>Aurex Pro isn't available yet. Everything in Aurex is included in your account.</p></div>
    );
  }
  const s = d.subscription;
  const pick = d.payWith.find((o) => o.currency === currency) ?? d.payWith.find((o) => o.affordable) ?? d.payWith[0];
  const rows: [string, string, string][] = [
    ["AI requests a day on Aurex's models", String(d.perks.free.aiDailyRequests), String(d.perks.pro.aiDailyRequests)],
    ["AI Autopilot trading (within your limits)", d.perks.free.autopilot ? "Included" : "—", "Included"],
    ["Web3 wallets you can watch", String(d.perks.free.web3Wallets), String(d.perks.pro.web3Wallets)],
    ["Payments, statements, data download, academy", "Included", "Included"],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Aurex Pro {d.pro && <span className="pill good" style={{ verticalAlign: "middle" }}>Active</span>}</h1>
          <p className="muted">More AI, the Autopilot and more wallets, for {money(d.price.amount, d.price.currency)} a month, paid from your Aurex wallet. Cancel any time.</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><h2>What you get</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th /><th className="r">Free</th><th className="r">Pro</th></tr></thead>
              <tbody>
                {rows.map(([label, free, pro]) => (
                  <tr key={label}><td>{label}</td><td className="r muted">{free}</td><td className="r"><strong>{pro}</strong></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint xs" style={{ marginBottom: 0 }}>Sending and receiving money, statements and your data are never behind the plan.</p>
        </div>

        <div className="card">
          <div className="card-head"><h2><Icon.Sparkle size={16} /> Your plan</h2></div>
          {s && s.status !== "canceled" && d.pro ? (
            <div className="stack">
              {s.status === "past_due" && (
                <div className="banner" style={{ borderColor: "var(--bad)" }}>
                  <span className="grow small">
                    The renewal couldn't be paid. Add {s.currency} {s.amount} to your <Link to="/app/wallet">{s.currency} wallet</Link>; we'll retry daily
                    {s.graceEndsAt ? ` until ${date(s.graceEndsAt)}` : ""}.
                  </span>
                </div>
              )}
              <div className="kv">
                <div><span>Plan</span><strong>Aurex Pro{s.comped ? " (gift)" : ""}</strong></div>
                {s.amount && <div><span>Price</span><strong>{money(s.amount, s.currency!)} / {d.price.periodDays} days</strong></div>}
                {s.renewsAt && <div><span>Renews</span><strong>{date(s.renewsAt)}</strong></div>}
                {s.endsAt && <div><span>Ends</span><strong>{date(s.endsAt)}</strong></div>}
              </div>
              <ErrorText error={error} />
              {!s.comped && (s.renewsAt ? (
                <button className="btn ghost" disabled={busy} onClick={() => act("cancel")}>Cancel renewal</button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => act("resume")}>Keep Pro (resume renewal)</button>
              ))}
            </div>
          ) : (
            <div className="stack">
              <p className="small muted" style={{ margin: 0 }}>Pay from any of your wallets. Other currencies are converted at the mid-market rate, with no spread.</p>
              <Field label="Pay from">
                <select className="input" value={pick?.currency ?? ""} onChange={(e) => setCurrency(e.target.value)}>
                  {d.payWith.map((o) => (
                    <option key={o.currency} value={o.currency}>{o.currency} wallet: {money(o.price, o.currency)} a month{o.affordable ? "" : " (not enough yet)"}</option>
                  ))}
                </select>
              </Field>
              <ErrorText error={error} />
              {pick && !pick.affordable && (
                <p className="small" style={{ margin: 0 }}>Add at least {money(pick.price, pick.currency)} to your <Link to="/app/wallet">{pick.currency} wallet</Link> first.</p>
              )}
              <button className="btn block lg" disabled={busy || !pick?.affordable} onClick={() => act("subscribe")}>
                {busy ? "Starting…" : pick ? `Get Pro for ${money(pick.price, pick.currency)} a month` : "Get Pro"}
              </button>
              <p className="faint xs" style={{ margin: 0 }}>Renews every {d.price.periodDays} days from the same wallet. Cancel any time; you keep Pro until the end of the month you paid for.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
