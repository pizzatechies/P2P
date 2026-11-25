import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorText, Field, StatusPill } from "../components/ui";
import { money, timeAgo } from "../format";
import { openExternal, platform } from "../native";
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
  /** Prepaid cards (Bitnob): money is loaded onto the card. */
  prefunded: boolean;
  balance: string | null;
}
interface Overview {
  available: boolean;
  /** "sandbox": test cards on a test-money server. */
  issuer: "stripe" | "sandbox" | "bitnob" | null;
  prefunded: boolean;
  application: { status: "kyc_pending" | "creating" | "failed"; reason: string | null; link: string | null; opening: string; createdAt: string } | null;
  pendingFunding: { type: "fund" | "withdraw"; amount: string } | null;
  fees: { issue: string; loadMin: string; loadBps: number } | null;
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

/**
 * Card details shown as text: a test card's (they only work on this test server), or a prepaid card's,
 * fetched from the card issuer for the cardholder and never stored.
 */
function PlainCardDetails({ card, test, onClose }: { card: CardView; test: boolean; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<{ number: string | null; cvc: string | null; expMonth: number | null; expYear: number | null; secureViewUrl?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.post<NonNullable<typeof d>>(`/api/cards/${card.id}/key`, {}).then(setD, (e: Error) => setError(e.message));
  }, [card.id]);
  // Some card programmes only show the number on the issuer's own secure page, for a minute.
  if (d && !d.number && d.secureViewUrl) {
    return (
      <div className="card stack" style={{ gap: 12 }}>
        <div className="card-head"><h2>Card details</h2><button className="btn ghost sm" onClick={onClose}>Hide</button></div>
        <p className="muted small" style={{ margin: 0 }}>Your card issuer shows the number on its own secure page, for one minute.</p>
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => void openExternal(d.secureViewUrl!)}>Open card details</button>
      </div>
    );
  }
  const grouped = d?.number?.replace(/(\d{4})(?=\d)/g, "$1 ");
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="card-head"><h2>Card details</h2><button className="btn ghost sm" onClick={onClose}>Hide</button></div>
      <p className="muted small" style={{ margin: 0 }}>
        {test ? "A test card: these details only work for test payments on this server, not in real shops." : "Only you can see these. Aurex staff never ask for them."}
      </p>
      <ErrorText error={error} />
      {d?.number && (
        <div className="card-fields">
          <div><span className="label">Card number</span><div className="card-field num">{grouped}</div></div>
          <div className="row" style={{ gap: 18 }}>
            <div><span className="label">Expires</span><div className="card-field num">{d.expMonth ? `${String(d.expMonth).padStart(2, "0")}/${String(d.expYear).slice(-2)}` : "—"}</div></div>
            <div><span className="label">CVC</span><div className="card-field num">{d.cvc}</div></div>
            <button
              className="btn ghost sm"
              style={{ alignSelf: "flex-end" }}
              onClick={() => navigator.clipboard?.writeText(d.number!).then(() => toast("Card number copied"), () => toast("Couldn't copy"))}
            >
              Copy number
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Prepaid cards: load money from the wallet onto the card, or move it back. */
function CardBalance({ card, fees, pending, onDone }: { card: CardView; fees: Overview["fees"]; pending: Overview["pendingFunding"]; onDone: (o: Overview) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"load" | "unload">("load");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Number(amount) || 0;
  const fee = mode === "load" && fees && n > 0 ? Math.max(Number(fees.loadMin), (n * fees.loadBps) / 10_000) : 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await api.post<Overview>(`/api/cards/${card.id}/${mode}`, { amount: amount.trim() }));
      toast(mode === "load" ? `${money(amount, card.currency)} is going onto your card` : `${money(amount, card.currency)} is going back to your wallet`);
      setAmount("");
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" style={{ gap: 12 }} onSubmit={submit}>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <h2>On your card</h2>
        <span className="num" style={{ fontSize: 26, fontWeight: 750 }}>{money(card.balance ?? "0", card.currency)}</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Your card spends what's loaded on it. Load it from your wallet, and move what you don't need back any time (the card keeps at least {money("1", card.currency)}).</p>
      {pending && <p className="small"><span className="spinner" /> {money(pending.amount, card.currency)} is {pending.type === "fund" ? "going onto" : "coming back from"} your card…</p>}
      <div className="seg" role="radiogroup" aria-label="Load or move back">
        <button type="button" role="radio" aria-checked={mode === "load"} className={mode === "load" ? "on" : ""} onClick={() => setMode("load")}>Load card</button>
        <button type="button" role="radio" aria-checked={mode === "unload"} className={mode === "unload" ? "on" : ""} onClick={() => setMode("unload")}>Move to wallet</button>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
        <Field label={`Amount (${card.currency})`}>
          <input id="card-move-amount" className="input num" inputMode="decimal" placeholder={mode === "load" ? "At least 2.00" : "0.00"} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>
        <button className="btn" disabled={busy || !n || Boolean(pending)}>{busy ? "Working…" : mode === "load" ? "Load" : "Move"}</button>
      </div>
      {mode === "load" && fees && n > 0 && <p className="faint small" style={{ margin: 0 }}>Card issuer's fee: {money(fee.toFixed(2), card.currency)}. {money((n + fee).toFixed(2), card.currency)} leaves your wallet.</p>}
    </form>
  );
}

const SHOPS = [
  { name: "Java House", city: "Nairobi", country: "KE" },
  { name: "Naivas Supermarket", city: "Nairobi", country: "KE" },
  { name: "Uber", city: "Nairobi", country: "KE" },
  { name: "Netflix", city: "Online", country: "US" },
];

/** Test cards: pay a pretend shop to see a card payment go through (or be declined). */
function TestPayment({ card, onDone }: { card: CardView; onDone: (o: Overview) => void }) {
  const toast = useToast();
  const [shop, setShop] = useState(SHOPS[0].name);
  const [amount, setAmount] = useState("4.50");
  const [wallet, setWallet] = useState<"" | "apple_pay" | "google_pay" | "samsung_pay">(platform === "ios" ? "apple_pay" : "");
  const [busy, setBusy] = useState(false);
  async function pay(e: FormEvent) {
    e.preventDefault();
    const s = SHOPS.find((x) => x.name === shop) ?? SHOPS[0];
    setBusy(true);
    try {
      const r = await api.post<{ approved: boolean; message: string | null; overview: Overview }>(`/api/cards/${card.id}/test-payment`, {
        amount: amount.trim(), merchant: s.name, city: s.city, country: s.country, wallet: wallet || null,
      });
      onDone(r.overview);
      toast(r.approved ? `Paid ${money(amount, card.currency)} at ${s.name}` : r.message ?? "Declined");
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" style={{ gap: 12 }} onSubmit={pay}>
      <h2>Try a card payment</h2>
      <p className="muted small" style={{ margin: 0 }}>Pay a pretend shop with your test card. It goes through the same checks as a real payment: freeze the card, or set a low daily limit, to see one declined.</p>
      <div className="grid grid-2">
        <Field label="Shop">
          <select id="test-shop" className="input" value={shop} onChange={(e) => setShop(e.target.value)}>
            {SHOPS.map((x) => <option key={x.name}>{x.name}</option>)}
          </select>
        </Field>
        <Field label={`Amount (${card.currency})`}>
          <input id="test-amount" className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} required />
        </Field>
      </div>
      <div className="field">
        <span>Pay with</span>
        <div className="seg" role="radiogroup" aria-label="Pay with">
          {([["", "Card"], ["apple_pay", "Apple Pay"], ["google_pay", "Google Pay"], ["samsung_pay", "Samsung Pay"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={wallet === id} className={wallet === id ? "on" : ""} onClick={() => setWallet(id)}>{label}</button>
          ))}
        </div>
      </div>
      <button className="btn" disabled={busy || !amount} style={{ alignSelf: "flex-start" }}>{busy ? "Paying…" : `Pay ${amount ? money(amount, card.currency) : ""}`}</button>
    </form>
  );
}

function AddToPhone({ wallets, test }: { wallets: Overview["wallets"]; test: boolean }) {
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
      {test ? (
        <p className="muted small" style={{ margin: 0 }}>Test cards can't be added to a real phone wallet. Once a card issuer is connected, your Aurex card can be, like this:</p>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>Add your Aurex card to your phone's wallet and pay at any contactless terminal. Each payment comes out of your Aurex wallet.</p>
      )}
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

function Apply({ currency, test, prefunded, fees, onDone }: { currency: string; test: boolean; prefunded: boolean; fees: Overview["fees"]; onDone: (o: Overview) => void }) {
  const [f, setF] = useState({ name: "", line1: "", line2: "", city: "", state: "", postalCode: "", country: "KE", phone: "" });
  const [p, setP] = useState({ occupation: "", employmentStatus: "employed", yearlyIncomeUsd: "", monthlySpendUsd: "", purpose: "Online shopping and subscriptions", openingAmount: "10" });
  const [occupations, setOccupations] = useState<{ code: string; description: string }[]>([]);
  useEffect(() => {
    if (prefunded) api.get<{ occupations: { code: string; description: string }[] }>("/api/cards/occupations").then((r) => setOccupations(r.occupations), () => setOccupations([]));
  }, [prefunded]);
  const opening = Number(p.openingAmount) || 0;
  const startFee = fees && opening ? Number(fees.issue) + Math.max(Number(fees.loadMin), (opening * fees.loadBps) / 10_000) : 0;
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
      onDone(
        await api.post<Overview>("/api/cards", {
          ...f,
          design,
          country: f.country.toUpperCase(),
          acceptTerms: terms,
          line2: f.line2 || undefined,
          state: f.state || undefined,
          postalCode: f.postalCode || undefined,
          phone: f.phone || undefined,
          ...(prefunded ? { ...p, yearlyIncomeUsd: Number(p.yearlyIncomeUsd), monthlySpendUsd: Number(p.monthlySpendUsd) } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>{test ? "Get your test card" : "Get your card"}</h2>
      {test ? (
        <p className="muted small" style={{ margin: 0 }}>This server runs on test money, so you get a test card: it spends your test {currency} wallet and shows how card payments work, but can't be used in real shops.</p>
      ) : prefunded ? (
        <p className="muted small" style={{ margin: 0 }}>A virtual dollar Visa card you load from your Aurex wallet. Use it online anywhere, and add it to Apple Pay or Google Pay to tap in shops. The card issuer checks your details first, usually in a few minutes.</p>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>A virtual Visa or Mastercard debit card that spends your {currency} wallet. Use it online, or add it to Apple Wallet, Google Wallet or Samsung Wallet and tap to pay in shops. No monthly fee.</p>
      )}
      <div className="field">
        <span>Choose your card</span>
        <DesignPicker value={design} onChange={setDesign} />
      </div>
      <Field label="Name on the card"><input id="card-name" className="input" value={f.name} onChange={set("name")} required minLength={3} maxLength={80} autoComplete="name" /></Field>
      <Field label="Billing address"><input id="card-line1" className="input" value={f.line1} onChange={set("line1")} required minLength={3} autoComplete="address-line1" placeholder="Street and number" /></Field>
      <input id="card-line2" className="input" value={f.line2} onChange={set("line2")} autoComplete="address-line2" placeholder="Building, floor (optional)" aria-label="Address line 2" />
      <div className="grid grid-3">
        <Field label="City"><input id="card-city" className="input" value={f.city} onChange={set("city")} required autoComplete="address-level2" /></Field>
        {prefunded && <Field label="County or state"><input id="card-state" className="input" value={f.state} onChange={set("state")} required autoComplete="address-level1" /></Field>}
        <Field label="Postcode"><input id="card-postcode" className="input" value={f.postalCode} onChange={set("postalCode")} required={prefunded} autoComplete="postal-code" /></Field>
        <Field label="Country (2 letters)"><input id="card-country" className="input" value={f.country} onChange={set("country")} required maxLength={2} minLength={2} autoComplete="country" style={{ textTransform: "uppercase" }} /></Field>
      </div>
      <Field label="Mobile number (for wallet codes)"><input id="card-phone" className="input" type="tel" value={f.phone} onChange={set("phone")} required={prefunded} autoComplete="tel" placeholder="+254…" /></Field>
      {prefunded && (
        <>
          <p className="faint small" style={{ margin: 0 }}>The card issuer asks a few questions of its own. Your name, date of birth and ID come from your Aurex verification.</p>
          <div className="grid grid-2">
            <Field label="Occupation">
              {occupations.length ? (
                <select id="card-occupation" className="input" value={p.occupation} onChange={(e) => setP({ ...p, occupation: e.target.value })} required>
                  <option value="">Choose…</option>
                  {occupations.map((o) => <option key={o.code} value={o.code}>{o.description}</option>)}
                </select>
              ) : (
                <input id="card-occupation" className="input" value={p.occupation} onChange={(e) => setP({ ...p, occupation: e.target.value })} required />
              )}
            </Field>
            <Field label="Work">
              <select id="card-employment" className="input" value={p.employmentStatus} onChange={(e) => setP({ ...p, employmentStatus: e.target.value })}>
                <option value="employed">Employed</option>
                <option value="self_employed">Self-employed</option>
                <option value="student">Student</option>
                <option value="retired">Retired</option>
                <option value="unemployed">Not working</option>
              </select>
            </Field>
            <Field label="Yearly income (USD)"><input id="card-income" className="input num" inputMode="decimal" value={p.yearlyIncomeUsd} onChange={(e) => setP({ ...p, yearlyIncomeUsd: e.target.value.replace(/[^\d.]/g, "") })} required /></Field>
            <Field label="Expected card spending a month (USD)"><input id="card-monthly" className="input num" inputMode="decimal" value={p.monthlySpendUsd} onChange={(e) => setP({ ...p, monthlySpendUsd: e.target.value.replace(/[^\d.]/g, "") })} required /></Field>
          </div>
          <Field label="What you'll use it for">
            <select id="card-purpose" className="input" value={p.purpose} onChange={(e) => setP({ ...p, purpose: e.target.value })}>
              <option>Online shopping and subscriptions</option>
              <option>Travel</option>
              <option>Everyday spending</option>
              <option>Business expenses</option>
            </select>
          </Field>
          <Field label="Put on the card to start (USD, at least 2)">
            <input id="card-opening" className="input num" inputMode="decimal" value={p.openingAmount} onChange={(e) => setP({ ...p, openingAmount: e.target.value.replace(/[^\d.]/g, "") })} required />
          </Field>
          {fees && opening > 0 && (
            <p className="faint small" style={{ margin: 0 }}>Card issuer's fees: {money(startFee.toFixed(2), currency)} ({money(fees.issue, currency)} for the card, and for loading it). {money((opening + startFee).toFixed(2), currency)} leaves your wallet; it all comes back if the card can't be issued.</p>
          )}
        </>
      )}
      <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
        <input id="card-terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ marginTop: 3 }} />
        <span>I accept the card terms and the card issuer's terms (see <Link to="/terms">Terms</Link>). Card payments come straight out of my Aurex wallet.</span>
      </label>
      <ErrorText error={error} />
      <button className="btn" disabled={busy || !terms} style={{ alignSelf: "flex-start" }}>{busy ? "Issuing your card…" : test ? "Get my test card" : "Get my card"}</button>
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
  const test = data?.issuer === "sandbox";
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
        data.application && data.application.status !== "failed" ? (
          <div className="card stack" style={{ gap: 10 }}>
            <h2>Your card is on its way</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {data.application.status === "kyc_pending" ? "The card issuer is checking your details. This usually takes a few minutes." : "The card issuer is making your card."} We'll let you know as soon as it's ready, with {money(data.application.opening, data.currency)} on it.
            </p>
            {data.application.link && <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => void openExternal(data.application!.link!)}>Finish the issuer's check</button>}
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => void reload()}>Check again</button>
          </div>
        ) : (
          <>
            {data.application?.status === "failed" && (
              <div className="banner small" role="status">{data.application.reason ?? "Your last card application didn't go through."} Any money taken is back in your wallet. You can apply again.</div>
            )}
            <Apply currency={data.currency} test={test} prefunded={data.prefunded} fees={data.fees} onDone={(o) => { setData(o); toast(o.card ? "Your card is ready" : "Application sent"); }} />
          </>
        )
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div className={`aurex-card ${card.design} ${card.status}`} aria-label={`Aurex ${card.design} card ending ${card.last4}`}>
              <div className="row between"><span className="aurex-card-brand">Aurex{test && <span className="aurex-card-test">Test</span>}</span><span className="aurex-card-net">{card.brand ?? "Debit"}</span></div>
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
              {!card.prefunded && <form className="row" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={saveLimit}>
                <Field label={`Daily card limit${card.dailyLimit ? ` (now ${money(card.dailyLimit, card.currency)})` : ""}`}>
                  <input id="card-limit" className="input num" inputMode="decimal" placeholder={card.dailyLimit ? "Leave empty to remove" : "No limit"} value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} />
                </Field>
                <button className="btn ghost sm">Save</button>
              </form>}
              {confirmCancel ? (
                <div className="banner small">
                  <span className="grow">Cancel this card for good? It stops working everywhere, including phone wallets.{card.prefunded ? " What's on it comes back to your wallet." : ""}</span>
                  <button className="btn sm" onClick={() => void act("cancel", "Card cancelled")}>Cancel card</button>
                  <button className="btn ghost sm" onClick={() => setConfirmCancel(false)}>Keep it</button>
                </div>
              ) : (
                <button className="link-btn small" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmCancel(true)}>Cancel card</button>
              )}
            </div>
          </div>
          {card.prefunded && card.status !== "canceled" && <CardBalance card={card} fees={data.fees} pending={data.pendingFunding} onDone={setData} />}
          {showDetails && (test || card.prefunded
            ? <PlainCardDetails card={card} test={test} onClose={() => setShowDetails(false)} />
            : <CardDetails card={card} walletButtons={data.walletButtons} onClose={() => { setShowDetails(false); void reload(); }} />)}
          {test && card.status !== "canceled" && <TestPayment card={card} onDone={setData} />}
          <AddToPhone wallets={data.wallets} test={test} />
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
                      <div className="faint small">{a.approved ? (a.status === "pending" ? "Pending" : a.status === "reversed" ? "Cancelled, money returned" : "Paid") : DECLINES[a.declineReason ?? ""] ?? a.declineReason ?? "Declined"} · {timeAgo(a.createdAt)}</div>
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
