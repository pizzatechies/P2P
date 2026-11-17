import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { money, timeAgo } from "../format";
import { useAuth, useToast } from "../state";
import type { Activity, Profile, Rail } from "../types";
import { Icon } from "./icons";
import { RequirementsForm, type RequirementsValue } from "./requirements";
import { AmountInput, Empty, ErrorText, Field, Modal, StatusPill } from "./ui";

/** Recipient field with live user search by handle, name or email. */
function RecipientInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [results, setResults] = useState<Profile[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = value.replace(/^@/, "");
    if (q.length < 2) return setResults([]);
    timer.current = window.setTimeout(() => {
      api
        .get<{ users: Profile[] }>(`/api/payments/users/search?q=${encodeURIComponent(q)}`)
        .then((r) => setResults(r.users))
        .catch(() => setResults([]));
    }, 200);
  }, [value]);
  return (
    <div style={{ position: "relative" }}>
      <input
        className="input"
        placeholder="@handle or email"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
        required
        aria-label="Recipient"
      />
      {open && results.length > 0 && (
        <div className="card" style={{ position: "absolute", top: 44, left: 0, right: 0, padding: 4, zIndex: 5 }}>
          {results.map((u) => (
            <button
              type="button"
              key={u.id}
              className="conv-item"
              onMouseDown={() => {
                onChange(`@${u.handle}`);
                setOpen(false);
              }}
            >
              <span>
                <strong>{u.displayName}</strong> <span className="faint">@{u.handle}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SendDialog({
  onClose,
  onDone,
  initialTo = "",
  initialAmount = "",
  initialCurrency,
  initialMemo = "",
}: {
  onClose: () => void;
  onDone: () => void;
  initialTo?: string;
  initialAmount?: string;
  initialCurrency?: string;
  initialMemo?: string;
}) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(initialTo);
  const [amount, setAmount] = useState(initialAmount);
  const [currency, setCurrency] = useState(initialCurrency ?? user?.defaultCurrency ?? "USD");
  const [memo, setMemo] = useState(initialMemo);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(idempotencyKey);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ transfer: { amount: string; currency: string; to: Profile } }>("/api/payments/send", {
        to,
        amount,
        currency,
        memo: memo || undefined,
        idempotencyKey: key,
      });
      toast(`Sent ${money(r.transfer.amount, r.transfer.currency)} to @${r.transfer.to.handle}`);
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send money" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="To">
          <RecipientInput value={to} onChange={setTo} />
        </Field>
        <Field label="Amount" hint={meta && meta.fees.p2pBps > 0 ? `Fee: ${(meta.fees.p2pBps / 100).toFixed(2)}%` : "No fee for sending"}>
          <AmountInput amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} />
        </Field>
        <Field label="What's it for? (optional)">
          <input className="input" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Dinner, rent, birthday…" />
        </Field>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount || !to}>
          {busy ? "Sending…" : amount ? `Send ${money(amount || 0, currency)}` : "Send"}
        </button>
      </form>
    </Modal>
  );
}

export function RequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/payments/requests", { from, amount, currency, memo: memo || undefined });
      toast(`Requested ${money(amount, currency)} from ${from}`);
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Request money" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="From">
          <RecipientInput value={from} onChange={setFrom} />
        </Field>
        <Field label="Amount">
          <AmountInput amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} />
        </Field>
        <Field label="Note (optional)">
          <input className="input" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount || !from}>{busy ? "Sending request…" : "Request"}</button>
      </form>
    </Modal>
  );
}

const PHONE_KEY = "aurex-last-phone";
const remembered = () => {
  try {
    return localStorage.getItem(PHONE_KEY) ?? "";
  } catch {
    return "";
  }
};
const remember = (phone: string) => {
  try {
    localStorage.setItem(PHONE_KEY, phone);
  } catch {
    /* storage unavailable */
  }
};

/** Keeps the currency valid for the chosen method (e.g. M-Pesa is KES only). */
function useRailCurrency(rail: Rail | undefined, currency: string, setCurrency: (c: string) => void) {
  useEffect(() => {
    if (rail && rail.currencies !== "*" && !rail.currencies.includes(currency)) setCurrency(rail.currencies[0]);
  }, [rail, currency, setCurrency]);
}

interface PendingDeposit {
  id: string;
  instructions: string;
  amount: string;
  currency: string;
}

