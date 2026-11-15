import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/icons";
import { ErrorText, Modal } from "../components/ui";
import { usd } from "../format";
import { useLoad, useToast } from "../state";
import type { TradingAccount, TradingSettings } from "../types";

interface Lesson {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  sections: { heading: string; body: string[] }[];
  quiz: { question: string; options: string[] }[];
  passed: boolean;
  score: number | null;
}
interface Overview {
  lessons: Lesson[];
  missions: { id: string; title: string; hint: string; done: boolean }[];
  progress: number;
  passMark: number;
  demoTrades: number;
}

export function LearnPage() {
  const learn = useLoad(() => api.get<Overview>("/api/learn"));
  const account = useLoad(() => api.get<{ account: TradingAccount; settings: TradingSettings }>("/api/trading/account"));
  const upgrade = useLoad(() => api.get<{ status: string; checklist: { id: string; done: boolean }[] }>("/api/trading/upgrade"));
  const [open, setOpen] = useState<Lesson | null>(null);
  const data = learn.data;
  const ready = upgrade.data?.checklist.filter((c) => c.done).length ?? 0;
  const total = upgrade.data?.checklist.length ?? 5;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Learn to trade</h1>
          <p className="muted">Practise with virtual money, learn the essentials, then upgrade to a real account when you're ready.</p>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card span-2">
          <div className="row between wrap" style={{ alignItems: "flex-start" }}>
            <div>
              <div className="stat-label">Your progress</div>
              <div className="stat-value">{data ? `${data.progress}%` : "—"}</div>
              <div className="stat-sub">
                {data ? `${data.lessons.filter((l) => l.passed).length} of ${data.lessons.length} lessons passed · ${data.missions.filter((m) => m.done).length} of ${data.missions.length} practice missions done` : ""}
              </div>
            </div>
            <span className="pillar-ico"><Icon.Learn /></span>
          </div>
          <div className="progress" aria-label={`Progress ${data?.progress ?? 0}%`}>
            <span style={{ width: `${data?.progress ?? 0}%` }} />
          </div>
        </div>
        <DemoAccountCard account={account.data?.account} settings={account.data?.settings} onReset={() => { account.reload(); learn.reload(); }} />
      </div>

      <div className="grid grid-3">
        <div className="span-2 stack">
          <div className="card">
            <div className="card-head"><h2>Lessons</h2><span className="faint small">Pass each quiz with {Math.round((data?.passMark ?? 0.8) * 100)}%</span></div>
            <div className="lesson-list">
              {(data?.lessons ?? []).map((l, i) => (
                <button key={l.id} className="lesson-item" onClick={() => setOpen(l)}>
                  <span className={`lesson-num ${l.passed ? "done" : ""}`}>{l.passed ? "✓" : i + 1}</span>
                  <span className="grow">
                    <strong>{l.title}</strong>
                    <span className="faint small"> · {l.minutes} min</span>
                    <span className="muted small" style={{ display: "block" }}>{l.summary}</span>
                  </span>
                  {l.passed ? <span className="pill good">Passed {Math.round((l.score ?? 1) * 100)}%</span> : <span className="pill">Start</span>}
                </button>
              ))}
              {!data && <div className="skeleton" style={{ height: 240 }} />}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Practice missions</h2><Link to="/app/trading" className="small">Trade</Link></div>
            {(data?.missions ?? []).map((m) => (
              <div key={m.id} className="mission">
                <span className={`mission-check ${m.done ? "done" : ""}`} aria-hidden="true">{m.done ? "✓" : ""}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600, textDecoration: m.done ? "line-through" : undefined }}>{m.title}</div>
                  {!m.done && <div className="faint xs">{m.hint}</div>}
                </div>
              </div>
            ))}
            <p className="faint xs" style={{ marginTop: 8 }}>All practice happens in your demo account with virtual money.</p>
          </div>

          <div className="card">
            <div className="card-head"><h2>Real account</h2><Icon.Rocket size={18} /></div>
            {upgrade.data?.status === "approved" ? (
              <p className="small">Your real account is approved. Connect your brokerage in <Link to="/app/settings#trading">Settings</Link>.</p>
            ) : upgrade.data?.status === "submitted" ? (
              <p className="small">Your application is being reviewed. We'll alert you when it's decided.</p>
            ) : (
              <>
                <p className="muted small">When you're comfortable, upgrade to trade real money through a licensed broker in your name.</p>
                <div className="stat-sub">{ready} of {total} steps done</div>
                <Link className="btn sm" style={{ marginTop: 10 }} to="/app/upgrade">Upgrade to real</Link>
              </>
            )}
          </div>
        </div>
      </div>

      {open && <LessonDialog lesson={open} passMark={data?.passMark ?? 0.8} onClose={() => { setOpen(null); learn.reload(); upgrade.reload(); }} />}
    </>
  );
}

