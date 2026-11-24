import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorText, Field, StatusPill } from "../components/ui";
import { money, timeAgo } from "../format";
import { platform } from "../native";
import { useLoad, useToast } from "../state";

interface CardView {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  currency: string;
  status: "active" | "frozen" | "canceled";
  design: "gold" | "black";
  dailyLimit: string | null;
}
interface Overview {
  available: boolean;
  currency: string;
  blockers: string[];
  card: CardView | null;
  wallets: { id: string; wallet: string | null; status: string; device: string | null; updatedAt: string }[];
  activity: { id: string; amount: string; currency: string; merchant: string | null; city: string | null; wallet: string | null; approved: boolean; declineReason: string | null; status: string; createdAt: string }[];
  walletButtons: boolean;
  publishableKey: string | null;
}

const WALLET_NAMES: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay", samsung_pay: "Samsung Pay" };
const DECLINES: Record<string, string> = {
  insufficient_funds: "Not enough in your wallet",
  card_frozen: "Card was frozen",
  card_canceled: "Card was cancelled",
  account_frozen: "Account frozen",
  under_review: "Account under review",
  identity_update: "Identity details need updating",
  card_limit: "Over your card's daily limit",
  account_limit: "Over your account limits",
  currency: "Currency not supported",
};

// ---- Stripe.js, loaded only when the customer asks to see their card details --------------------
type StripeLike = {
  createEphemeralKeyNonce(o: { issuingCard: string }): Promise<{ nonce?: string; error?: { message: string } }>;
  retrieveIssuingCard(id: string, o: { ephemeralKeySecret: string; nonce: string }): Promise<{ error?: { message: string } }>;
  elements(): { create(type: string, o: Record<string, unknown>): { mount(el: HTMLElement): void; destroy?(): void } };
};
let stripeScript: Promise<void> | null = null;
function loadStripe(): Promise<void> {
  if ((window as unknown as { Stripe?: unknown }).Stripe) return Promise.resolve();
  stripeScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload = () => resolve();
    s.onerror = () => {
      stripeScript = null;
      reject(new Error("Couldn't load Stripe's secure card fields. Check your connection."));
    };
    document.head.append(s);
  });
  return stripeScript;
}

/** Card number, expiry and CVC in Stripe's own frames: the numbers never pass through Aurex. */
function CardDetails({ card, walletButtons, onClose }: { card: CardView; walletButtons: boolean; onClose: () => void }) {
  const number = useRef<HTMLDivElement>(null);
  const expiry = useRef<HTMLDivElement>(null);
  const cvc = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const addToWallet = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadStripe();
        const pk = (await api.get<Overview>("/api/cards")).publishableKey;
        if (!pk) throw new Error("Card details can't be shown on this server yet.");
        const Stripe = (window as unknown as { Stripe: (k: string) => StripeLike }).Stripe;
        const stripe = Stripe(pk);
        const providerCardId = (await api.post<{ providerCardId: string }>(`/api/cards/${card.id}/key`, {})).providerCardId;
        const n = await stripe.createEphemeralKeyNonce({ issuingCard: providerCardId });
        if (!n.nonce) throw new Error(n.error?.message ?? "Couldn't open the secure card fields");
        const key = await api.post<{ ephemeralKeySecret: string }>(`/api/cards/${card.id}/key`, { nonce: n.nonce });
        const opened = await stripe.retrieveIssuingCard(providerCardId, { ephemeralKeySecret: key.ephemeralKeySecret, nonce: n.nonce });
        if (opened.error) throw new Error(opened.error.message);
        if (cancelled) return;
        const els = stripe.elements();
        const style = { base: { fontSize: "18px", fontFamily: "ui-monospace, Menlo, monospace", color: "#17140c", letterSpacing: "1px" } };
        const opts = { issuingCard: providerCardId, nonce: n.nonce, ephemeralKeySecret: key.ephemeralKeySecret, style };
        if (number.current) els.create("issuingCardNumberDisplay", opts).mount(number.current);
        if (expiry.current) els.create("issuingCardExpiryDisplay", opts).mount(expiry.current);
        if (cvc.current) els.create("issuingCardCvcDisplay", opts).mount(cvc.current);
        if (copy.current) els.create("issuingCardCopyButton", { toCopy: "number", style: { base: { fontSize: "14px", lineHeight: "24px" } } }).mount(copy.current);
        // Push provisioning ("Add to Apple Wallet / Google Wallet"), once the card programme is approved for it.
        if (walletButtons && addToWallet.current && (platform !== "web" || /Android|iPhone|iPad/.test(navigator.userAgent))) {
          const wallet = platform === "ios" || /iPhone|iPad/.test(navigator.userAgent) ? "apple" : "google";
          els.create("issuingAddToWalletButton", { ...opts, wallet, buttonHeight: "48px" }).mount(addToWallet.current);
        }
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card.id, walletButtons]);
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="card-head"><h2>Card details</h2><button className="btn ghost sm" onClick={onClose}>Hide</button></div>
      <p className="muted small" style={{ margin: 0 }}>Only you can see these, and only for a few minutes. Aurex staff never ask for them.</p>
      <ErrorText error={error} />
      {!ready && !error && <p className="small faint"><span className="spinner" /> Opening the secure card fields…</p>}
      <div className="card-fields" hidden={!ready}>
        <div><span className="label">Card number</span><div ref={number} className="card-field" /></div>
        <div className="row" style={{ gap: 18 }}>
          <div><span className="label">Expires</span><div ref={expiry} className="card-field" /></div>
          <div><span className="label">CVC</span><div ref={cvc} className="card-field" /></div>
          <div ref={copy} style={{ alignSelf: "flex-end", minWidth: 80 }} />
        </div>
        <div ref={addToWallet} />
      </div>
    </div>
  );
}

