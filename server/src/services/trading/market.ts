import type { Ctx } from "../../context.js";
import { badRequest, HttpError, notFound } from "../../lib/errors.js";
import { getUserKey } from "../keys.js";

export interface Bar {
  t: string; // ISO date (daily bars)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  asOf: string;
  source: "simulated" | "alpaca";
}

export interface MarketData {
  source: "simulated" | "alpaca";
  quote(symbol: string): Promise<Quote>;
  bars(symbol: string, days: number): Promise<Bar[]>;
}

export const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function normalizeSymbol(raw: string) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw badRequest("Ticker symbols are 1-10 letters, e.g. AAPL");
  return s;
}

// ---------------------------------------------------------------------------
// Simulated market: deterministic, so every user sees the same prices and charts are stable.
// ---------------------------------------------------------------------------
export const SIM_SYMBOLS: { symbol: string; name: string; base: number; vol: number }[] = [
  { symbol: "AAPL", name: "Apple Inc.", base: 230, vol: 0.25 },
  { symbol: "MSFT", name: "Microsoft Corp.", base: 420, vol: 0.22 },
  { symbol: "NVDA", name: "NVIDIA Corp.", base: 140, vol: 0.45 },
  { symbol: "GOOGL", name: "Alphabet Inc.", base: 175, vol: 0.28 },
  { symbol: "AMZN", name: "Amazon.com Inc.", base: 200, vol: 0.3 },
  { symbol: "META", name: "Meta Platforms Inc.", base: 580, vol: 0.35 },
  { symbol: "TSLA", name: "Tesla Inc.", base: 250, vol: 0.55 },
  { symbol: "AMD", name: "Advanced Micro Devices", base: 150, vol: 0.45 },
  { symbol: "NFLX", name: "Netflix Inc.", base: 700, vol: 0.35 },
  { symbol: "PLTR", name: "Palantir Technologies", base: 45, vol: 0.6 },
  { symbol: "INTC", name: "Intel Corp.", base: 22, vol: 0.45 },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", base: 220, vol: 0.2 },
  { symbol: "V", name: "Visa Inc.", base: 290, vol: 0.18 },
  { symbol: "BRK.B", name: "Berkshire Hathaway B", base: 450, vol: 0.15 },
  { symbol: "WMT", name: "Walmart Inc.", base: 85, vol: 0.18 },
  { symbol: "KO", name: "Coca-Cola Co.", base: 65, vol: 0.14 },
  { symbol: "DIS", name: "Walt Disney Co.", base: 100, vol: 0.27 },
  { symbol: "XOM", name: "Exxon Mobil Corp.", base: 115, vol: 0.25 },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", base: 570, vol: 0.15 },
  { symbol: "QQQ", name: "Invesco QQQ (Nasdaq-100) ETF", base: 490, vol: 0.2 },
];
const SIM_BY_SYMBOL = new Map(SIM_SYMBOLS.map((s) => [s.symbol, s]));

