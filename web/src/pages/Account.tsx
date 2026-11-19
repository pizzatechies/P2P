import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, upload, downloadFile } from "../api";
import { Icon } from "../components/icons";
import { Empty, ErrorText, Field, Modal } from "../components/ui";
import { COUNTRIES } from "../countries";
import { timeAgo, usd } from "../format";
import { useAuth, useLoad, useToast } from "../state";

interface DocStatus { kind: string; label: string; uploaded: boolean; uploadedAt: string | null; id: string | null }
interface LevelInfo {
  level: 1 | 2;
  submission: { id: string; status: "draft" | "submitted" | "approved" | "rejected"; submittedAt: string | null; reviewedAt: string | null; reviewNote: string | null } | null;
  data: Record<string, unknown> | null;
  documents: DocStatus[];
  limits: { txUsd: number; dailyUsd: number };
}
interface Verification {
  currentLevel: number;
  levels: { level: number; name: string; summary: string; limits: { txUsd: number; dailyUsd: number } }[];
  limits: { level: number; tiered: boolean; txUsd: number; dailyUsd: number; overridden: boolean };
  identity: LevelInfo;
  enhanced: LevelInfo;
  autoApprove: boolean;
}
interface AccountData {
  accountNumber: string | null;
  accountNumberFormatted: string | null;
  holder: string;
  handle: string;
  email: string;
  memberSince: string;
  status: string;
  limits: { level: number; tiered: boolean; txUsd: number; dailyUsd: number; overridden: boolean; usedTodayUsd: number; leftTodayUsd: number };
  balances: { currency: string; balance: string }[];
  verification: Verification;
}

const LEVEL_NAMES = ["Basic", "Verified identity", "Enhanced"];

export function AccountPage() {
  const { hash } = useLocation();
  const data = useLoad(() => api.get<{ account: AccountData; closureBlockers: string[] }>("/api/account"));
  useEffect(() => {
    if (hash && data.data) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, data.data]);
  const a = data.data?.account;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <p className="muted">Your account number, limits, identity verification, statements and data.</p>
        </div>
      </div>
      <ErrorText error={data.error} />
      {!a ? (
        <div className="skeleton" style={{ height: 300 }} />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-2">
            <AccountCard a={a} />
            <LimitsCard a={a} />
          </div>
          <VerificationCard v={a.verification} onChange={data.reload} />
          <StatementsCard />
          <BusinessCard />
          <div className="grid grid-2">
            <DataCard />
            <CloseCard handle={a.handle} blockers={data.data!.closureBlockers} />
          </div>
        </div>
      )}
    </>
  );
}

function AccountCard({ a }: { a: AccountData }) {
  const toast = useToast();
  return (
    <div className="card">
      <div className="card-head"><h2>Your account</h2><span className={`pill ${a.limits.level >= 1 ? "good" : "warn"}`}>{LEVEL_NAMES[a.limits.level]}</span></div>
      <div className="stat-label">Account number</div>
      <div className="row" style={{ gap: 8 }}>
        <span className="stat-value mono" style={{ margin: 0, letterSpacing: "0.04em" }}>{a.accountNumberFormatted ?? "—"}</span>
        {a.accountNumber && (
          <button
            className="btn ghost sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(a.accountNumber!);
                toast("Account number copied");
              } catch {
                toast(a.accountNumber!);
              }
            }}
          >
            Copy
          </button>
        )}
      </div>
      <p className="faint xs" style={{ margin: "4px 0 12px" }}>Anyone on Aurex can pay you with this number, your @handle or your email.</p>
      <div className="kv">
        <div><span>Account holder</span><strong>{a.holder}</strong></div>
        <div><span>Handle</span><strong>@{a.handle}</strong></div>
        <div><span>Member since</span><strong>{new Date(a.memberSince).toLocaleDateString()}</strong></div>
        <div><span>Wallets</span><strong>{a.balances.map((b) => b.currency).join(", ") || "—"}</strong></div>
      </div>
    </div>
  );
}