function AddToPhone({ wallets }: { wallets: Overview["wallets"] }) {
  const tabs = [
    { id: "apple", name: "Apple Wallet", steps: ["Open the Wallet app on your iPhone and tap +.", "Choose Debit or Credit Card, then Enter Card Details Manually.", "Type the number, expiry and CVC from “Show card details”.", "Enter the code Aurex's card partner sends to your phone or email."] },
    { id: "google", name: "Google Wallet", steps: ["Open Google Wallet on your Android phone and tap Add to Wallet.", "Choose Payment card, then Enter details manually.", "Type the number, expiry and CVC from “Show card details”.", "Enter the verification code you're sent."] },
    { id: "samsung", name: "Samsung Wallet", steps: ["Open Samsung Wallet and go to the payment cards.", "Tap Add card, then Enter card details manually.", "Type the number, expiry and CVC from “Show card details”.", "Enter the verification code you're sent."] },
  ];
  const [tab, setTab] = useState(platform === "ios" ? "apple" : "google");
  const current = tabs.find((t) => t.id === tab)!;
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <h2>Pay by tapping your phone</h2>
      <p className="muted small" style={{ margin: 0 }}>Add your Aurex card to your phone's wallet and pay at any contactless terminal. Each payment comes out of your Aurex wallet.</p>
      <div className="seg" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>{t.name}</button>
        ))}
      </div>
      <ol className="small" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
        {current.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      {wallets.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>In phone wallets</div>
          <div className="list">
            {wallets.map((w) => (
              <div className="list-item" key={w.id}>
                <div className="grow"><strong>{w.wallet ? WALLET_NAMES[w.wallet] ?? w.wallet : "Phone wallet"}</strong>{w.device && <span className="faint small"> · {w.device}</span>}</div>
                <StatusPill status={w.status === "active" ? "completed" : w.status} />
              </div>
            ))}
          </div>
          <p className="faint small" style={{ marginTop: 6 }}>Don't recognise one? Freeze your card now and contact support.</p>
        </div>
      )}
    </div>
  );
}

/** The two card designs, side by side, to pick from. */
function DesignPicker({ value, onChange }: { value: "gold" | "black"; onChange: (d: "gold" | "black") => void }) {
  return (
    <div className="design-picker" role="radiogroup" aria-label="Card design">
      {(["gold", "black"] as const).map((d) => (
        <button key={d} type="button" role="radio" aria-checked={value === d} className={`design-option ${value === d ? "on" : ""}`} onClick={() => onChange(d)}>
          <span className={`aurex-card card-mini ${d}`} aria-hidden="true"><span className="aurex-card-brand">Aurex</span><span className="aurex-card-number">•••• 0000</span></span>
          <span>{d === "gold" ? "Gold" : "Black"}</span>
        </button>
      ))}
    </div>
  );
}