function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic standard normal for a given key (Box-Muller over two hashed uniforms). */
function gaussian(key: string): number {
  const u1 = (hash32(key + ":a") + 1) / 4294967297;
  const u2 = (hash32(key + ":b") + 1) / 4294967297;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const EPOCH = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

const dailyCache = new Map<string, Bar[]>();

/** Daily closes from a fixed epoch to yesterday: mean-reverting geometric random walk (weekdays only). */
function simDailyBars(symbol: string): Bar[] {
  const spec = SIM_BY_SYMBOL.get(symbol)!;
  const today = Math.floor(Date.now() / DAY);
  const cacheKey = `${symbol}:${today}`;
  const cached = dailyCache.get(cacheKey);
  if (cached) return cached;

  const sigma = spec.vol / Math.sqrt(252);
  const bars: Bar[] = [];
  let close = spec.base * (0.85 + (hash32(symbol) % 300) / 1000);
  for (let d = Math.floor(EPOCH / DAY); d < today; d++) {
    const dow = new Date(d * DAY).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const z = gaussian(`${symbol}:${d}`);
    const revert = -0.6 * Math.log(close / spec.base) / 252;
    const drift = 0.08 / 252 - (sigma * sigma) / 2 + revert;
    const open = close * Math.exp(sigma * 0.25 * gaussian(`${symbol}:${d}:o`));
    close = close * Math.exp(drift + sigma * z);
    const hi = Math.max(open, close) * (1 + Math.abs(gaussian(`${symbol}:${d}:h`)) * sigma * 0.4);
    const lo = Math.min(open, close) * (1 - Math.abs(gaussian(`${symbol}:${d}:l`)) * sigma * 0.4);
    const v = Math.round((5 + (hash32(`${symbol}:${d}:v`) % 1000) / 50) * 1_000_000 * (1 + Math.abs(z)));
    bars.push({ t: new Date(d * DAY).toISOString().slice(0, 10), o: round2(open), h: round2(hi), l: round2(lo), c: round2(close), v });
  }
  for (const k of dailyCache.keys()) if (k.startsWith(`${symbol}:`)) dailyCache.delete(k);
  dailyCache.set(cacheKey, bars);
  return bars;
}

/** Today's price: yesterday's close plus a per-minute random walk since midnight UTC (the sim trades 24/7). */
function simIntraday(symbol: string, now = Date.now()) {
  const spec = SIM_BY_SYMBOL.get(symbol)!;
  const bars = simDailyBars(symbol);
  const prevClose = bars[bars.length - 1].c;
  const day = Math.floor(now / DAY);
  const minutes = Math.floor((now - day * DAY) / 60_000);
  const sigmaMin = spec.vol / Math.sqrt(252) / Math.sqrt(390);
  let logP = 0;
  let hi = 0;
  let lo = 0;
  for (let m = 0; m <= minutes; m++) {
    logP += sigmaMin * 0.6 * gaussian(`${symbol}:${day}:${m}`);
    hi = Math.max(hi, logP);
    lo = Math.min(lo, logP);
  }
  return {
    prevClose,
    price: round2(prevClose * Math.exp(logP)),
    high: round2(prevClose * Math.exp(hi)),
    low: round2(prevClose * Math.exp(lo)),
  };
}

export const simulatedMarket: MarketData = {
  source: "simulated",
  async quote(symbol) {
    const spec = SIM_BY_SYMBOL.get(symbol);
    if (!spec) throw notFound(`${symbol} isn't available in the simulated market. Try one of: ${SIM_SYMBOLS.slice(0, 8).map((s) => s.symbol).join(", ")}…`);
    const { price, prevClose, high, low } = simIntraday(symbol);
    const change = round2(price - prevClose);
    return {
      symbol,
      name: spec.name,
      price,
      prevClose,
      change,
      changePct: Math.round((change / prevClose) * 10000) / 100,
      dayHigh: high,
      dayLow: low,
      asOf: new Date().toISOString(),
      source: "simulated",
    };
  },
  async bars(symbol, days) {
    if (!SIM_BY_SYMBOL.has(symbol)) throw notFound(`${symbol} isn't available in the simulated market`);
    return simDailyBars(symbol).slice(-days);
  },
};

// ---------------------------------------------------------------------------
// Alpaca market data (real prices). Free accounts get the IEX feed.
// ---------------------------------------------------------------------------
const ALPACA_DATA = "https://data.alpaca.markets/v2";

export function alpacaMarket(creds: { keyId: string; secretKey: string }): MarketData {
  const headers = { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secretKey };
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${ALPACA_DATA}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 422) throw notFound("Unknown symbol");
    if (!res.ok) throw new HttpError(502, "market_data_error", `Alpaca market data error ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    source: "alpaca",
    async quote(symbol) {
      const snap = await get<{
        latestTrade?: { p: number; t: string };
        dailyBar?: { h: number; l: number; c: number };
        prevDailyBar?: { c: number };
      }>(`/stocks/${encodeURIComponent(symbol)}/snapshot?feed=iex`);
      const price = snap.latestTrade?.p ?? snap.dailyBar?.c;
      if (!price) throw notFound(`No recent trades for ${symbol}`);
      const prevClose = snap.prevDailyBar?.c ?? price;
      const change = round2(price - prevClose);
      return {
        symbol,
        name: SIM_BY_SYMBOL.get(symbol)?.name ?? symbol,
        price,
        prevClose,
        change,
        changePct: prevClose ? Math.round((change / prevClose) * 10000) / 100 : 0,
        dayHigh: snap.dailyBar?.h ?? price,
        dayLow: snap.dailyBar?.l ?? price,
        asOf: snap.latestTrade?.t ?? new Date().toISOString(),
        source: "alpaca",
      };
    },
    async bars(symbol, days) {
      const start = new Date(Date.now() - Math.ceil(days * 1.6 + 10) * DAY).toISOString().slice(0, 10);
      const body = await get<{ bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] }>(
        `/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&limit=1000&adjustment=split&feed=iex`,
      );
      return (body.bars ?? []).slice(-days).map((b) => ({ t: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    },
  };
}

export function alpacaCredentials(ctx: Ctx, userId: string): { keyId: string; secretKey: string; env: "paper" | "live" } | null {
  const stored = getUserKey(ctx, userId, "alpaca");
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored.secret) as { keyId: string; secretKey: string };
    return { ...parsed, env: stored.extra.env === "live" ? "live" : "paper" };
  } catch {
    return null;
  }
}

/** Real data when the user (or server) has Alpaca credentials; otherwise the simulator. */
export function marketFor(ctx: Ctx, userId: string): MarketData {
  const user = alpacaCredentials(ctx, userId);
  if (user) return alpacaMarket(user);
  if (ctx.config.ALPACA_DATA_KEY_ID && ctx.config.ALPACA_DATA_SECRET_KEY) {
    return alpacaMarket({ keyId: ctx.config.ALPACA_DATA_KEY_ID, secretKey: ctx.config.ALPACA_DATA_SECRET_KEY });
  }
  return simulatedMarket;
}

export function searchSymbols(query: string) {
  const q = query.trim().toUpperCase();
  if (!q) return SIM_SYMBOLS.map(({ symbol, name }) => ({ symbol, name }));
  return SIM_SYMBOLS.filter((s) => s.symbol.startsWith(q) || s.name.toUpperCase().includes(q)).map(({ symbol, name }) => ({ symbol, name }));
}
