import type { Ctx } from "../context.js";
import { badRequest } from "../lib/errors.js";
import { assertCurrency, CURRENCY_CODES } from "../lib/money.js";

/**
 * Indicative fallback rates (units per 1 USD). Used when live rates are disabled or unreachable.
 * Turn on FX_LIVE=true in production so conversions use current market rates.
 */
const STATIC_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.37,
  AUD: 1.52,
  CHF: 0.88,
  JPY: 150,
  CNY: 7.2,
  INR: 84,
  AED: 3.6725,
  BRL: 5.6,
  MXN: 18.5,
  ZAR: 18,
  NGN: 1550,
  KES: 129,
  ZMW: 26.5,
  GHS: 15.5,
  UGX: 3700,
  TZS: 2600,
};

export interface RateTable {
  base: "USD";
  rates: Record<string, number>;
  source: "live" | "static";
  asOf: string;
}

let cache: RateTable | null = null;
let cacheExpires = 0;

export async function getRates(ctx: Ctx): Promise<RateTable> {
  if (cache && Date.now() < cacheExpires) return cache;
  if (ctx.config.FX_LIVE) {
    try {
      const res = await fetch(ctx.config.FX_RATES_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { rates?: Record<string, number> };
      if (!body.rates?.USD) throw new Error("Unexpected rates payload");
      const rates: Record<string, number> = {};
      for (const code of CURRENCY_CODES) {
        rates[code] = body.rates[code] ?? STATIC_RATES[code];
      }
      cache = { base: "USD", rates, source: "live", asOf: new Date().toISOString() };
      cacheExpires = Date.now() + 60 * 60_000;
      return cache;
    } catch (err) {
      console.warn(`[fx] live rates unavailable, using static table: ${(err as Error).message}`);
    }
  }
  cache = { base: "USD", rates: { ...STATIC_RATES }, source: "static", asOf: "indicative" };
  cacheExpires = Date.now() + 10 * 60_000;
  return cache;
}

/** Mid-market rate: how many `to` units one `from` unit buys. */
export function midRate(table: RateTable, from: string, to: string): number {
  const f = table.rates[from];
  const t = table.rates[to];
  if (!f || !t) throw badRequest(`No exchange rate for ${from}/${to}`);
  return t / f;
}

/** Converts minor units between currencies at `rate`, rounding down so the house never over-pays. */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  const df = assertCurrency(from).decimals;
  const dt = assertCurrency(to).decimals;
  const raw = (amountMinor / 10 ** df) * rate * 10 ** dt;
  return Math.floor(raw + 1e-9);
}

export async function quote(ctx: Ctx, from: string, to: string, amountMinor: number) {
  if (from === to) throw badRequest("Pick two different currencies");
  const table = await getRates(ctx);
  const mid = midRate(table, from, to);
  const applied = mid * (1 - ctx.config.FX_SPREAD_BPS / 10_000);
  return {
    from,
    to,
    amountMinor,
    midRate: mid,
    rate: applied,
    spreadBps: ctx.config.FX_SPREAD_BPS,
    toAmountMinor: convertMinor(amountMinor, from, to, applied),
    source: table.source,
    asOf: table.asOf,
  };
}

/** USD-equivalent of an amount, for risk limits. */
export async function toUsdMinor(ctx: Ctx, currency: string, amountMinor: number): Promise<number> {
  if (currency === "USD") return amountMinor;
  const table = await getRates(ctx);
  return convertMinor(amountMinor, currency, "USD", midRate(table, currency, "USD"));
}