function Apply({ currency, onDone }: { currency: string; onDone: (o: Overview) => void }) {
  const [f, setF] = useState({ name: "", line1: "", line2: "", city: "", postalCode: "", country: "KE", phone: "" });
  const [design, setDesign] = useState<"gold" | "black">("gold");
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<Overview>("/api/cards", { ...f, design, country: f.country.toUpperCase(), acceptTerms: terms, line2: f.line2 || undefined, postalCode: f.postalCode || undefined, phone: f.phone || undefined }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Get your card</h2>
      <p className="muted small" style={{ margin: 0 }}>A virtual Visa or Mastercard debit card that spends your {currency} wallet. Use it online, or add it to Apple Wallet, Google Wallet or Samsung Wallet and tap to pay in shops. No monthly fee.</p>
      <div className="field">
        <span>Choose your card</span>
        <DesignPicker value={design} onChange={setDesign} />
      </div>
      <Field label="Name on the card"><input id="card-name" className="input" value={f.name} onChange={set("name")} required minLength={3} maxLength={80} autoComplete="name" /></Field>
      <Field label="Billing address"><input id="card-line1" className="input" value={f.line1} onChange={set("line1")} required minLength={3} autoComplete="address-line1" placeholder="Street and number" /></Field>
      <input id="card-line2" className="input" value={f.line2} onChange={set("line2")} autoComplete="address-line2" placeholder="Building, floor (optional)" aria-label="Address line 2" />
      <div className="grid grid-3">
        <Field label="City"><input id="card-city" className="input" value={f.city} onChange={set("city")} required autoComplete="address-level2" /></Field>
        <Field label="Postcode"><input id="card-postcode" className="input" value={f.postalCode} onChange={set("postalCode")} autoComplete="postal-code" /></Field>
        <Field label="Country (2 letters)"><input id="card-country" className="input" value={f.country} onChange={set("country")} required maxLength={2} minLength={2} autoComplete="country" style={{ textTransform: "uppercase" }} /></Field>
      </div>
      <Field label="Mobile number (for wallet codes)"><input id="card-phone" className="input" type="tel" value={f.phone} onChange={set("phone")} autoComplete="tel" placeholder="+254…" /></Field>
      <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
        <input id="card-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ marginTop: 3 }} />
        <span>I accept the card terms and the card issuer's terms (see <Link to="/terms">Terms</Link>). Card payments come straight out of my Aurex wallet.</span>
      </label>
      <ErrorText error={error} />
      <button className="btn" disabled={busy || !terms} style={{ alignSelf: "flex-start" }}>{busy ? "Issuing your card…" : "Get my card"}</button>
    </form>
  );
}

