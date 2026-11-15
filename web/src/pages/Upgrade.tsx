import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { ErrorText, Field } from "../components/ui";
import { COUNTRIES } from "../countries";
import { useLoad, useToast } from "../state";

interface Application {
  legalName: string;
  dateOfBirth: string;
  country: string;
  employment: string;
  annualIncome: string;
  liquidNetWorth: string;
  sourceOfFunds: string;
  experience: string;
  objective: string;
  riskTolerance: string;
  timeHorizon: string;
}
interface UpgradeOverview {
  status: "none" | "draft" | "submitted" | "approved" | "rejected";
  checklist: { id: string; label: string; done: boolean; hint: string; link: string }[];
  application: Application | null;
  assessment: { result: "appropriate" | "warning"; warnings: string[] } | null;
  submittedAt: string | null;
  reviewNote: string | null;
  autoApprove: boolean;
  liveTradingEnabled: boolean;
}

const BANDS: [string, string][] = [["under_10k", "Under $10,000"], ["10k_50k", "$10,000 – $50,000"], ["50k_100k", "$50,000 – $100,000"], ["100k_250k", "$100,000 – $250,000"], ["over_250k", "Over $250,000"]];
const OPTIONS: Record<string, [string, string][]> = {
  employment: [["employed", "Employed"], ["self_employed", "Self-employed"], ["student", "Student"], ["retired", "Retired"], ["unemployed", "Not employed"]],
  annualIncome: BANDS,
  liquidNetWorth: BANDS,
  sourceOfFunds: [["salary", "Salary or wages"], ["savings", "Savings"], ["business", "Business income"], ["investments", "Investments"], ["inheritance", "Inheritance or gift"], ["other", "Other"]],
  experience: [["none", "None"], ["under_1y", "Less than 1 year"], ["1_3y", "1 – 3 years"], ["over_3y", "More than 3 years"]],
  objective: [["growth", "Grow my money over time"], ["income", "Earn regular income (dividends)"], ["speculation", "Short-term trading for quick gains"], ["preservation", "Keep my money safe"]],
  riskTolerance: [["low", "Low: I'd be very uncomfortable with losses"], ["medium", "Medium: I accept some ups and downs"], ["high", "High: I accept large swings for higher potential returns"]],
  timeHorizon: [["under_1y", "Less than 1 year"], ["1_5y", "1 – 5 years"], ["over_5y", "More than 5 years"]],
};
const LABELS: Record<string, string> = {
  employment: "Employment",
  annualIncome: "Yearly income",
  liquidNetWorth: "Savings and investments you could access",
  sourceOfFunds: "Where the money you'll invest comes from",
  experience: "Trading or investing experience",
  objective: "Main goal",
  riskTolerance: "How do you feel about losses?",
  timeHorizon: "How long do you plan to invest?",
};
const EMPTY: Application = { legalName: "", dateOfBirth: "", country: "", employment: "", annualIncome: "", liquidNetWorth: "", sourceOfFunds: "", experience: "", objective: "", riskTolerance: "", timeHorizon: "" };