export function DepositDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const rails = (meta?.rails ?? []).filter((r) => r.supportsDeposit);
  const [rail, setRail] = useState(rails[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [phone, setPhone] = useState(remembered);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<PendingDeposit | null>(null);
  const [slow, setSlow] = useState(false);
  const selected = rails.find((r) => r.id === rail);
  useRailCurrency(selected, currency, setCurrency);

  // While the user approves on their phone, ask the provider (through Aurex) every few seconds.
  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    let stopped = false;
    setSlow(false);
    const tick = async () => {
      if (stopped) return;
      tries++;
      try {
        const { transfer } = await api.post<{ transfer: { status: string; failureReason: string | null } }>(`/api/payments/transfers/${waiting.id}/refresh`);
        if (stopped) return;
        if (transfer.status === "completed") {
          toast(`Added ${money(waiting.amount, waiting.currency)} to your wallet`);
          onDone();
          onClose();
          return;
        }
        if (transfer.status === "failed") {
          setWaiting(null);
          setError(`The payment wasn't completed${transfer.failureReason ? `: ${transfer.failureReason}` : ""}. No money was taken.`);
          onDone();
          return;
        }
      } catch {
        /* keep trying */
      }
      if (tries >= 30) setSlow(true);
      else timer = setTimeout(tick, 4000);
    };
    let timer = setTimeout(tick, 4000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const needsPhone = selected?.depositInput === "phone";
      const r = await api.post<{ transfer: { id: string; status: string }; redirectUrl: string | null; instructions: string | null }>("/api/payments/deposits", {
        rail,
        amount,
        currency,
        ...(needsPhone ? { phone } : {}),
      });
      if (needsPhone) remember(phone);
      if (r.redirectUrl) {
        window.location.href = r.redirectUrl;
        return;
      }
      if (r.transfer.status === "pending") {
        setWaiting({ id: r.transfer.id, instructions: r.instructions ?? "Finish the payment with your provider.", amount, currency });
        onDone();
        return;
      }
      toast(`Added ${money(amount, currency)} to your wallet`);
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (rails.length === 0) {
    return (
      <Modal title="Add money" onClose={onClose}>
        <p className="muted">No deposit methods are enabled on this server yet.</p>
      </Modal>
    );
  }
  if (waiting) {
    return (
      <Modal title="Approve on your phone" onClose={onClose}>
        <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
          <span className="phone-pulse" aria-hidden="true"><Icon.Phone size={28} /></span>
          <div className="stat-value num">{money(waiting.amount, waiting.currency)}</div>
          <p>{waiting.instructions}</p>
          {slow ? (
            <p className="muted small">Still waiting. You can close this window; your wallet updates as soon as the payment is confirmed.</p>
          ) : (
            <p className="muted small"><span className="spinner" /> Waiting for confirmation…</p>
          )}
          <div className="row" style={{ justifyContent: "center" }}>
            {slow && <button className="btn secondary" onClick={() => setWaiting({ ...waiting })}>Check again</button>}
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Add money" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Method" hint={selected?.description}>
          <select className="input" value={rail} onChange={(e) => setRail(e.target.value)}>
            {rails.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        {selected?.simulated && <div className="banner">This is test money. No real funds move with {selected.name}.</div>}
        <Field label="Amount">
          <AmountInput
            amount={amount}
            currency={currency}
            onAmount={setAmount}
            onCurrency={setCurrency}
            currencies={selected && selected.currencies !== "*" ? selected.currencies : undefined}
          />
        </Field>
        {selected?.depositInput === "phone" && (
          <Field label={`${selected.name} number`} hint={selected.phoneHint ? `e.g. ${selected.phoneHint}` : undefined}>
            <input className="input num" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required minLength={9} />
          </Field>
        )}
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount}>
          {busy ? "Processing…" : selected?.depositInput === "phone" ? "Send payment prompt" : "Add money"}
        </button>
      </form>
    </Modal>
  );
}

type Dest = { type: string; name: string; accountNumber: string; bankCode: string; email: string; wallet: "paypal" | "venmo"; firstName: string; lastName: string; country: string };

/** Countries offered for MoneyGram cash pickup (the server maps these to MoneyGram's codes). */
const PICKUP_COUNTRIES: [string, string][] = [
  ["BJ", "Benin"], ["BO", "Bolivia"], ["BR", "Brazil"], ["BD", "Bangladesh"], ["BF", "Burkina Faso"], ["CA", "Canada"], ["CM", "Cameroon"], ["CN", "China"],
  ["CO", "Colombia"], ["CD", "DR Congo"], ["CI", "Côte d'Ivoire"], ["DE", "Germany"], ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["EG", "Egypt"],
  ["ES", "Spain"], ["ET", "Ethiopia"], ["FR", "France"], ["GB", "United Kingdom"], ["GH", "Ghana"], ["GT", "Guatemala"], ["HN", "Honduras"], ["HT", "Haiti"],
  ["ID", "Indonesia"], ["IN", "India"], ["IT", "Italy"], ["JM", "Jamaica"], ["JO", "Jordan"], ["KE", "Kenya"], ["LB", "Lebanon"], ["LK", "Sri Lanka"],
  ["LR", "Liberia"], ["MA", "Morocco"], ["ML", "Mali"], ["MW", "Malawi"], ["MX", "Mexico"], ["MY", "Malaysia"], ["MZ", "Mozambique"], ["NG", "Nigeria"],
  ["NI", "Nicaragua"], ["NL", "Netherlands"], ["NP", "Nepal"], ["PE", "Peru"], ["PH", "Philippines"], ["PK", "Pakistan"], ["PL", "Poland"], ["PT", "Portugal"],
  ["RO", "Romania"], ["RW", "Rwanda"], ["SA", "Saudi Arabia"], ["SL", "Sierra Leone"], ["SN", "Senegal"], ["SV", "El Salvador"], ["TG", "Togo"], ["TH", "Thailand"],
  ["TR", "Türkiye"], ["TZ", "Tanzania"], ["AE", "United Arab Emirates"], ["UA", "Ukraine"], ["UG", "Uganda"], ["US", "United States"], ["VN", "Vietnam"],
  ["ZA", "South Africa"], ["ZM", "Zambia"], ["ZW", "Zimbabwe"],
].sort((a, b) => a[1].localeCompare(b[1])) as [string, string][];

export function WithdrawDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const rails = (meta?.rails ?? []).filter((r) => r.supportsWithdrawal);
  const [rail, setRail] = useState(rails[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [dest, setDest] = useState<Dest>({ type: "bank_account", name: "", accountNumber: "", bankCode: "", email: "", wallet: "paypal", firstName: "", lastName: "", country: "" });
  const [pickup, setPickup] = useState<{ reference: string; amount: string; currency: string; name: string } | null>(null);
  const [reqs, setReqs] = useState<RequirementsValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(idempotencyKey);
  const selected = rails.find((r) => r.id === rail);
  const input = selected?.payoutInput ?? "bank";
  useRailCurrency(selected, currency, setCurrency);

  function destination() {
    if (input === "phone") return { type: "mobile_money", name: dest.name, accountNumber: dest.accountNumber };
    if (input === "email") return { type: "email", name: dest.name, email: dest.email, wallet: selected?.walletOptions?.length ? dest.wallet : undefined };
    if (input === "cash_pickup") {
      return { type: "cash_pickup", name: `${dest.firstName} ${dest.lastName}`.trim(), firstName: dest.firstName, lastName: dest.lastName, country: dest.country };
    }
    if (input === "requirements") {
      return { type: "wise", name: reqs?.details.accountHolderName ?? dest.name, wiseType: reqs?.type, details: reqs?.details };
    }
    return { type: dest.type, name: dest.name, accountNumber: dest.accountNumber, bankCode: dest.bankCode || undefined };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ transfer: { payoutReference: string | null; review?: string | null } }>("/api/payments/withdrawals", { rail, amount, currency, idempotencyKey: key, destination: destination() });
      onDone();
      if (r.transfer.review === "required") {
        toast(`Withdrawal of ${money(amount, currency)} is being checked. We'll send it shortly; the money is set aside meanwhile.`);
        onClose();
        return;
      }
      if (r.transfer.payoutReference) {
        setPickup({ reference: r.transfer.payoutReference, amount, currency, name: `${dest.firstName} ${dest.lastName}`.trim() });
        return;
      }
      toast(`Withdrawal of ${money(amount, currency)} sent`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.code === "payout_failed") onDone();
    } finally {
      setBusy(false);
    }
  }

  if (rails.length === 0) {
    return (
      <Modal title="Withdraw" onClose={onClose}>
        <p className="muted">No withdrawal methods are enabled on this server yet.</p>
      </Modal>
    );
  }
  const holder = (
    <Field label="Account holder">
      <input className="input" value={dest.name} onChange={(e) => setDest({ ...dest, name: e.target.value })} required minLength={2} autoComplete="name" />
    </Field>
  );
  const blocked = input === "requirements" && !reqs?.valid;
  if (pickup) {
    return (
      <Modal title="Ready for cash pickup" onClose={onClose}>
        <div className="stack" style={{ textAlign: "center", alignItems: "center" }}>
          <p className="muted small">{pickup.name} can collect {money(pickup.amount, pickup.currency)} (in local currency) at any MoneyGram location in the country you chose.</p>
          <div className="stat-label">MoneyGram reference number</div>
          <div className="stat-value mono" style={{ fontSize: 30, letterSpacing: "0.08em" }}>{pickup.reference}</div>
          <p className="small">Share it only with the recipient. They'll need it and an ID that matches the name exactly. It's also saved under Deposits &amp; withdrawals.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button className="btn secondary" onClick={() => navigator.clipboard?.writeText(pickup.reference).then(() => toast("Copied"), () => undefined)}>Copy</button>
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Withdraw" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Method" hint={selected?.description}>
          <select className="input" value={rail} onChange={(e) => setRail(e.target.value)}>
            {rails.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        {selected?.simulated && rail === "sandbox" && (
          <div className="banner">Sandbox payouts are simulated. Account numbers ending in 0000 fail on purpose, so you can see a reversal.</div>
        )}
        {selected?.simulated && rail !== "sandbox" && <div className="banner">{selected.name} is in test mode. No real money moves.</div>}
        <Field label="Amount">
          <AmountInput
            amount={amount}
            currency={currency}
            onAmount={setAmount}
            onCurrency={setCurrency}
            currencies={selected && selected.currencies !== "*" ? selected.currencies : undefined}
          />
        </Field>

        {input === "phone" && (
          <div className="grid grid-2">
            {holder}
            <Field label={`${selected?.name ?? "Mobile money"} number`} hint={selected?.phoneHint ? `e.g. ${selected.phoneHint}` : undefined}>
              <input className="input num" type="tel" inputMode="tel" value={dest.accountNumber} onChange={(e) => setDest({ ...dest, accountNumber: e.target.value })} required minLength={9} />
            </Field>
          </div>
        )}

        {input === "email" && (
          <>
            {(selected?.walletOptions?.length ?? 0) > 1 && (
              <div className="seg" role="radiogroup" aria-label="Send to">
                {selected!.walletOptions!.map((w) => (
                  <button type="button" key={w} role="radio" aria-checked={dest.wallet === w} className={dest.wallet === w ? "on" : ""} onClick={() => setDest({ ...dest, wallet: w })}>
                    {w === "paypal" ? "PayPal" : "Venmo (US, USD)"}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-2">
              {holder}
              <Field label={selected?.payoutLabel ?? `${dest.wallet === "venmo" ? "Venmo" : "PayPal"} email or phone`}>
                <input
                  className="input"
                  type={selected?.walletOptions?.length ? "text" : "email"}
                  value={dest.email}
                  onChange={(e) => setDest({ ...dest, email: e.target.value })}
                  required
                  minLength={5}
                  autoComplete="email"
                />
              </Field>
            </div>
          </>
        )}

        {input === "cash_pickup" && (
          <>
            <p className="muted small" style={{ margin: 0 }}>The recipient collects the cash at a MoneyGram location with a reference number and an ID. It can be you or someone else.</p>
            <div className="grid grid-2">
              <Field label="Recipient's first name" hint="Exactly as on their ID">
                <input className="input" value={dest.firstName} onChange={(e) => setDest({ ...dest, firstName: e.target.value })} required maxLength={40} autoComplete="given-name" />
              </Field>
              <Field label="Last name">
                <input className="input" value={dest.lastName} onChange={(e) => setDest({ ...dest, lastName: e.target.value })} required maxLength={40} autoComplete="family-name" />
              </Field>
            </div>
            <Field label="Pickup country">
              <select className="input" value={dest.country} onChange={(e) => setDest({ ...dest, country: e.target.value })} required>
                <option value="">Choose…</option>
                {PICKUP_COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </Field>
          </>
        )}

        {input === "requirements" && <RequirementsForm rail={rail} currency={currency} amount={amount} onChange={setReqs} />}

        {(input === "bank" || input === "bank_code") && (
          <>
            <div className="grid grid-2">
              <Field label="Send to">
                <select className="input" value={dest.type} onChange={(e) => setDest({ ...dest, type: e.target.value })}>
                  <option value="bank_account">Bank account</option>
                  <option value="mobile_money">Mobile money</option>
                  {input === "bank" && <option value="card">Debit card</option>}
                </select>
              </Field>
              {holder}
            </div>
            <div className="grid grid-2">
              <Field label={dest.type === "mobile_money" ? "Phone number" : "Account number"}>
                <input className="input num" value={dest.accountNumber} onChange={(e) => setDest({ ...dest, accountNumber: e.target.value })} required minLength={4} />
              </Field>
              <Field
                label={`${dest.type === "mobile_money" ? "Network code" : "Bank code"}${input === "bank_code" ? "" : " (optional)"}`}
                hint={input === "bank_code" ? (dest.type === "mobile_money" ? "e.g. MPS for M-Pesa, MTN for MTN MoMo" : "Your bank's code from Flutterwave's bank list") : undefined}
              >
                <input className="input" value={dest.bankCode} onChange={(e) => setDest({ ...dest, bankCode: e.target.value.toUpperCase() })} required={input === "bank_code"} />
              </Field>
            </div>
          </>
        )}
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount || blocked}>{busy ? "Sending…" : "Withdraw"}</button>
      </form>
    </Modal>
  );
}

export function ConvertDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(user?.defaultCurrency ?? "USD");
  const [to, setTo] = useState(user?.defaultCurrency === "EUR" ? "USD" : "EUR");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ toAmount: string; rate: number; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(idempotencyKey);

  useEffect(() => {
    setQuote(null);
    if (!amount || Number(amount) <= 0 || from === to) return;
    const t = setTimeout(() => {
      api
        .get<{ quote: { toAmount: string; rate: number; source: string } }>(`/api/payments/fx/quote?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`)
        .then((r) => setQuote(r.quote))
        .catch(() => setQuote(null));
    }, 250);
    return () => clearTimeout(t);
  }, [amount, from, to]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/payments/convert", { from, to, amount, idempotencyKey: key });
      toast(`Converted ${money(amount, from)} to ${to}`);
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Convert currency" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="You convert">
          <AmountInput amount={amount} currency={from} onAmount={setAmount} onCurrency={setFrom} />
        </Field>
        <Field label="Into">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {(meta?.currencies ?? []).filter((c) => c.code !== from).map((c) => (
              <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
            ))}
          </select>
        </Field>
        <div className="card" style={{ background: "var(--surface-2)", boxShadow: "none" }}>
          <div className="stat-label">You receive</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{quote ? money(quote.toAmount, to) : "—"}</div>
          {quote && (
            <div className="stat-sub">
              1 {from} = {quote.rate.toFixed(4)} {to} · includes {((meta?.fees.fxSpreadBps ?? 0) / 100).toFixed(2)}% spread
              {quote.source === "static" && " · indicative rate"}
            </div>
          )}
        </div>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !quote}>{busy ? "Converting…" : "Convert"}</button>
      </form>
    </Modal>
  );
}

function describe(a: Activity) {
  switch (a.kind) {
    case "transfer":
      return a.direction === "in" ? `From ${a.counterparty?.displayName ?? "someone"}` : `To ${a.counterparty?.displayName ?? "someone"}`;
    case "deposit":
      return "Added money";
    case "withdrawal":
      return "Withdrawal";
    case "withdrawal_reversal":
      return "Withdrawal returned";
    case "fx":
      return "Currency conversion";
    default:
      return a.kind;
  }
}

export function ActivityList({ items, compact }: { items: Activity[]; compact?: boolean }) {
  if (items.length === 0) return <Empty>No activity yet. Add money or send your first payment.</Empty>;
  return (
    <div className="list">
      {items.map((a) => (
        <div className="list-item" key={a.id}>
          <span className={`tx-icon ${a.direction}`}>
            {a.kind === "fx" ? <Icon.Swap size={16} /> : a.direction === "in" ? <Icon.ArrowDown size={16} /> : <Icon.ArrowUp size={16} />}
          </span>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>
              {describe(a)}
              {a.counterparty && <span className="faint small"> @{a.counterparty.handle}</span>}
            </div>
            <div className="faint small">
              {a.memo && a.kind === "transfer" ? `${a.memo} · ` : ""}
              {timeAgo(a.createdAt)}
              {a.fee ? ` · fee ${a.fee}` : ""}
              {!compact && a.rate ? ` · rate ${a.rate.toFixed(4)}` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {a.amounts.map((m) => (
              <div key={m.currency} className={`num ${m.amountMinor > 0 ? "good" : ""}`} style={{ fontWeight: 600 }}>
                {money(m.amount, m.currency, { signed: true })}
              </div>
            ))}
            {a.status !== "completed" && <StatusPill status={a.status} />}
          </div>
        </div>
      ))}
    </div>
  );
}
