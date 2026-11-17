import type { Ctx } from "../../context.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { getUserKey } from "../keys.js";
import { coinbaseBars, coinbaseCoins, coinbaseStats } from "./crypto.js";
import { stockDirectory, type Listing } from "./directory.js";
import {
  assetClassOf,
  FUTURES,
  FUTURES_BY_SYMBOL,
  frontMonth,
  futureMargin,
  POPULAR_CRYPTO,
  POPULAR_CRYPTO_BY_SYMBOL,
  POPULAR_STOCKS,
  POPULAR_STOCKS_BY_SYMBOL,
  roundToTick,
  TRADING_HOURS,
  type AssetClass,
  type FutureSpec,
  type SimSpec,
} from "./instruments.js";

export { assetClassOf, normalizeSymbol } from "./instruments.js";

export interface Bar {
  t: string; // ISO date (daily bars)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type DataSource = "simulated" | "alpaca" | "coinbase";

/** Contract details for a futures quote, at the current price. */
export interface ContractInfo {
  root: string;
  exchange: string;
  category: string;
  multiplier: number;
  tickSize: number;
  tickValue: number;
  unit: string;
  marginRate: number;
  marginPerContract: number;
  maintenancePerContract: number;
  leverage: number;
  /** Front month, e.g. "Dec 2026" and "ESZ6". */
  month: string;
  code: string;
  micro: boolean;
}

export interface Quote {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  asOf: string;
  source: DataSource;
  hours: string;
  contract?: ContractInfo;
}

export interface MarketData {
  /** Where stock prices come from. Crypto and futures quotes report their own source. */
  source: DataSource;
  quote(symbol: string): Promise<Quote>;
  bars(symbol: string, days: number): Promise<Bar[]>;
}

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Two decimals for ordinary prices; four significant digits below $1 (e.g. 0.00002345 for SHIB). */
export const roundPrice = (n: number) => (Math.abs(n) >= 1 ? round2(n) : Number(n.toPrecision(4)));

// ---------------------------------------------------------------------------
// Simulator: deterministic, so every user sees the same prices and charts are stable.
// ---------------------------------------------------------------------------
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

interface SimInstrument {
  spec: SimSpec;
  /** Crypto trades every day; stocks and futures on weekdays. */
  everyDay: boolean;
  round: (n: number) => number;
}

const dailyCache = new Map<string, Bar[]>();

/** Daily closes from a fixed epoch to yesterday: mean-reverting geometric random walk. */
function simDailyBars({ spec, everyDay, round }: SimInstrument): Bar[] {
  const { symbol } = spec;
  const today = Math.floor(Date.now() / DAY);
  const cacheKey = `${symbol}:${today}`;
  const cached = dailyCache.get(cacheKey);
  if (cached) return cached;

  const periods = everyDay ? 365 : 252;
  const sigma = spec.vol / Math.sqrt(periods);
  const bars: Bar[] = [];
  let close = spec.base * (0.85 + (hash32(symbol) % 300) / 1000);
  for (let d = Math.floor(EPOCH / DAY); d < today; d++) {
    const dow = new Date(d * DAY).getUTCDay();
    if (!everyDay && (dow === 0 || dow === 6)) continue;
    const z = gaussian(`${symbol}:${d}`);
    const revert = (-0.6 * Math.log(close / spec.base)) / periods;
    const drift = 0.08 / periods - (sigma * sigma) / 2 + revert;
    const open = close * Math.exp(sigma * 0.25 * gaussian(`${symbol}:${d}:o`));
    close = close * Math.exp(drift + sigma * z);
    const hi = Math.max(open, close) * (1 + Math.abs(gaussian(`${symbol}:${d}:h`)) * sigma * 0.4);
    const lo = Math.min(open, close) * (1 - Math.abs(gaussian(`${symbol}:${d}:l`)) * sigma * 0.4);
    const v = Math.round((5 + (hash32(`${symbol}:${d}:v`) % 1000) / 50) * 1_000_000 * (1 + Math.abs(z)));
    bars.push({ t: new Date(d * DAY).toISOString().slice(0, 10), o: round(open), h: round(hi), l: round(lo), c: round(close), v });
  }
  for (const k of dailyCache.keys()) if (k.startsWith(`${symbol}:`)) dailyCache.delete(k);
  dailyCache.set(cacheKey, bars);
  return bars;
}

/** Today's price: yesterday's close plus a per-minute random walk since midnight UTC (the sim trades 24/7). */
function simIntraday(inst: SimInstrument, now = Date.now()) {
  const { spec, round } = inst;
  const bars = simDailyBars(inst);
  const prevClose = bars[bars.length - 1].c;
  const day = Math.floor(now / DAY);
  const minutes = Math.floor((now - day * DAY) / 60_000);
  const sigmaMin = spec.vol / Math.sqrt(inst.everyDay ? 365 : 252) / Math.sqrt(390);
  let logP = 0;
  let hi = 0;
  let lo = 0;
  for (let m = 0; m <= minutes; m++) {
    logP += sigmaMin * 0.6 * gaussian(`${spec.symbol}:${day}:${m}`);
    hi = Math.max(hi, logP);
    lo = Math.min(lo, logP);
  }
  return { prevClose, price: round(prevClose * Math.exp(logP)), high: round(prevClose * Math.exp(hi)), low: round(prevClose * Math.exp(lo)) };
}

function contractInfo(spec: FutureSpec, price: number): ContractInfo {
  const margin = futureMargin(spec, price);
  const month = frontMonth(spec);
  return {
    root: spec.root,
    exchange: spec.exchange,
    category: spec.category,
    multiplier: spec.multiplier,
    tickSize: spec.tickSize,
    tickValue: round2(spec.tickSize * spec.multiplier),
    unit: spec.unit,
    marginRate: spec.marginRate,
    marginPerContract: margin.initial,
    maintenancePerContract: margin.maintenance,
    leverage: Math.round((1 / spec.marginRate) * 10) / 10,
    month: month.label,
    code: month.code,
    micro: !!spec.micro,
  };
}

function simQuote(inst: SimInstrument, assetClass: AssetClass, future?: FutureSpec): Quote {
  const { price, prevClose, high, low } = simIntraday(inst);
  const change = inst.round(price - prevClose);
  return {
    symbol: inst.spec.symbol,
    name: inst.spec.name,
    assetClass,
    price,
    prevClose,
    change,
    changePct: prevClose ? Math.round((change / prevClose) * 10000) / 100 : 0,
    dayHigh: high,
    dayLow: low,
    asOf: new Date().toISOString(),
    source: "simulated",
    hours: TRADING_HOURS[assetClass],
    ...(future ? { contract: contractInfo(future, price) } : {}),
  };
}

const futureInstrument = (spec: FutureSpec): SimInstrument => ({ spec, everyDay: false, round: (n) => roundToTick(n, spec.tickSize) });
const cryptoInstrument = (spec: SimSpec): SimInstrument => ({ spec, everyDay: true, round: roundPrice });
const stockInstrument = (spec: SimSpec): SimInstrument => ({ spec, everyDay: false, round: round2 });

/** A stable made-up price level for listed stocks outside the popular list ($5–$400, 20–60% volatility). */
function derivedStockSpec(listing: Listing): SimSpec {
  const h = hash32(listing.symbol);
  const base = Math.exp(Math.log(5) + ((h % 10000) / 10000) * (Math.log(400) - Math.log(5)));
  return { symbol: listing.symbol, name: listing.name, base: round2(base), vol: 0.2 + ((h >>> 8) % 400) / 1000 };
}

function futureSpecOr404(symbol: string) {
  const spec = FUTURES_BY_SYMBOL.get(symbol);
  if (!spec) throw notFound(`${symbol} isn't a futures contract here. Try ${FUTURES.slice(0, 4).map((s) => s.symbol).join(", ")}…`);
  return spec;
}

// ---------------------------------------------------------------------------
// Stock prices: the simulator, or Alpaca market data (real prices; free accounts get the IEX feed).
// ---------------------------------------------------------------------------
interface StockFeed {
  source: DataSource;
  quote(symbol: string, listing: Listing | null): Promise<Quote>;
  bars(symbol: string, days: number, listing: Listing | null): Promise<Bar[]>;
}

function simStockSpec(symbol: string, listing: Listing | null) {
  const spec = POPULAR_STOCKS_BY_SYMBOL.get(symbol) ?? (listing ? derivedStockSpec(listing) : null);
  if (!spec) throw notFound(`${symbol} isn't a listed US stock. Search by company name to find the right ticker.`);
  return spec;
}

const simulatedStocks: StockFeed = {
  source: "simulated",
  async quote(symbol, listing) {
    return simQuote(stockInstrument(simStockSpec(symbol, listing)), "stock");
  },
  async bars(symbol, days, listing) {
    return simDailyBars(stockInstrument(simStockSpec(symbol, listing))).slice(-days);
  },
};

const ALPACA_DATA = "https://data.alpaca.markets/v2";

function alpacaStocks(creds: { keyId: string; secretKey: string }): StockFeed {
  const headers = { "APCA-API-KEY-ID": creds.keyId, "APCA-API-SECRET-KEY": creds.secretKey };
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${ALPACA_DATA}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404 || res.status === 422) throw notFound("Unknown symbol");
    if (!res.ok) throw new HttpError(502, "market_data_error", `Alpaca market data error ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    source: "alpaca",
    async quote(symbol, listing) {
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
        name: POPULAR_STOCKS_BY_SYMBOL.get(symbol)?.name ?? listing?.name ?? symbol,
        assetClass: "stock",
        price,
        prevClose,
        change,
        changePct: prevClose ? Math.round((change / prevClose) * 10000) / 100 : 0,
        dayHigh: snap.dailyBar?.h ?? price,
        dayLow: snap.dailyBar?.l ?? price,
        asOf: snap.latestTrade?.t ?? new Date().toISOString(),
        source: "alpaca",
        hours: TRADING_HOURS.stock,
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

// ---------------------------------------------------------------------------
// Crypto prices: live from Coinbase, or the simulator (tests, or CRYPTO_DATA=simulated).
// ---------------------------------------------------------------------------
function simCryptoSpec(symbol: string) {
  const spec = POPULAR_CRYPTO_BY_SYMBOL.get(symbol);
  if (!spec) throw notFound(`${symbol} isn't available in the practice market. Try ${POPULAR_CRYPTO.slice(0, 4).map((s) => s.symbol).join(", ")}…`);
  return spec;
}

async function cryptoQuote(ctx: Ctx | null, symbol: string): Promise<Quote> {
  if (!ctx || ctx.config.cryptoData === "simulated") return simQuote(cryptoInstrument(simCryptoSpec(symbol)), "crypto");
  const coins = await coinbaseCoins(ctx);
  if (coins && !coins.has(symbol)) throw notFound(`${symbol} isn't traded on Coinbase against the US dollar`);
  const s = await coinbaseStats(ctx, symbol);
  const change = roundPrice(s.last - s.open);
  return {
    symbol,
    name: coins?.get(symbol)?.name ?? POPULAR_CRYPTO_BY_SYMBOL.get(symbol)?.name ?? symbol.replace("-USD", ""),
    assetClass: "crypto",
    price: s.last,
    prevClose: s.open,
    change,
    changePct: s.open ? Math.round((change / s.open) * 10000) / 100 : 0,
    dayHigh: s.high,
    dayLow: s.low,
    asOf: new Date().toISOString(),
    source: "coinbase",
    hours: TRADING_HOURS.crypto,
  };
}

async function cryptoBars(ctx: Ctx | null, symbol: string, days: number) {
  if (!ctx || ctx.config.cryptoData === "simulated") return simDailyBars(cryptoInstrument(simCryptoSpec(symbol))).slice(-days);
  return coinbaseBars(ctx, symbol, days);
}

// ---------------------------------------------------------------------------
// One market for every asset class.
// ---------------------------------------------------------------------------
function combined(ctx: Ctx | null, stocks: StockFeed): MarketData {
  const listing = async (symbol: string) => (ctx ? ((await stockDirectory(ctx))?.get(symbol) ?? null) : null);
  return {
    source: stocks.source,
    async quote(symbol) {
      const cls = assetClassOf(symbol);
      if (cls === "crypto") return cryptoQuote(ctx, symbol);
      if (cls === "future") {
        const spec = futureSpecOr404(symbol);
        return simQuote(futureInstrument(spec), "future", spec);
      }
      return stocks.quote(symbol, await listing(symbol));
    },
    async bars(symbol, days) {
      const cls = assetClassOf(symbol);
      if (cls === "crypto") return cryptoBars(ctx, symbol, days);
      if (cls === "future") return simDailyBars(futureInstrument(futureSpecOr404(symbol))).slice(-days);
      return stocks.bars(symbol, days, await listing(symbol));
    },
  };
}

/** Practice prices for every asset class, without a server context (popular stocks and coins only). */
export const simulatedMarket: MarketData = combined(null, simulatedStocks);

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

/** Real stock data when the user (or server) has Alpaca credentials; live crypto; simulated futures. */
export function marketFor(ctx: Ctx, userId: string): MarketData {
  const user = alpacaCredentials(ctx, userId);
  if (user) return combined(ctx, alpacaStocks(user));
  if (ctx.config.ALPACA_DATA_KEY_ID && ctx.config.ALPACA_DATA_SECRET_KEY) {
    return combined(ctx, alpacaStocks({ keyId: ctx.config.ALPACA_DATA_KEY_ID, secretKey: ctx.config.ALPACA_DATA_SECRET_KEY }));
  }
  return combined(ctx, simulatedStocks);
}

// ---------------------------------------------------------------------------
// Search across every market.
// ---------------------------------------------------------------------------
export interface SearchResult {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  detail: string;
}

function score(q: string, symbol: string, key: string, name: string) {
  if (key === q || symbol === q) return 0;
  if (key.startsWith(q) || symbol.startsWith(q)) return 1;
  const upper = name.toUpperCase();
  if (upper.startsWith(q) || upper.includes(` ${q}`)) return 2;
  if (upper.includes(q)) return 3;
  return -1;
}

/**
 * Finds instruments by ticker or name. With no query, returns the popular list for the asset class
 * (or a mix of all three). Stocks cover every US listing when the directory is available.
 */
export async function searchInstruments(ctx: Ctx, rawQuery: string, assetClass?: AssetClass, limit = 20): Promise<SearchResult[]> {
  const q = rawQuery.trim().toUpperCase().replace(/^\//, "").replace(/[/-]USD$/, "").replace(/=F$/, "");
  const want = (c: AssetClass) => !assetClass || assetClass === c;

  const futures = FUTURES.map((s) => ({
    symbol: s.symbol,
    key: s.root,
    name: s.name,
    assetClass: "future" as const,
    detail: `${s.exchange} · ${s.category}${s.micro ? " · micro" : ""}`,
  }));
  const coinList = ctx.config.cryptoData === "coinbase" ? await coinbaseCoins(ctx) : null;
  const crypto = (coinList ? [...coinList.values()] : POPULAR_CRYPTO).map((c) => ({
    symbol: c.symbol,
    key: c.symbol.replace("-USD", ""),
    name: c.name,
    assetClass: "crypto" as const,
    detail: "Crypto · 24/7",
  }));
  const directory = await stockDirectory(ctx);
  const stockRows = directory
    ? [...directory.values()].map((l) => ({ symbol: l.symbol, key: l.symbol, name: POPULAR_STOCKS_BY_SYMBOL.get(l.symbol)?.name ?? l.name, assetClass: "stock" as const, detail: `${l.exchange}${l.etf ? " · ETF" : ""}` }))
    : POPULAR_STOCKS.map((s) => ({ symbol: s.symbol, key: s.symbol, name: s.name, assetClass: "stock" as const, detail: "US stock" }));

  if (!q) {
    const popularCrypto = POPULAR_CRYPTO.filter((c) => !coinList || coinList.has(c.symbol)).map((c) => crypto.find((x) => x.symbol === c.symbol)!);
    const popularStocks = POPULAR_STOCKS.map((s) => stockRows.find((x) => x.symbol === s.symbol) ?? { symbol: s.symbol, key: s.symbol, name: s.name, assetClass: "stock" as const, detail: "US stock" });
    const pick = [...(want("stock") ? popularStocks : []), ...(want("crypto") ? popularCrypto : []), ...(want("future") ? futures : [])];
    return pick.slice(0, assetClass ? 100 : limit).map(({ symbol, name, assetClass: cls, detail }) => ({ symbol, name, assetClass: cls, detail }));
  }

  const ranked: { r: SearchResult; s: number; popular: boolean }[] = [];
  const consider = (rows: { symbol: string; key: string; name: string; assetClass: AssetClass; detail: string }[]) => {
    for (const row of rows) {
      const s = score(q, row.symbol, row.key, row.name);
      if (s < 0) continue;
      const popular = POPULAR_STOCKS_BY_SYMBOL.has(row.symbol) || POPULAR_CRYPTO_BY_SYMBOL.has(row.symbol) || row.assetClass === "future";
      ranked.push({ r: { symbol: row.symbol, name: row.name, assetClass: row.assetClass, detail: row.detail }, s, popular });
    }
  };
  if (want("stock")) consider(stockRows);
  if (want("crypto")) consider(crypto);
  if (want("future")) consider(futures);
  ranked.sort((a, b) => a.s - b.s || Number(b.popular) - Number(a.popular) || a.r.symbol.length - b.r.symbol.length || a.r.symbol.localeCompare(b.r.symbol));
  return ranked.slice(0, limit).map((x) => x.r);
}