function LimitsCard({ a }: { a: AccountData }) {
  const l = a.limits;
  const usedPct = l.dailyUsd ? Math.min(100, Math.round((l.usedTodayUsd / l.dailyUsd) * 100)) : 0;
  return (
    <div className="card">
      <div className="card-head"><h2>Your limits</h2>{l.overridden && <span className="pill">Set for your account</span>}</div>
      <div className="grid grid-2">
        <div>
          <div className="stat-label">Per payment</div>
          <div className="stat-value">{usd(l.txUsd)}</div>
        </div>
        <div>
          <div className="stat-label">Per 24 hours</div>
          <div className="stat-value">{usd(l.dailyUsd)}</div>
        </div>
      </div>
      <div className="progress" aria-label={`${usedPct}% of today's limit used`} style={{ marginTop: 8 }}><span style={{ width: `${usedPct}%` }} /></div>
      <div className="row between xs" style={{ marginTop: 4 }}>
        <span className="muted">{usd(l.usedTodayUsd)} sent or withdrawn in the last 24 hours</span>
        <strong>{usd(l.leftTodayUsd)} left</strong>
      </div>
      <p className="faint xs" style={{ marginBottom: 0 }}>
        Limits apply to sending, withdrawing and each deposit, in US-dollar equivalent.
        {l.tiered && l.level < 2 ? <> <Link to="#verification">Verify {l.level === 0 ? "your identity" : "your address"}</Link> to raise them.</> : null}
      </p>
    </div>
  );
}

function statusPill(info: LevelInfo, verified: boolean) {
  if (verified) return <span className="pill good">Verified</span>;
  switch (info.submission?.status) {
    case "submitted": return <span className="pill warn">Under review</span>;
    case "rejected": return <span className="pill bad">Needs changes</span>;
    case "draft": return <span className="pill">Draft saved</span>;
    default: return <span className="pill">Not started</span>;
  }
}

