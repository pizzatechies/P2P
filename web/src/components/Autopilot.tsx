import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { pct, qty as fmtQty, timeAgo, usd } from "../format";
import { useLoad, useToast } from "../state";
import type { AutopilotEvent, AutopilotSettings, AutopilotStatus, Provider } from "../types";
import { Icon } from "./icons";
import { Delta, ErrorText, Field, Modal } from "./ui";

const PAUSE_TEXT: Record<string, string> = {
  daily_loss_limit: "today's loss hit your limit",
  errors: "repeated errors",
  live_not_allowed: "live account not allowed",
  user: "paused by you",
};

const KIND: Record<string, { label: string; cls: string }> = {
  buy: { label: "Bought", cls: "good" },
  sell: { label: "Sold", cls: "bad" },
  exit: { label: "Exit", cls: "bad" },
  approval: { label: "Needs you", cls: "brand" },
  hold: { label: "Held", cls: "" },
  run: { label: "Check", cls: "" },
  skip: { label: "Skipped", cls: "" },
  pause: { label: "Paused", cls: "warn" },
  error: { label: "Error", cls: "bad" },
};

function minutesUntil(iso: string | null) {
  if (!iso) return null;
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return m <= 0 ? "now" : m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}

/** AI Autopilot: the AI trades for the user on a schedule, inside the limits set here. */
export function AutopilotPanel({ onTraded }: { onTraded: () => void }) {
  const toast = useToast();
  const status = useLoad(() => api.get<AutopilotStatus>("/api/trading/autopilot"));
  const providers = useLoad(() => api.get<{ providers: Provider[] }>("/api/ai/providers").then((r) => r.providers));
  const [draft, setDraft] = useState<AutopilotSettings | null>(null);
  const [symbolsText, setSymbolsText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (status.data && !draft) {
      setDraft(status.data.settings);
      setSymbolsText(status.data.settings.symbols.join(", "));
    }
  }, [status.data, draft]);

  // Keep the status fresh while the panel is open (the scheduler runs in the background).
  useEffect(() => {
    const t = setInterval(() => !document.hidden && status.reload(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = [
    { value: "rules", label: "Rule-based (offline, free)" },
    ...(providers.data ?? [])
      .filter((p) => p.available && p.kind !== "demo")
      .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m.id}`, label: `${p.name} · ${m.label}` }))),
  ];

  function payload(d: AutopilotSettings) {
    const [provider, ...rest] = (d.provider === "rules" ? "rules" : `${d.provider}:${d.model ?? ""}`).split(":");
    return {
      mode: d.mode,
      provider,
      model: provider === "rules" ? null : rest.join(":") || null,
      symbols: symbolsText.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
      intervalMin: d.intervalMin,
      maxPositionPct: d.maxPositionPct,
      maxExposurePct: d.maxExposurePct,
      maxTradesPerDay: d.maxTradesPerDay,
      maxDailyLossPct: d.maxDailyLossPct,
      minConfidence: d.minConfidence,
      useExits: d.useExits,
      allowLive: d.allowLive,
    };
  }

  async function call(label: string, fn: () => Promise<AutopilotStatus & { result?: Record<string, unknown> }>, ok?: string) {
    setBusy(label);
    setError(null);
    try {
      const next = await fn();
      status.setData(next);
      setDraft(next.settings);
      setSymbolsText(next.settings.symbols.join(", "));
      if (ok) toast(ok);
      if (next.result) {
        const r = next.result as { buys?: number; sells?: number; exits?: number; approvals?: number };
        if ((r.buys ?? 0) + (r.sells ?? 0) + (r.exits ?? 0) > 0) onTraded();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    call("save", () => api.put("/api/trading/autopilot", payload(draft)), "Autopilot settings saved");
  };

  async function approve(ev: AutopilotEvent) {
    setBusy(`approve-${ev.id}`);
    try {
      await api.post(`/api/trading/signals/${ev.signalId}/execute`, { confirm: true, qty: ev.detail.qty });
      toast(`Order placed: ${ev.detail.side ?? "buy"} ${fmtQty(ev.detail.qty ?? 0)} ${ev.symbol}`);
      status.reload();
      onTraded();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const st = status.data;
  const s = st?.settings;
  if (!st || !s || !draft) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 140 }} />
      </div>
    );
  }
  if (!st.limits.serverEnabled) return null;

  const state = !s.enabled ? "off" : s.pausedReason ? "paused" : "on";
  const set = <K extends keyof AutopilotSettings>(k: K, v: AutopilotSettings[K]) => setDraft({ ...draft, [k]: v });
  const intervals = [5, 15, 30, 60, 240, 1440].filter((m) => m >= st.limits.minIntervalMin);

  return (
    <div className="card autopilot" id="autopilot">
      <div className="card-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 className="row" style={{ gap: 8 }}>
            <Icon.Sparkle size={16} /> AI Autopilot
            {state === "on" && <span className="pill good">● On · {s.mode === "auto" ? "trading for you" : "asks before trading"}</span>}
            {state === "paused" && <span className="pill warn">Paused · {PAUSE_TEXT[s.pausedReason!] ?? s.pausedReason}</span>}
            {state === "off" && <span className="pill">Off</span>}
          </h2>
          <p className="muted small" style={{ marginTop: 4 }}>
            The AI checks your symbols on a schedule and {s.mode === "auto" ? "places trades" : "proposes trades for you to approve"}, never
            beyond the limits below.
          </p>
        </div>
        <div className="row wrap" style={{ justifyContent: "flex-end" }}>
          {state === "off" && (
            <button className="btn" onClick={() => (s.acknowledged ? call("on", () => api.put("/api/trading/autopilot", { ...payload(draft), enabled: true }), "Autopilot is on") : setShowSetup(true))} disabled={!!busy}>
              Turn on
            </button>
          )}
          {state === "on" && (
            <>
              <button className="btn secondary sm" disabled={!!busy} onClick={() => call("run", () => api.post("/api/trading/autopilot/run"), "Autopilot check complete")}>
                {busy === "run" ? <><span className="spinner" /> Checking…</> : "Run now"}
              </button>
              <button className="btn ghost sm" disabled={!!busy} onClick={() => call("pause", () => api.post("/api/trading/autopilot/pause"), "Autopilot paused")}>Pause</button>
            </>
          )}
          {state === "paused" && (
            <button className="btn sm" disabled={!!busy} onClick={() => call("resume", () => api.post("/api/trading/autopilot/resume"), "Autopilot resumed")}>Resume</button>
          )}
          {state !== "off" && (
            <button className="btn ghost sm" disabled={!!busy} onClick={() => call("off", () => api.put("/api/trading/autopilot", { enabled: false }), "Autopilot turned off")}>Turn off</button>
          )}
        </div>
      </div>

      <div className="kv" style={{ marginBottom: 14 }}>
        <div><span>Trades today</span><strong>{st.stats.tradesToday} / {s.maxTradesPerDay}</strong></div>
        <div><span>Today's P&amp;L</span><strong>{st.stats.dayPnlPct === null ? "—" : <Delta value={st.stats.dayPnlPct}>{pct(st.stats.dayPnlPct)}</Delta>}</strong></div>
        <div><span>Per position</span><strong>≤ {s.maxPositionPct}%</strong></div>
        <div><span>Daily loss stop</span><strong>{s.maxDailyLossPct}%</strong></div>
        <div><span>Last check</span><strong>{s.lastRunAt ? timeAgo(s.lastRunAt) : "—"}</strong></div>
        <div><span>Next check</span><strong>{state === "on" ? minutesUntil(s.nextRunAt) ?? "soon" : "—"}</strong></div>
      </div>

      <button className="btn ghost sm" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} style={{ marginBottom: showSettings ? 10 : 0 }}>
        <Icon.Settings size={14} /> {showSettings ? "Hide" : "Limits & settings"}
      </button>

      {showSettings && (
        <form className="stack autopilot-settings" onSubmit={save}>
          <div className="row wrap">
            <span className="small muted">When it finds a trade:</span>
            <div className="seg">
              <button type="button" className={draft.mode === "auto" ? "on" : ""} onClick={() => set("mode", "auto")}>Trade automatically</button>
              <button type="button" className={draft.mode === "approve" ? "on" : ""} onClick={() => set("mode", "approve")}>Ask me first</button>
            </div>
          </div>
          <div className="grid grid-3">
            <Field label="AI model">
              <select className="input" value={draft.provider === "rules" ? "rules" : `${draft.provider}:${draft.model ?? ""}`} onChange={(e) => {
                const [p, ...m] = e.target.value.split(":");
                setDraft({ ...draft, provider: p, model: p === "rules" ? null : m.join(":") });
              }}>
                {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Symbols to watch" hint="Comma-separated. Leave empty to use your watchlist (first 10).">
              <input className="input" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value.toUpperCase())} placeholder="Your watchlist" />
            </Field>
            <Field label="Check every">
              <select className="input" value={draft.intervalMin} onChange={(e) => set("intervalMin", Number(e.target.value))}>
                {intervals.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 1440 ? "day" : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>)}
              </select>
            </Field>
            <Field label="Max per position (%)" hint={`Up to ${st.limits.maxPositionPctCap}% of your portfolio`}>
              <input className="input num" type="number" min={0.5} max={st.limits.maxPositionPctCap} step={0.5} value={draft.maxPositionPct} onChange={(e) => set("maxPositionPct", Number(e.target.value))} />
            </Field>
            <Field label="Max invested in total (%)">
              <input className="input num" type="number" min={5} max={100} step={5} value={draft.maxExposurePct} onChange={(e) => set("maxExposurePct", Number(e.target.value))} />
            </Field>
            <Field label="Max trades per day">
              <input className="input num" type="number" min={1} max={50} value={draft.maxTradesPerDay} onChange={(e) => set("maxTradesPerDay", Number(e.target.value))} />
            </Field>
            <Field label="Pause after a daily loss of (%)">
              <input className="input num" type="number" min={0.5} max={50} step={0.5} value={draft.maxDailyLossPct} onChange={(e) => set("maxDailyLossPct", Number(e.target.value))} />
            </Field>
            <Field label="Only act with confidence of at least">
              <select className="input" value={draft.minConfidence} onChange={(e) => set("minConfidence", Number(e.target.value))}>
                {[0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((c) => <option key={c} value={c}>{Math.round(c * 100)}%</option>)}
              </select>
            </Field>
            <label className="row small" style={{ alignSelf: "end", paddingBottom: 10 }}>
              <input type="checkbox" checked={draft.useExits} onChange={(e) => set("useExits", e.target.checked)} />
              Sell automatically at the AI's stop-loss and take-profit
            </label>
          </div>
          {st.limits.liveAutopilotAllowed && (
            <label className="row small banner" style={{ margin: 0 }}>
              <input type="checkbox" checked={draft.allowLive} onChange={(e) => set("allowLive", e.target.checked)} />
              Allow the autopilot to trade a live (real-money) brokerage account
            </label>
          )}
          <ErrorText error={error} />
          <div className="row">
            <button className="btn" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save settings"}</button>
            <span className="faint xs">Changes apply from the next check.</span>
          </div>
        </form>
      )}
      {!showSettings && <ErrorText error={error} />}

      <div className="autopilot-feed">
        <div className="faint xs" style={{ margin: "14px 0 6px" }}>Activity</div>
        {st.events.length === 0 && <p className="faint small">Nothing yet. Turn the autopilot on, or press Run now.</p>}
        {st.events.slice(0, 25).map((ev) => {
          const k = KIND[ev.kind] ?? { label: ev.kind, cls: "" };
          return (
            <div key={ev.id} className="feed-item">
              <span className={`pill ${k.cls}`} style={{ minWidth: 74, justifyContent: "center" }}>{k.label}</span>
              <div className="grow">
                <div className="small">
                  {ev.symbol && <strong>{ev.symbol} </strong>}
                  {ev.message}
                </div>
                {ev.detail.rationale && <div className="faint xs feed-why">{ev.detail.rationale}</div>}
              </div>
              {ev.kind === "approval" && ev.signalId && (ev.executed ? (
                <span className="pill brand">Approved</span>
              ) : (
                <button className="btn sm" disabled={!!busy} onClick={() => approve(ev)}>
                  {busy === `approve-${ev.id}` ? "Placing…" : `Approve ${ev.detail.side ?? ""}`}
                </button>
              ))}
              <span className="faint xs" style={{ whiteSpace: "nowrap" }}>{timeAgo(ev.createdAt)}</span>
            </div>
          );
        })}
      </div>

      {showSetup && (
        <AutopilotSetup
          settings={draft}
          symbolsText={symbolsText}
          cap={st.limits.maxPositionPctCap}
          equity={st.stats.equity}
          onClose={() => setShowSetup(false)}
          onConfirm={async () => {
            const ok = await call("on", () => api.put("/api/trading/autopilot", { ...payload(draft), enabled: true, acknowledge: true }), "Autopilot is on");
            if (ok) setShowSetup(false);
          }}
          busy={busy === "on"}
          error={error}
        />
      )}
    </div>
  );
}

function AutopilotSetup({
  settings: s,
  symbolsText,
  cap,
  equity,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  settings: AutopilotSettings;
  symbolsText: string;
  cap: number;
  equity: number | null;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [ack, setAck] = useState(false);
  const perPosition = equity ? usd((equity * Math.min(s.maxPositionPct, cap)) / 100) : `${s.maxPositionPct}%`;
  return (
    <Modal title="Turn on AI Autopilot" onClose={onClose} wide>
      <p className="small">
        Every <strong>{s.intervalMin < 60 ? `${s.intervalMin} minutes` : `${s.intervalMin / 60} hours`}</strong>, the AI will review{" "}
        <strong>{symbolsText.trim() || "your watchlist"}</strong> and{" "}
        <strong>{s.mode === "auto" ? "buy or sell for you" : "propose trades for you to approve"}</strong>.
      </p>
      <ul className="check-list small" style={{ margin: 0 }}>
        <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>At most {perPosition} ({Math.min(s.maxPositionPct, cap)}%) in any one stock, and {s.maxExposurePct}% invested in total</span></li>
        <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>No more than {s.maxTradesPerDay} trades a day, and only at {Math.round(s.minConfidence * 100)}%+ confidence</span></li>
        <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>It pauses itself if your portfolio falls {s.maxDailyLossPct}% in a day</span></li>
        {s.useExits && <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>Positions it opens are sold at their stop-loss or take-profit</span></li>}
        <li className="check"><span className="check-dot" aria-hidden="true">✓</span><span>You can pause it or turn it off at any time; every decision is logged</span></li>
      </ul>
      <div className="banner" style={{ margin: 0 }}>
        AI can be wrong, and markets can move quickly. Signals come from price data and technical indicators, not news or fundamentals,
        and are not financial advice. Start on your paper account until you're comfortable.
      </div>
      <label className="row small" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
        <span>I understand the autopilot places trades on my behalf within these limits, and that I'm responsible for the results.</span>
      </label>
      <ErrorText error={error} />
      <button className="btn block lg" disabled={!ack || busy} onClick={onConfirm}>{busy ? "Turning on…" : "Turn on autopilot"}</button>
    </Modal>
  );
}
