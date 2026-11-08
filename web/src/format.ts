const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function money(amount: string | number, currency: string, opts: { signed?: boolean } = {}) {
  const key = `${currency}:${opts.signed ? 1 : 0}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, { style: "currency", currency, signDisplay: opts.signed ? "exceptZero" : "auto" });
    } catch {
      f = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 });
    }
    moneyFormatters.set(key, f);
  }
  return f.format(Number(amount));
}

export const usd = (n: number, signed = false) => money(n, "USD", { signed });

export function compactUsd(n: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: Math.abs(n) >= 100_000 ? "compact" : "standard", maximumFractionDigits: Math.abs(n) >= 100_000 ? 1 : 2 }).format(n);
}

export function pct(n: number | null | undefined, digits = 2, signed = true) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = n.toFixed(digits);
  return `${signed && n > 0 ? "+" : ""}${s}%`;
}

export function num(n: number | null | undefined, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function qty(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
