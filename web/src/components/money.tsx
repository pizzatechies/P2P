import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { money, timeAgo } from "../format";
import { useAuth, useToast } from "../state";
import type { Activity, Profile } from "../types";
import { Icon } from "./icons";
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

export function SendDialog({ onClose, onDone, initialTo = "" }: { onClose: () => void; onDone: () => void; initialTo?: string }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(initialTo);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [memo, setMemo] = useState("");
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

export function DepositDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const rails = (meta?.rails ?? []).filter((r) => r.supportsDeposit);
  const [rail, setRail] = useState(rails[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = rails.find((r) => r.id === rail);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ transfer: { status: string }; redirectUrl: string | null }>("/api/payments/deposits", { rail, amount, currency });
      if (r.redirectUrl) {
        window.location.href = r.redirectUrl;
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
  return (
    <Modal title="Add money" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Method">
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
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount}>{busy ? "Processing…" : "Add money"}</button>
      </form>
    </Modal>
  );
}

export function WithdrawDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user, meta } = useAuth();
  const toast = useToast();
  const rails = (meta?.rails ?? []).filter((r) => r.supportsWithdrawal);
  const [rail, setRail] = useState(rails[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
  const [dest, setDest] = useState({ type: "bank_account", name: "", accountNumber: "", bankCode: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(idempotencyKey);
  const selected = rails.find((r) => r.id === rail);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/payments/withdrawals", {
        rail,
        amount,
        currency,
        idempotencyKey: key,
        destination: { ...dest, bankCode: dest.bankCode || undefined },
      });
      toast(`Withdrawal of ${money(amount, currency)} sent`);
      onDone();
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
  return (
    <Modal title="Withdraw" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Method">
          <select className="input" value={rail} onChange={(e) => setRail(e.target.value)}>
            {rails.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        {selected?.simulated && (
          <div className="banner">Sandbox payouts are simulated. Account numbers ending in 0000 fail on purpose, so you can see a reversal.</div>
        )}
        <Field label="Amount">
          <AmountInput amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} />
        </Field>
        <div className="grid grid-2">
          <Field label="Send to">
            <select className="input" value={dest.type} onChange={(e) => setDest({ ...dest, type: e.target.value })}>
              <option value="bank_account">Bank account</option>
              <option value="mobile_money">Mobile money</option>
              <option value="card">Debit card</option>
            </select>
          </Field>
          <Field label="Account holder">
            <input className="input" value={dest.name} onChange={(e) => setDest({ ...dest, name: e.target.value })} required minLength={2} />
          </Field>
        </div>
        <div className="grid grid-2">
          <Field label={dest.type === "mobile_money" ? "Phone number" : "Account number"}>
            <input className="input num" value={dest.accountNumber} onChange={(e) => setDest({ ...dest, accountNumber: e.target.value })} required minLength={4} />
          </Field>
          <Field label={dest.type === "mobile_money" ? "Network (optional)" : "Bank / routing code (optional)"}>
            <input className="input" value={dest.bankCode} onChange={(e) => setDest({ ...dest, bankCode: e.target.value })} />
          </Field>
        </div>
        <ErrorText error={error} />
        <button className="btn block lg" disabled={busy || !amount}>{busy ? "Sending…" : "Withdraw"}</button>
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