function VerificationCard({ v, onChange }: { v: Verification; onChange: () => void }) {
  const steps: { level: 0 | 1 | 2; info?: LevelInfo }[] = [{ level: 0 }, { level: 1, info: v.identity }, { level: 2, info: v.enhanced }];
  const next = v.currentLevel === 0 ? v.identity : v.currentLevel === 1 ? v.enhanced : null;
  return (
    <div className="card" id="verification">
      <div className="card-head"><h2><Icon.Shield size={16} /> Identity verification</h2></div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Financial rules require us to know who our customers are before limits go up. Your details and documents are encrypted, seen only by our review team, and
        kept as the law requires.
      </p>
      <div className="grid grid-3" style={{ marginBottom: 12 }}>
        {steps.map(({ level, info }) => {
          const meta = v.levels[level];
          const verified = v.currentLevel >= level;
          return (
            <div key={level} className="card" style={{ boxShadow: "none", background: verified ? "var(--brand-soft, var(--surface-2))" : "var(--surface-2)" }}>
              <div className="row between">
                <strong>{meta.name}</strong>
                {level === 0 ? <span className="pill good">Done</span> : statusPill(info!, verified)}
              </div>
              <div className="faint xs" style={{ margin: "4px 0 8px" }}>{meta.summary}</div>
              <div className="small">{usd(meta.limits.txUsd)} per payment · {usd(meta.limits.dailyUsd)} a day</div>
            </div>
          );
        })}
      </div>
      {next ? <LevelForm info={next} onChange={onChange} autoApprove={v.autoApprove} /> : <p className="good small">You're fully verified. Thank you.</p>}
    </div>
  );
}

function LevelForm({ info, onChange, autoApprove }: { info: LevelInfo; onChange: () => void; autoApprove: boolean }) {
  const toast = useToast();
  const status = info.submission?.status;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = status === "submitted";
  const showForm = !locked && (editing || !info.data || status === "rejected" || status === "draft");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/account/verification/${info.level}/submit`);
      toast(autoApprove ? "Verified" : "Sent for review. We'll let you know.");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h3 style={{ fontSize: 16, margin: 0 }}>{info.level === 1 ? "Step 2: Verify your identity" : "Step 3: Enhanced verification"}</h3>
      {status === "submitted" && (
        <div className="banner">Submitted {info.submission?.submittedAt ? timeAgo(info.submission.submittedAt) : ""}. We're reviewing your details, usually within one business day.</div>
      )}
      {status === "rejected" && (
        <div className="banner" style={{ borderColor: "var(--bad)" }}>
          <span><strong>Please fix and resubmit:</strong> {info.submission?.reviewNote}</span>
        </div>
      )}
      {showForm ? (
        info.level === 1 ? (
          <IdentityForm initial={info.data} onSaved={() => { setEditing(false); onChange(); }} />
        ) : (
          <EnhancedForm initial={info.data} onSaved={() => { setEditing(false); onChange(); }} />
        )
      ) : (
        info.data && !locked && <button className="btn ghost sm" onClick={() => setEditing(true)}>Edit details</button>
      )}
      {info.data && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="stat-label">Documents</div>
          {info.documents.map((d) => (
            <DocumentRow key={d.kind} doc={d} disabled={locked} onUploaded={onChange} />
          ))}
          <p className="faint xs" style={{ margin: 0 }}>Clear photos or scans (JPEG, PNG, WebP or PDF, up to 5 MB). All four corners visible, nothing covered.</p>
        </div>
      )}
      <ErrorText error={error} />
      {info.data && !locked && (
        <button className="btn" disabled={busy || info.documents.some((d) => !d.uploaded)} onClick={submit}>
          {busy ? "Submitting…" : "Submit for review"}
        </button>
      )}
    </div>
  );
}

function DocumentRow({ doc, disabled, onUploaded }: { doc: DocStatus; disabled: boolean; onUploaded: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      await upload(`/api/account/documents/${doc.kind}`, file);
      toast(`${doc.label} uploaded`);
      onUploaded();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="row between wrap" style={{ gap: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div>
        <strong className="small">{doc.label}</strong>
        <div className="faint xs">
          {doc.uploaded ? <>Uploaded {doc.uploadedAt ? timeAgo(doc.uploadedAt) : ""} · <a href={`/api/account/documents/${doc.id}`} target="_blank" rel="noopener">View</a></> : "Not uploaded yet"}
        </div>
      </div>
      {!disabled && (
        <label className={`btn ${doc.uploaded ? "ghost" : "secondary"} sm`} style={{ cursor: "pointer" }}>
          {busy ? "Uploading…" : doc.uploaded ? "Replace" : "Upload"}
          <input
            type="file"
            accept={doc.kind === "selfie" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,application/pdf"}
            capture={doc.kind === "selfie" ? "user" : undefined}
            style={{ display: "none" }}
            onChange={(e) => choose(e.target.files?.[0])}
          />
        </label>
      )}
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function CountrySelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Field label={label}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose…</option>
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>{c.name}</option>
        ))}
      </select>
    </Field>
  );
}

function IdentityForm({ initial, onSaved }: { initial: Record<string, unknown> | null; onSaved: () => void }) {
  const addr = (initial?.address ?? {}) as Record<string, unknown>;
  const [f, setF] = useState({
    legalName: str(initial?.legalName),
    dateOfBirth: str(initial?.dateOfBirth),
    nationality: str(initial?.nationality),
    phone: str(initial?.phone),
    line1: str(addr.line1),
    line2: str(addr.line2),
    city: str(addr.city),
    region: str(addr.region),
    postalCode: str(addr.postalCode),
    country: str(addr.country),
    idType: str(initial?.idType) || "passport",
    idNumber: str(initial?.idNumber),
    idCountry: str(initial?.idCountry),
    idExpiry: str(initial?.idExpiry),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/account/verification/1", {
        legalName: f.legalName,
        dateOfBirth: f.dateOfBirth,
        nationality: f.nationality,
        phone: f.phone,
        address: { line1: f.line1, line2: f.line2, city: f.city, region: f.region, postalCode: f.postalCode, country: f.country },
        idType: f.idType,
        idNumber: f.idNumber,
        idCountry: f.idCountry,
        idExpiry: f.idExpiry,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <div className="grid grid-2">
        <Field label="Legal name (as on your ID)"><input className="input" value={f.legalName} onChange={(e) => set("legalName")(e.target.value)} required autoComplete="name" /></Field>
        <Field label="Date of birth"><input className="input" type="date" value={f.dateOfBirth} onChange={(e) => set("dateOfBirth")(e.target.value)} required autoComplete="bday" /></Field>
        <CountrySelect label="Nationality" value={f.nationality} onChange={set("nationality")} />
        <Field label="Phone number" hint="With country code, e.g. +254 712 345 678"><input className="input" type="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} required autoComplete="tel" /></Field>
      </div>
      <div className="stat-label">Home address</div>
      <div className="grid grid-2">
        <Field label="Address line 1"><input className="input" value={f.line1} onChange={(e) => set("line1")(e.target.value)} required autoComplete="address-line1" /></Field>
        <Field label="Address line 2 (optional)"><input className="input" value={f.line2} onChange={(e) => set("line2")(e.target.value)} autoComplete="address-line2" /></Field>
        <Field label="Town or city"><input className="input" value={f.city} onChange={(e) => set("city")(e.target.value)} required autoComplete="address-level2" /></Field>
        <Field label="Region or state (optional)"><input className="input" value={f.region} onChange={(e) => set("region")(e.target.value)} autoComplete="address-level1" /></Field>
        <Field label="Postal code (optional)"><input className="input" value={f.postalCode} onChange={(e) => set("postalCode")(e.target.value)} autoComplete="postal-code" /></Field>
        <CountrySelect label="Country" value={f.country} onChange={set("country")} />
      </div>
      <div className="stat-label">ID document</div>
      <div className="grid grid-2">
        <Field label="Document type">
          <select className="input" value={f.idType} onChange={(e) => set("idType")(e.target.value)}>
            <option value="passport">Passport</option>
            <option value="national_id">National ID card</option>
            <option value="drivers_license">Driver's licence</option>
          </select>
        </Field>
        <Field label="Document number"><input className="input" value={f.idNumber} onChange={(e) => set("idNumber")(e.target.value)} required /></Field>
        <CountrySelect label="Issuing country" value={f.idCountry} onChange={set("idCountry")} />
        <Field label="Expiry date"><input className="input" type="date" value={f.idExpiry} onChange={(e) => set("idExpiry")(e.target.value)} required /></Field>
      </div>
      <ErrorText error={error} />
      <button className="btn secondary" disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
    </form>
  );
}

function EnhancedForm({ initial, onSaved }: { initial: Record<string, unknown> | null; onSaved: () => void }) {
  const [f, setF] = useState({
    occupation: str(initial?.occupation),
    employer: str(initial?.employer),
    sourceOfFunds: str(initial?.sourceOfFunds) || "salary",
    sourceDetails: str(initial?.sourceDetails),
    expectedMonthlyUsd: str(initial?.expectedMonthlyUsd) || "under_1k",
    pep: initial?.pep === true,
    pepDetails: str(initial?.pepDetails),
    proofOfAddressDate: str(initial?.proofOfAddressDate),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/account/verification/2", f);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <div className="grid grid-2">
        <Field label="Occupation"><input className="input" value={f.occupation} onChange={(e) => setF({ ...f, occupation: e.target.value })} required /></Field>
        <Field label="Employer or business (optional)"><input className="input" value={f.employer} onChange={(e) => setF({ ...f, employer: e.target.value })} /></Field>
        <Field label="Where your money comes from">
          <select className="input" value={f.sourceOfFunds} onChange={(e) => setF({ ...f, sourceOfFunds: e.target.value })}>
            <option value="salary">Salary</option>
            <option value="business">Business income</option>
            <option value="savings">Savings</option>
            <option value="investments">Investments</option>
            <option value="inheritance">Inheritance</option>
            <option value="gift">Gift</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Expected money moved per month">
          <select className="input" value={f.expectedMonthlyUsd} onChange={(e) => setF({ ...f, expectedMonthlyUsd: e.target.value })}>
            <option value="under_1k">Under $1,000</option>
            <option value="1k_5k">$1,000 – $5,000</option>
            <option value="5k_25k">$5,000 – $25,000</option>
            <option value="over_25k">Over $25,000</option>
          </select>
        </Field>
      </div>
      <Field label="Tell us a little more about your source of funds">
        <textarea className="input" rows={2} value={f.sourceDetails} onChange={(e) => setF({ ...f, sourceDetails: e.target.value })} required />
      </Field>
      <label className="row small" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={f.pep} onChange={(e) => setF({ ...f, pep: e.target.checked })} style={{ marginTop: 3 }} />
        <span>I hold, or have held, a prominent public role (for example a senior politician, judge or military officer), or I'm a close family member or associate of someone who has.</span>
      </label>
      {f.pep && <Field label="The public role"><input className="input" value={f.pepDetails} onChange={(e) => setF({ ...f, pepDetails: e.target.value })} required /></Field>}
      <Field label="Date on your proof of address" hint="A utility bill, bank statement or tax letter from the last 3 months, in your name, showing your address">
        <input className="input" type="date" value={f.proofOfAddressDate} onChange={(e) => setF({ ...f, proofOfAddressDate: e.target.value })} required />
      </Field>
      <ErrorText error={error} />
      <button className="btn secondary" disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
    </form>
  );
}

function StatementsCard() {
  const periods = useLoad(() => api.get<{ currencies: string[]; periods: string[] }>("/api/account/statements"));
  const [period, setPeriod] = useState("");
  const [currency, setCurrency] = useState("");
  const p = period || periods.data?.periods[0] || "";
  const c = currency || periods.data?.currencies[0] || "";
  const label = (x: string) => new Date(`${x}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="card" id="statements">
      <div className="card-head"><h2>Statements</h2></div>
      {periods.data && periods.data.currencies.length === 0 ? (
        <Empty>Statements appear once you have a wallet. Add money to get started.</Empty>
      ) : (
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <Field label="Month">
            <select className="input" value={p} onChange={(e) => setPeriod(e.target.value)}>
              {(periods.data?.periods ?? []).map((x) => (
                <option key={x} value={x}>{label(x)}</option>
              ))}
            </select>
          </Field>
          <Field label="Wallet">
            <select className="input" value={c} onChange={(e) => setCurrency(e.target.value)}>
              {(periods.data?.currencies ?? []).map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Link className="btn" to={`/app/statement?period=${p}&currency=${c}`}>View statement</Link>
          <a className="btn secondary" href={`/api/account/statements/${p}?currency=${c}&format=csv`}>Download CSV</a>
        </div>
      )}
      <p className="faint xs" style={{ marginBottom: 0 }}>Each statement shows your opening balance, every payment, deposit, withdrawal and conversion, and your closing balance. Open one to print it or save it as a PDF.</p>
      {c && <RangeDownload currency={c} />}
    </div>
  );
}

/** Wallet activity for any dates (up to a year), as CSV. */
function RangeDownload({ currency }: { currency: string }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  return (
    <details style={{ marginTop: 10 }}>
      <summary className="small" style={{ cursor: "pointer" }}>Download activity for other dates</summary>
      <div className="row wrap" style={{ alignItems: "flex-end", marginTop: 8 }}>
        <Field label="From"><input className="input" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
        <button
          className="btn secondary"
          style={{ marginBottom: 2 }}
          disabled={!from || !to}
          onClick={() => downloadFile(`/api/account/activity?from=${from}&to=${to}&currency=${currency}`, `aurex-activity-${currency}.csv`).catch((e) => toast((e as Error).message, "error"))}
        >
          Download {currency} CSV
        </button>
      </div>
      <p className="faint xs" style={{ margin: "4px 0 0" }}>Up to a year at a time.</p>
    </details>
  );
}

function DataCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const data = await api.get<Record<string, unknown>>("/api/account/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `aurex-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Your data</h2></div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Download a copy of everything we hold about you: profile, verification details, wallets, transactions, trading, AI chats and your security history. Passwords and
        keys are never included.
      </p>
      <button className="btn secondary" onClick={download} disabled={busy}>{busy ? "Preparing…" : "Download my data"}</button>
    </div>
  );
}