export function CardPage() {
  const toast = useToast();
  const { data, setData, reload } = useLoad(() => api.get<Overview>("/api/cards"));
  const [showDetails, setShowDetails] = useState(false);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function act(path: string, done: string) {
    if (!data?.card) return;
    setBusy(true);
    try {
      setData(await api.post<Overview>(`/api/cards/${data.card.id}/${path}`, {}));
      toast(done);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }
  async function setDesign(design: "gold" | "black") {
    if (!data?.card || data.card.design === design) return;
    try {
      setData(await api.put<Overview>(`/api/cards/${data.card.id}/design`, { design }));
      toast(design === "black" ? "Your card is now Black" : "Your card is now Gold");
    } catch (err) {
      toast((err as Error).message);
    }
  }
  async function saveLimit(e: FormEvent) {
    e.preventDefault();
    if (!data?.card) return;
    try {
      setData(await api.put<Overview>(`/api/cards/${data.card.id}/limit`, { daily: limit.trim() ? limit.trim() : null }));
      toast(limit.trim() ? `Daily card limit set to ${money(limit, data.currency)}` : "Daily card limit removed");
      setLimit("");
    } catch (err) {
      toast((err as Error).message);
    }
  }

  const card = data?.card;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Card</h1>
          <p className="muted">A debit card for your Aurex wallet: online, and in shops with your phone.</p>
        </div>
      </div>
      {!data ? null : !data.available ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Aurex cards aren't available on this server yet.</p></div>
      ) : !card && data.blockers.length > 0 ? (
        <div className="card stack" style={{ gap: 10 }}>
          <h2>Before you get a card</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>{data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <Link className="btn sm" style={{ alignSelf: "flex-start" }} to="/app/account">Go to verification</Link>
        </div>
      ) : !card ? (
        <Apply currency={data.currency} onDone={(o) => { setData(o); toast("Your card is ready"); }} />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div className={`aurex-card ${card.design} ${card.status}`} aria-label={`Aurex ${card.design} card ending ${card.last4}`}>
              <div className="row between"><span className="aurex-card-brand">Aurex</span><span className="aurex-card-net">{card.brand ?? "Debit"}</span></div>
              <div className="aurex-card-number">•••• •••• •••• {card.last4}</div>
              <div className="row between small">
                <span>{card.currency} wallet · debit</span>
                <span>{card.expMonth ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}` : ""}</span>
              </div>
              {card.status === "frozen" && <div className="aurex-card-frozen">Frozen</div>}
            </div>
            <div className="card stack" style={{ gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn sm" disabled={busy} onClick={() => setShowDetails(true)}>Show card details</button>
                {card.status === "active" ? (
                  <button className="btn secondary sm" disabled={busy} onClick={() => void act("freeze", "Card frozen: payments will be declined")}>Freeze</button>
                ) : (
                  <button className="btn secondary sm" disabled={busy} onClick={() => void act("unfreeze", "Card unfrozen")}>Unfreeze</button>
                )}
              </div>
              <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
                <span className="small muted">Card design</span>
                <div className="seg" role="radiogroup" aria-label="Card design">
                  {(["gold", "black"] as const).map((d) => (
                    <button key={d} type="button" role="radio" aria-checked={card.design === d} className={card.design === d ? "on" : ""} onClick={() => void setDesign(d)}>{d === "gold" ? "Gold" : "Black"}</button>
                  ))}
                </div>
              </div>
              <form className="row" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={saveLimit}>
                <Field label={`Daily card limit${card.dailyLimit ? ` (now ${money(card.dailyLimit, card.currency)})` : ""}`}>
                  <input id="card-limit" className="input num" inputMode="decimal" placeholder={card.dailyLimit ? "Leave empty to remove" : "No limit"} value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} />
                </Field>
                <button className="btn ghost sm">Save</button>
              </form>
              {confirmCancel ? (
                <div className="banner small">
                  <span className="grow">Cancel this card for good? It stops working everywhere, including phone wallets.</span>
                  <button className="btn sm" onClick={() => void act("cancel", "Card cancelled")}>Cancel card</button>
                  <button className="btn ghost sm" onClick={() => setConfirmCancel(false)}>Keep it</button>
                </div>
              ) : (
                <button className="link-btn small" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmCancel(true)}>Cancel card</button>
              )}
            </div>
          </div>
          {showDetails && <CardDetails card={card} walletButtons={data.walletButtons} onClose={() => { setShowDetails(false); void reload(); }} />}
          <AddToPhone wallets={data.wallets} />
          <div className="card">
            <div className="card-head"><h2>Card payments</h2></div>
            {data.activity.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>No card payments yet.</p>
            ) : (
              <div className="list">
                {data.activity.map((a) => (
                  <div className="list-item" key={a.id}>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{a.merchant ?? "Card payment"}{a.wallet && <span className="faint small"> · {WALLET_NAMES[a.wallet] ?? a.wallet}</span>}</div>
                      <div className="faint small">{a.approved ? (a.status === "pending" ? "Pending" : a.status === "reversed" ? "Cancelled, money returned" : "Paid") : DECLINES[a.declineReason ?? ""] ?? "Declined"} · {timeAgo(a.createdAt)}</div>
                    </div>
                    <div className="num" style={{ fontWeight: 600, textDecoration: a.approved && a.status !== "reversed" ? undefined : "line-through", opacity: a.approved ? 1 : 0.6 }}>−{money(a.amount, a.currency)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
