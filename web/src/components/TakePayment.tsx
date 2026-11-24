import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { money } from "../format";
import { isNative, platform } from "../native";
import { useAuth, useToast } from "../state";
import { AmountInput, ErrorText, Field, Modal } from "./ui";

export interface TapOverview {
  available: boolean;
  merchant: boolean;
  locationId: string | null;
  simulated: boolean;
  feeBps: number;
}
interface TapPayment {
  id: string;
  amount: string;
  currency: string;
  fee: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  clientSecret?: string;
}

// The Stripe Terminal SDK (Tap to Pay on iPhone and Android), loaded only in the apps, only when used.
let ready: Promise<void> | null = null;
async function terminal(simulated: boolean, locationId: string, merchantName: string) {
  const { StripeTerminal, TerminalConnectTypes, TerminalEventsEnum } = await import("@capacitor-community/stripe-terminal");
  ready ??= (async () => {
    // Connection tokens come from Aurex (signed in), one per request, never from a public URL.
    await StripeTerminal.addListener(TerminalEventsEnum.RequestedConnectionToken, async () => {
      const { secret } = await api.post<{ secret: string }>("/api/tap/connection-token");
      await StripeTerminal.setConnectionToken({ token: secret });
    });
    await StripeTerminal.initialize({ isTest: simulated });
  })().catch((e) => {
    ready = null;
    throw e;
  });
  await ready;
  const { reader } = await StripeTerminal.getConnectedReader();
  if (!reader) {
    const { readers } = await StripeTerminal.discoverReaders({ type: TerminalConnectTypes.TapToPay, locationId });
    if (!readers.length) throw new Error("This phone can't take Tap to Pay payments. It needs NFC and an up-to-date iPhone (XS or later) or Android phone.");
    await StripeTerminal.connectReader({ reader: readers[0], merchantDisplayName: merchantName, autoReconnectOnUnexpectedDisconnect: true });
  }
  return StripeTerminal;
}

/** A business takes a contactless card, Apple Pay, Google Pay or Samsung Pay payment on this phone. */
export function TakePaymentDialog({ tap, onClose, onDone }: { tap: TapOverview; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"form" | "tapping" | "checking" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<TapPayment | null>(null);
  const live = useRef(true);
  useEffect(() => () => {
    live.current = false;
  }, []);

  async function waitForResult(id: string) {
    // Stripe confirms through Aurex's webhook; ask a few times, then let the business check later.
    for (let i = 0; i < 15 && live.current; i++) {
      const p = await api.get<TapPayment>(`/api/tap/payments/${id}`);
      if (p.status !== "pending") return p;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let created: TapPayment | null = null;
    try {
      created = await api.post<TapPayment>("/api/tap/payments", { amount, currency, note: note || undefined });
      setPayment(created);
      setState("tapping");
      const t = await terminal(tap.simulated, tap.locationId!, user?.displayName ?? "Aurex");
      await t.collectPaymentMethod({ paymentIntent: created.clientSecret! });
      await t.confirmPaymentIntent();
      setState("checking");
      const result = await waitForResult(created.id);
      if (!live.current) return;
      if (result?.status === "succeeded") {
        setPayment(result);
        setState("done");
        onDone();
      } else {
        setError("The payment hasn't been confirmed yet. It appears in your wallet as soon as it is.");
        setState("form");
      }
    } catch (err) {
      if (!live.current) return;
      setError((err as Error).message || "The payment didn't go through.");
      setState("form");
      if (created) void api.post(`/api/tap/payments/${created.id}/cancel`).catch(() => undefined);
    }
  }

  async function cancel() {
    try {
      const { StripeTerminal } = await import("@capacitor-community/stripe-terminal");
      await StripeTerminal.cancelCollectPaymentMethod();
    } catch {
      /* nothing to cancel */
    }
    if (payment) await api.post(`/api/tap/payments/${payment.id}/cancel`).catch(() => undefined);
    setState("form");
  }

  const fee = Number(amount || 0) * tap.feeBps / 10000;
  return (
    <Modal title="Take a card payment" onClose={state === "tapping" ? () => void cancel().then(onClose) : onClose}>
      {state === "form" && (
        <form className="stack" onSubmit={start}>
          <Field label="Amount">
            <AmountInput amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} />
          </Field>
          <Field label="What's it for? (optional)">
            <input id="tap-note" className="input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder="2 metres of kitenge" />
          </Field>
          {tap.simulated && <div className="banner small">Test mode: no real card is charged.</div>}
          {tap.feeBps > 0 && Number(amount) > 0 && (
            <p className="faint small" style={{ margin: 0 }}>You receive {money((Number(amount) - fee).toFixed(2), currency)} after the {(tap.feeBps / 100).toFixed(2)}% card fee.</p>
          )}
          <ErrorText error={error} />
          <button className="btn block lg" disabled={!amount || Number(amount) <= 0}>Take {amount ? money(amount, currency) : "payment"}</button>
          <p className="faint small" style={{ margin: 0, textAlign: "center" }}>The customer taps their card or phone (Apple Pay, Google Pay, Samsung Pay) on the {platform === "ios" ? "top" : "back"} of this phone.</p>
        </form>
      )}
      {(state === "tapping" || state === "checking") && (
        <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 14 }}>
          <div className="nfc-pulse" aria-hidden="true"><span /><span /><span />
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 7.5a6.5 6.5 0 0 1 0 9M10.5 5a10 10 0 0 1 0 14M14 3a13.5 13.5 0 0 1 0 18" /></svg>
          </div>
          <div className="stat-value num">{payment ? money(payment.amount, payment.currency) : ""}</div>
          <p>{state === "tapping" ? "Hand the phone to the customer to tap their card or phone." : "Confirming with the card network…"}</p>
          {state === "tapping" && <button className="btn ghost sm" onClick={() => void cancel()}>Cancel</button>}
        </div>
      )}
      {state === "done" && payment && (
        <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 12 }}>
          <div className="stat-value num">{money(payment.amount, payment.currency)}</div>
          <p style={{ fontWeight: 600 }}>Paid. It's in your wallet.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" onClick={() => { setAmount(""); setNote(""); setPayment(null); setState("form"); }}>Take another</button>
            <button className="btn sm" onClick={() => { toast("Payment received"); onClose(); }}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Whether this business can take Tap to Pay payments here (the Aurex app, an approved business, switched on). */
export function useTapToPay() {
  const [tap, setTap] = useState<TapOverview | null>(null);
  useEffect(() => {
    if (!isNative) return;
    void api.get<TapOverview>("/api/tap").then(setTap).catch(() => setTap(null));
  }, []);
  return tap && tap.available && tap.merchant && tap.locationId ? tap : null;
}
