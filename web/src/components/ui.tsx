import { useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "../state";
import { Icon } from "./icons";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { maxWidth: 620 } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">
            <Icon.X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function CurrencySelect({
  value,
  onChange,
  only,
  ariaLabel = "Currency",
  className = "input",
}: {
  value: string;
  onChange: (v: string) => void;
  only?: string[];
  ariaLabel?: string;
  className?: string;
}) {
  const { meta } = useAuth();
  const list = (meta?.currencies ?? [{ code: "USD", name: "US Dollar" }]).filter((c) => !only || only.includes(c.code));
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      {list.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code}
        </option>
      ))}
    </select>
  );
}

/** Amount + currency in one control. */
export function AmountInput({
  amount,
  currency,
  onAmount,
  onCurrency,
  currencies,
}: {
  amount: string;
  currency: string;
  onAmount: (v: string) => void;
  onCurrency: (v: string) => void;
  currencies?: string[];
}) {
  return (
    <div className="input-group">
      <input
        className="input num"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => onAmount(e.target.value.replace(/[^\d.]/g, ""))}
        aria-label="Amount"
        required
      />
      <CurrencySelect value={currency} onChange={onCurrency} only={currencies} />
    </div>
  );
}

/** Signed change with an arrow so direction never relies on color alone. */
export function Delta({ value, children, suffix = "" }: { value: number; children?: ReactNode; suffix?: string }) {
  const cls = value > 0 ? "good" : value < 0 ? "bad" : "muted";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "•";
  return (
    <span className={`${cls} num`} style={{ whiteSpace: "nowrap", position: "relative" }}>
      <span aria-hidden="true" style={{ fontSize: "0.75em", marginRight: 3 }}>{arrow}</span>
      <span className="sr-only">{value > 0 ? "up " : value < 0 ? "down " : ""}</span>
      {children ?? `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error-text" role="alert">
      {error}
    </p>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "good",
    filled: "good",
    paid: "good",
    pending: "warn",
    new: "warn",
    accepted: "warn",
    partially_filled: "warn",
    failed: "bad",
    rejected: "bad",
    declined: "bad",
    canceled: "",
    expired: "",
  };
  return <span className={`pill ${map[status] ?? ""}`}>{status.replace(/_/g, " ")}</span>;
}
