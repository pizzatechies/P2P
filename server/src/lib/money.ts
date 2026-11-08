import { badRequest } from "./errors.js";

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}

const list: CurrencyInfo[] = [
  { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimals: 2 },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2 },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", decimals: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0 },
  { code: "CNY", name: "Chinese Yuan", symbol: "CN¥", decimals: 2 },
  { code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2 },
  { code: "AED", name: "UAE Dirham", symbol: "AED", decimals: 2 },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", decimals: 2 },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$", decimals: 2 },
  { code: "ZAR", name: "South African Rand", symbol: "R", decimals: 2 },
  { code: "NGN", name: "Nigerian Naira", symbol: "₦", decimals: 2 },
  { code: "KES", name: "Kenyan Shilling", symbol: "KSh", decimals: 2 },
  { code: "ZMW", name: "Zambian Kwacha", symbol: "ZK", decimals: 2 },
  { code: "GHS", name: "Ghanaian Cedi", symbol: "GH₵", decimals: 2 },
  { code: "UGX", name: "Ugandan Shilling", symbol: "USh", decimals: 0 },
  { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh", decimals: 2 },
];

export const CURRENCIES: Record<string, CurrencyInfo> = Object.fromEntries(list.map((c) => [c.code, c]));
export const CURRENCY_CODES = list.map((c) => c.code);

export function assertCurrency(code: string): CurrencyInfo {
  const info = CURRENCIES[code?.toUpperCase?.()];
  if (!info) throw badRequest(`Unsupported currency: ${code}`);
  return info;
}

/**
 * Parses a decimal amount ("12.5", "1000", 12.5) into integer minor units without ever using
 * floating-point arithmetic. Rejects negative values, garbage and too many decimal places.
 */
export function toMinor(amount: string | number, currency: string): number {
  const { decimals } = assertCurrency(currency);
  const str = typeof amount === "number" ? String(amount) : amount.trim();
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(str);
  if (!m) throw badRequest("Amount must be a positive number like 25 or 25.50");
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) {
    throw badRequest(`${currency} supports at most ${decimals} decimal place${decimals === 1 ? "" : "s"}`);
  }
  const minor = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  if (!Number.isSafeInteger(minor)) throw badRequest("Amount is too large");
  return minor;
}

/** Formats integer minor units as a plain decimal string, e.g. 1234 USD -> "12.34". */
export function fromMinor(minor: number, currency: string): string {
  const { decimals } = assertCurrency(currency);
  if (decimals === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** decimals);
  const frac = String(abs % 10 ** decimals).padStart(decimals, "0");
  return `${sign}${whole}.${frac}`;
}

/** Basis-point fee, rounded half-up to the nearest minor unit. */
export function bps(amountMinor: number, basisPoints: number): number {
  if (basisPoints <= 0) return 0;
  return Math.floor((amountMinor * basisPoints + 5000) / 10000);
}