function DemoAccountCard({ account, settings, onReset }: { account?: TradingAccount; settings?: TradingSettings; onReset: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("10000");
  const [busy, setBusy] = useState(false);
  async function reset(e: FormEvent) {
    e.preventDefault();
    if (!confirm(`Restart your demo account with ${usd(Number(amount))} of virtual money? Positions and open orders are cleared.`)) return;
    setBusy(true);
    try {
      await api.post("/api/trading/account/reset", { startingCash: Number(amount) });
      toast("Demo account restarted");
      onReset();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const isDemo = !settings || settings.accountType === "demo";
  return (
    <form className="card" onSubmit={reset}>
      <div className="row between">
        <div className="stat-label">Demo account</div>
        <span className="pill brand">Virtual money</span>
      </div>
      <div className="stat-value">{account && isDemo ? usd(account.equity) : "—"}</div>
      <div className="stat-sub">{settings ? `Started with ${usd(settings.demoStartingCash)}` : ""}</div>
      {isDemo ? (
        <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
          <select className="input" style={{ width: "auto", height: 34 }} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Starting balance">
            {[1000, 10000, 100000, 1000000].map((v) => <option key={v} value={v}>{usd(v)}</option>)}
          </select>
          <button className="btn secondary sm" disabled={busy}>Restart</button>
        </div>
      ) : (
        <p className="faint xs" style={{ marginTop: 8 }}>You're trading a real account. Switch back to demo in Settings to practise.</p>
      )}
    </form>
  );
}

function LessonDialog({ lesson, passMark, onClose }: { lesson: Lesson; passMark: number; onClose: () => void }) {
  const [step, setStep] = useState<"read" | "quiz">("read");
  const [answers, setAnswers] = useState<(number | null)[]>(lesson.quiz.map(() => null));
  const [result, setResult] = useState<{ score: number; passed: boolean; results: { correct: boolean; answer: number; explain: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setResult(await api.post(`/api/learn/lessons/${lesson.id}/quiz`, { answers }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={lesson.title} onClose={onClose} wide>
      {step === "read" ? (
        <div className="stack lesson-body">
          {lesson.sections.map((s) => (
            <section key={s.heading}>
              <h3>{s.heading}</h3>
              {s.body.map((p, i) => <p key={i}>{p}</p>)}
            </section>
          ))}
          <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setStep("quiz")}>Take the quiz ({lesson.quiz.length} questions)</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {lesson.quiz.map((q, qi) => (
            <fieldset key={qi} className="quiz-q">
              <legend><strong>{qi + 1}. {q.question}</strong></legend>
              {q.options.map((o, oi) => {
                const r = result?.results[qi];
                const state = r ? (oi === r.answer ? "right" : answers[qi] === oi ? "wrong" : "") : "";
                return (
                  <label key={oi} className={`quiz-option ${state}`}>
                    <input type="radio" name={`q${qi}`} checked={answers[qi] === oi} disabled={Boolean(result)} onChange={() => setAnswers(answers.map((a, i) => (i === qi ? oi : a)))} />
                    {o}
                  </label>
                );
              })}
              {result && <p className="small muted" style={{ margin: "4px 0 0" }}>{result.results[qi].correct ? "✓ " : "✗ "}{result.results[qi].explain}</p>}
            </fieldset>
          ))}
          <ErrorText error={error} />
          {result ? (
            <div className={`banner ${result.passed ? "info" : ""}`} style={{ alignItems: "center" }}>
              <span className="grow">
                {result.passed ? `Passed with ${Math.round(result.score * 100)}%. Nice work!` : `You scored ${Math.round(result.score * 100)}%. You need ${Math.round(passMark * 100)}%. Review the lesson and try again.`}
              </span>
              {result.passed ? (
                <button type="button" className="btn sm" onClick={onClose}>Done</button>
              ) : (
                <button type="button" className="btn sm" onClick={() => { setResult(null); setAnswers(lesson.quiz.map(() => null)); setStep("read"); }}>Review lesson</button>
              )}
            </div>
          ) : (
            <div className="row between">
              <button type="button" className="btn ghost" onClick={() => setStep("read")}>Back to lesson</button>
              <button className="btn" disabled={answers.some((a) => a === null)}>Check answers</button>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