export function UpgradePage() {
  const toast = useToast();
  const state = useLoad(() => api.get<UpgradeOverview>("/api/trading/upgrade"));
  const [form, setForm] = useState<Application>(EMPTY);
  const [ack, setAck] = useState({ riskOfLoss: false, notAdvice: false, ownAccount: false, accurate: false, understandsWarnings: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = state.data;

  useEffect(() => {
    if (data?.application) setForm(data.application);
  }, [data?.application]);

  const locked = data?.status === "submitted" || data?.status === "approved";
  const set = (k: keyof Application) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      state.setData(await api.put<UpgradeOverview>("/api/trading/upgrade", form));
      toast("Saved. Your details are encrypted.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<UpgradeOverview>("/api/trading/upgrade/submit", ack);
      state.setData(r);
      toast(r.status === "approved" ? "Your real account is approved!" : "Application submitted");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="skeleton" style={{ height: 320 }} />;
  const checklistDone = data.checklist.filter((c) => c.id !== "profile").every((c) => c.done);
  const warnings = data.assessment?.result === "warning" ? data.assessment.warnings : [];
  const allAck = ack.riskOfLoss && ack.notAdvice && ack.ownAccount && ack.accurate && (warnings.length === 0 || ack.understandsWarnings);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Upgrade to a real account</h1>
          <p className="muted">Trade real money through a licensed brokerage account in your name. Your demo account stays available for practice.</p>
        </div>
        <Link to="/app/learn" className="btn secondary sm"><Icon.Learn size={16} /> Academy</Link>
      </div>

      {data.status === "approved" && (
        <div className="banner info" style={{ alignItems: "center" }}>
          <Icon.Rocket size={16} />
          <span className="grow">
            <strong>Your real account is approved.</strong>{" "}
            {data.liveTradingEnabled ? "Connect your live Alpaca brokerage keys in Settings to start trading real money. Start small." : "Real-money trading isn't switched on for this server yet. You'll be able to connect your brokerage as soon as it is."}
          </span>
          {data.liveTradingEnabled && <Link className="btn sm" to="/app/settings#trading">Connect brokerage</Link>}
        </div>
      )}
      {data.status === "submitted" && (
        <div className="banner info"><Icon.Shield size={16} /><span>Your application was submitted {data.submittedAt ? new Date(data.submittedAt).toLocaleDateString() : ""} and is being reviewed. We'll alert you when it's decided.</span></div>
      )}
      {data.status === "rejected" && (
        <div className="banner"><span>Your application wasn't approved{data.reviewNote ? `: ${data.reviewNote}` : "."} You can update your answers and apply again.</span></div>
      )}

      <div className="grid grid-3">
        <div className="card">
          <div className="card-head"><h2>Checklist</h2><span className="faint small">{data.checklist.filter((c) => c.done).length}/{data.checklist.length}</span></div>
          {data.checklist.map((c) => (
            <div key={c.id} className="check-row">
              <span className={`mission-check ${c.done ? "done" : ""}`} aria-hidden="true">{c.done ? "✓" : ""}</span>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{c.label}</div>
                <div className="faint xs">{c.hint}</div>
              </div>
              {!c.done && c.id !== "profile" && <Link to={c.link} className="small">Go</Link>}
            </div>
          ))}
        </div>

        <form className="card span-2 stack" id="application" onSubmit={save}>
          <div className="card-head" style={{ marginBottom: 0 }}><h2>About you</h2><span className="pill"><Icon.Shield size={12} /> Encrypted</span></div>
          <p className="muted small" style={{ margin: 0 }}>Licensed brokers must check that trading suits you. Answer honestly; there are no wrong answers, but some may come with a warning.</p>
          <fieldset disabled={locked} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="grid grid-2">
              <Field label="Legal name (as on your ID)">
                <input className="input" value={form.legalName} onChange={(e) => set("legalName")(e.target.value)} required autoComplete="name" />
              </Field>
              <Field label="Date of birth">
                <input className="input" type="date" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth")(e.target.value)} required max={new Date().toISOString().slice(0, 10)} />
              </Field>
            </div>
            <Field label="Country of residence">
              <select className="input" value={form.country} onChange={(e) => set("country")(e.target.value)} required>
                <option value="">Choose…</option>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-2">
              {(Object.keys(OPTIONS) as (keyof Application)[]).map((k) => (
                <Field key={k} label={LABELS[k]}>
                  <select className="input" value={form[k]} onChange={(e) => set(k)(e.target.value)} required>
                    <option value="">Choose…</option>
                    {OPTIONS[k].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            {!locked && <button className="btn secondary" style={{ alignSelf: "flex-start" }} disabled={busy}>Save answers</button>}
          </fieldset>

          {warnings.length > 0 && (
            <div className="banner" style={{ display: "block" }}>
              <strong>Please read before you continue</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{warnings.map((w) => <li key={w} className="small">{w}</li>)}</ul>
            </div>
          )}

          {data.application && !locked && (
            <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <h3 style={{ fontSize: 15 }}>Confirm and apply</h3>
              {[
                ["riskOfLoss", "I understand I can lose some or all of the money I invest, and that past results (including demo results) don't guarantee future returns."],
                ["notAdvice", "I understand AI signals and lessons on Aurex are information, not personal financial advice."],
                ["ownAccount", "I'm opening this account for myself, with my own money."],
                ["accurate", "The information I've given is true and complete."],
                ...(warnings.length ? [["understandsWarnings", "I've read the warnings above about my answers and still want to apply."]] : []),
              ].map(([k, text]) => (
                <label key={k} className="ack">
                  <input type="checkbox" checked={ack[k as keyof typeof ack]} onChange={(e) => setAck({ ...ack, [k]: e.target.checked })} />
                  <span>{text}</span>
                </label>
              ))}
              {!checklistDone && <p className="faint small" style={{ margin: 0 }}>Finish the checklist on the left to apply.</p>}
              <button type="button" className="btn" style={{ alignSelf: "flex-start" }} disabled={busy || !allAck || !checklistDone} onClick={submit}>
                <Icon.Rocket size={16} /> {data.autoApprove ? "Open my real account" : "Submit application"}
              </button>
            </div>
          )}
          <ErrorText error={error} />
        </form>
      </div>
    </>
  );
}
