import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, upload } from "../api";
import { ErrorText, Field } from "../components/ui";
import { COUNTRIES } from "../countries";
import { AuthShell } from "./Auth";

/**
 * A company director's or owner's identity check, opened from the private link the business sent
 * them. No Aurex account needed: ID details, a photo of the ID and a selfie, then it's sent for review.
 */
interface Invite {
  businessName: string;
  name: string;
  role: "director" | "owner" | "director_owner";
  ownershipPct: number | null;
  detailsSaved: boolean;
  details: { idType: string; idCountry: string } | null;
  documents: string[];
  needed: string[];
  expiresAt: string;
}

const STORE = "aurex-kyb-person";
const ROLE = { director: "a director", owner: "an owner", director_owner: "a director and owner" } as const;
const DOC_LABEL: Record<string, { title: string; hint: string; capture?: "user" | "environment" }> = {
  id_front: { title: "Front of your ID", hint: "All four corners in the photo, nothing covered, no glare.", capture: "environment" },
  id_back: { title: "Back of your ID", hint: "The whole back of the card.", capture: "environment" },
  selfie: { title: "A selfie", hint: "Your face, straight on, in good light. No hat or sunglasses.", capture: "user" },
};

function CountryField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select className="input" required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
    </Field>
  );
}

export function VerifyPersonPage() {
  const params = useParams();
  // Keep the link out of the address bar and browser history once read (it works like a password).
  const [token] = useState(() => {
    const fromPath = params.token ?? "";
    try {
      if (fromPath) sessionStorage.setItem(STORE, fromPath);
      return fromPath || sessionStorage.getItem(STORE) || "";
    } catch {
      return fromPath;
    }
  });
  useEffect(() => {
    if (params.token) window.history.replaceState(null, "", "/verify-person");
  }, [params.token]);

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [f, setF] = useState({ dateOfBirth: "", nationality: "", idType: "national_id", idNumber: "", idCountry: "", idExpiry: "", phone: "", consent: false });
  const [editing, setEditing] = useState(true);
  const base = `/api/public/kyb-person/${encodeURIComponent(token)}`;

  useEffect(() => {
    if (!token) return setLoadError("This link is incomplete. Open it again from the email or message you received.");
    api
      .get<Invite>(base)
      .then((i) => {
        setInvite(i);
        setEditing(!i.detailsSaved);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [token, base]);

  async function saveDetails(e: FormEvent) {
    e.preventDefault();
    setBusy("details");
    setError(null);
    try {
      setInvite(await api.put<Invite>(`${base}/details`, f));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function addPhoto(kind: string, file: File | undefined) {
    if (!file) return;
    setBusy(kind);
    setError(null);
    try {
      setInvite(await upload<Invite>(`${base}/documents/${kind}`, file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function send() {
    setBusy("submit");
    setError(null);
    try {
      const r = await api.post<{ businessName: string }>(`${base}/submit`);
      try {
        sessionStorage.removeItem(STORE);
      } catch {
        /* nothing stored */
      }
      setDone(r.businessName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <AuthShell title="Thank you" subtitle={`Your identity check for ${done} has been sent.`}>
        <p className="small muted" style={{ margin: 0 }}>Our review team will look at it, usually within one business day. You don't need to do anything else, and this link no longer works.</p>
      </AuthShell>
    );
  }
  if (loadError) {
    return (
      <AuthShell title="This link doesn't work" subtitle={loadError}>
        <p className="small muted" style={{ margin: 0 }}>Ask the business that sent it for a new link. <Link to="/">What is Aurex?</Link></p>
      </AuthShell>
    );
  }
  if (!invite) return <AuthShell title="Confirm your identity" subtitle="Opening your link…"><div /></AuthShell>;

  const missing = invite.needed.filter((k) => !invite.documents.includes(k));
  return (
    <AuthShell title="Confirm your identity" subtitle={`${invite.businessName} has listed you, ${invite.name}, as ${ROLE[invite.role]}${invite.ownershipPct ? ` (${invite.ownershipPct}%)` : ""}.`}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          The law requires us to confirm who runs and owns the businesses that use Aurex. It takes about five minutes. Your details and photos are encrypted, and only our review team sees them. If you don't know this business, close this page.
        </p>

        <section className="stack-sm">
          <h2 style={{ fontSize: 16, margin: 0 }}>1. Your ID details</h2>
          {editing ? (
            <form className="stack-sm" onSubmit={saveDetails}>
              <div className="grid grid-2">
                <Field label="Date of birth"><input className="input" type="date" required value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} /></Field>
                <CountryField label="Nationality" value={f.nationality} onChange={(v) => setF({ ...f, nationality: v, idCountry: f.idCountry || v })} />
                <Field label="ID type">
                  <select className="input" value={f.idType} onChange={(e) => setF({ ...f, idType: e.target.value })}>
                    <option value="national_id">National ID card</option>
                    <option value="passport">Passport</option>
                    <option value="drivers_license">Driver's licence</option>
                  </select>
                </Field>
                <Field label="ID number"><input className="input" required minLength={3} maxLength={40} value={f.idNumber} onChange={(e) => setF({ ...f, idNumber: e.target.value })} /></Field>
                <CountryField label="Country that issued it" value={f.idCountry} onChange={(v) => setF({ ...f, idCountry: v })} />
                <Field label="Expiry date"><input className="input" type="date" required value={f.idExpiry} onChange={(e) => setF({ ...f, idExpiry: e.target.value })} /></Field>
                <Field label="Phone (optional)" hint="International format, e.g. +254 712 345 678"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              </div>
              <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" required checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} style={{ marginTop: 3 }} />
                <span>I agree that Aurex may check these details, including with the authority that issued my ID through our identity partner, as described in the <Link to="/privacy" target="_blank">privacy policy</Link>.</span>
              </label>
              <button className="btn" disabled={busy === "details"}>{busy === "details" ? "Saving…" : "Save and continue"}</button>
            </form>
          ) : (
            <div className="row between small">
              <span>✓ Saved{invite.details ? ` · ${invite.details.idType.replace("_", " ")} from ${invite.details.idCountry}` : ""}</span>
              <button type="button" className="link-btn small" onClick={() => setEditing(true)}>Change</button>
            </div>
          )}
        </section>

        {!editing && (
          <section className="stack-sm">
            <h2 style={{ fontSize: 16, margin: 0 }}>2. Photos</h2>
            {invite.needed.map((k) => {
              const have = invite.documents.includes(k);
              const d = DOC_LABEL[k];
              return (
                <div key={k} className="row between wrap" style={{ gap: 8 }}>
                  <div>
                    <strong className="small">{have ? "✓ " : ""}{d.title}</strong>
                    <div className="faint xs">{d.hint}</div>
                  </div>
                  <label className={`btn ${have ? "ghost" : "secondary"} sm${busy ? " disabled" : ""}`}>
                    {busy === k ? "Uploading…" : have ? "Retake" : "Add photo"}
                    <input type="file" accept="image/jpeg,image/png,image/webp" capture={d.capture} hidden onChange={(e) => addPhoto(k, e.target.files?.[0])} />
                  </label>
                </div>
              );
            })}
          </section>
        )}

        <ErrorText error={error} />
        {!editing && (
          <button className="btn block" disabled={missing.length > 0 || busy !== null} onClick={send}>
            {busy === "submit" ? "Sending…" : missing.length ? `Add ${missing.length === 1 ? "one more photo" : `${missing.length} more photos`}` : "Send for review"}
          </button>
        )}
        <p className="faint xs" style={{ margin: 0 }}>This link works until {new Date(invite.expiresAt).toLocaleDateString()}. Aurex will never ask for passwords or codes.</p>
      </div>
    </AuthShell>
  );
}