function CloseCard({ handle, blockers }: { handle: string; blockers: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head"><h2>Close account</h2></div>
      <p className="small muted" style={{ marginTop: 0 }}>Closing signs you out everywhere and deletes your AI chats, keys, connections and watchlist. Records of your money and identity are kept for as long as financial law requires.</p>
      {blockers.length > 0 && (
        <ul className="small" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <button className="btn danger" disabled={blockers.length > 0} onClick={() => setOpen(true)}>Close my account</button>
      {open && <CloseDialog handle={handle} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CloseDialog({ handle, onClose }: { handle: string; onClose: () => void }) {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/account/close", { confirmHandle: typed });
      setUser(null);
      toast("Your account is closed. Thank you for using Aurex.");
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Close your account?" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">This can't be undone from the app. To reopen it later you'll need to contact support. Type your handle to confirm.</p>
        <Field label={`Type @${handle}`}>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
        </Field>
        <ErrorText error={error} />
        <button className="btn danger block" disabled={busy || typed.replace(/^@/, "").toLowerCase() !== handle.toLowerCase()}>
          {busy ? "Closing…" : "Close my account"}
        </button>
      </form>
    </Modal>
  );
}

interface BusinessOverview {
  feeBps: number;
  categories: string[];
  profile: { businessName: string; category: string; registrationNumber: string | null; country: string; website: string | null; status: "pending" | "approved" | "rejected"; reviewNote: string | null } | null;
  received: Record<"day" | "week" | "month", { currency: string; received: string; fees: string; payments: number }[]> | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  retail: "Shop or retail", food: "Food and drink", services: "Services", transport: "Transport", education: "Education",
  health: "Health", online: "Online business", agriculture: "Farming and agriculture", other: "Other",
};

/** Turn the account into a business account: payments show the business name; a small fee applies. */
function BusinessCard() {
  const toast = useToast();
  const data = useLoad(() => api.get<BusinessOverview>("/api/account/business"));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ businessName: "", category: "retail", registrationNumber: "", country: "KE", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = data.data;
  if (!d) return null;
  const p = d.profile;
  const fee = d.feeBps ? `${(d.feeBps / 100).toFixed(2)}%` : null;

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      data.setData(await api.put<BusinessOverview>("/api/account/business", f));
      setOpen(false);
      toast("Application sent. We'll let you know.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" id="business">
      <div className="card-head">
        <h2>Business account</h2>
        {p && <span className={`pill ${p.status === "approved" ? "good" : p.status === "rejected" ? "bad" : "warn"}`}>{p.status === "approved" ? "Active" : p.status === "pending" ? "Under review" : "Needs changes"}</span>}
      </div>
      {p?.status === "approved" ? (
        <>
          <p className="small muted" style={{ marginTop: 0, marginBottom: 12 }}>
            Payments to you show <strong>{p.businessName}</strong> as a verified business.{fee ? ` Aurex keeps ${fee} of each payment you receive; your customers pay exactly your price.` : ""}
          </p>
          <div className="grid grid-3">
            {(["day", "week", "month"] as const).map((w) => (
              <div key={w}>
                <div className="stat-label">{w === "day" ? "Last 24 hours" : w === "week" ? "Last 7 days" : "Last 30 days"}</div>
                {(d.received?.[w] ?? []).length === 0 ? (
                  <div className="faint small">No payments yet</div>
                ) : (
                  d.received![w].map((r) => (
                    <div key={r.currency} className="small">
                      <strong className="num">{r.received} {r.currency}</strong> <span className="faint">· {r.payments} payment{r.payments === 1 ? "" : "s"}{Number(r.fees) ? ` · fees ${r.fees}` : ""}</span>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </>
      ) : p?.status === "pending" ? (
        <p className="small muted" style={{ margin: 0 }}>We're reviewing <strong>{p.businessName}</strong>, usually within one business day.</p>
      ) : (
        <>
          {p?.status === "rejected" && <div className="banner" style={{ borderColor: "var(--bad)" }}><span className="small"><strong>Please fix and resend:</strong> {p.reviewNote}</span></div>}
          <p className="small muted" style={{ marginTop: 0 }}>
            Selling something? A business account shows your business name to people who pay you, through your pay link or @handle{fee ? `, with a ${fee} fee on payments you receive` : ""}. You'll need your own identity verified first.
          </p>
          {!open ? (
            <button className="btn secondary" onClick={() => { setOpen(true); if (p) setF({ businessName: p.businessName, category: p.category, registrationNumber: p.registrationNumber ?? "", country: p.country, website: p.website ?? "" }); }}>
              {p ? "Edit and resend" : "Apply for a business account"}
            </button>
          ) : (
            <form className="stack" onSubmit={apply}>
              <div className="grid grid-2">
                <Field label="Business name"><input className="input" required minLength={2} maxLength={100} value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} /></Field>
                <Field label="What you do">
                  <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                    {d.categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
                  </select>
                </Field>
                <Field label="Registration number (optional)" hint="From your registration certificate, if you have one"><input className="input" maxLength={60} value={f.registrationNumber} onChange={(e) => setF({ ...f, registrationNumber: e.target.value })} /></Field>
                <CountrySelect label="Country" value={f.country} onChange={(v) => setF({ ...f, country: v })} />
                <Field label="Website (optional)"><input className="input" type="url" placeholder="https://" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
              </div>
              <ErrorText error={error} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send for review"}</button>
                <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
