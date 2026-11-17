import type { Ctx } from "../../context.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { STABLECOINS } from "./instruments.js";
import type { Bar } from "./market.js";

/**
 * Live crypto prices from Coinbase's public market data (no account or key needed). Responses are
 * cached briefly so many users watching the same coin make one request.
 */
export interface CoinListing {
  symbol: string;
  name: string;
}

const DAY = 86_400_000;
let listCache: { at: number; coins: Map<string, CoinListing> } | null = null;
let listLoading: Promise<void> | null = null;
let listFailedAt = 0;
const quoteCache = new Map<string, { at: number; data: CoinStats }>();
const barsCache = new Map<string, { at: number; bars: Bar[] }>();

interface CoinStats {
  open: number;
  high: number;
  low: number;
  last: number;
}

async function get<T>(ctx: Ctx, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.config.COINBASE_EXCHANGE_URL}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "Aurex" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new HttpError(502, "market_data_error", `Crypto prices are unavailable right now: ${(err as Error).message}`);
  }
  if (res.status === 404) throw notFound("Unknown crypto pair");
  if (!res.ok) throw new HttpError(502, "market_data_error", `Crypto prices are unavailable right now (HTTP ${res.status})`);
  return (await res.json()) as T;
}

async function loadList(ctx: Ctx) {
  try {
    const [products, currencies] = await Promise.all([
      get<{ id: string; base_currency: string; quote_currency: string; status: string; trading_disabled?: boolean; fx_stablecoin?: boolean }[]>(ctx, "/products"),
      get<{ id: string; name: string }[]>(ctx, "/currencies").catch(() => []),
    ]);
    const names = new Map(currencies.map((c) => [c.id, c.name]));
    const coins = new Map<string, CoinListing>();
    for (const p of products) {
      if (p.quote_currency !== "USD" || p.status !== "online" || p.trading_disabled || p.fx_stablecoin) continue;
      if (STABLECOINS.has(p.base_currency) || !/^[A-Z0-9]{1,12}$/.test(p.base_currency)) continue;
      coins.set(`${p.base_currency}-USD`, { symbol: `${p.base_currency}-USD`, name: names.get(p.base_currency) ?? p.base_currency });
    }
    if (coins.size === 0) throw new Error("no USD pairs listed");
    listCache = { at: Date.now(), coins };
  } catch (err) {
    listFailedAt = Date.now();
    if (!ctx.config.isTest) console.warn(`[market] Couldn't load the crypto list: ${(err as Error).message}`);
  }
}

/** Every coin Coinbase trades against USD (excluding stablecoins), or null if the list can't be loaded. */
export async function coinbaseCoins(ctx: Ctx): Promise<Map<string, CoinListing> | null> {
  const stale = !listCache || Date.now() - listCache.at > DAY;
  if (stale && !listLoading && Date.now() - listFailedAt > 10 * 60_000) {
    listLoading = loadList(ctx).finally(() => {
      listLoading = null;
    });
  }
  if (!listCache && listLoading) await listLoading;
  return listCache?.coins ?? null;
}

export async function coinbaseStats(ctx: Ctx, symbol: string): Promise<CoinStats> {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < 5_000) return hit.data;
  const s = await get<{ open: string; high: string; low: string; last: string }>(ctx, `/products/${encodeURIComponent(symbol)}/stats`);
  const data = { open: Number(s.open), high: Number(s.high), low: Number(s.low), last: Number(s.last) };
  if (!(data.last > 0)) throw notFound(`No recent trades for ${symbol}`);
  quoteCache.set(symbol, { at: Date.now(), data });
  return data;
}

/** Daily candles, oldest first. Coinbase returns [time, low, high, open, close, volume], newest first. */
export async function coinbaseBars(ctx: Ctx, symbol: string, days: number): Promise<Bar[]> {
  const hit = barsCache.get(symbol);
  let bars = hit && Date.now() - hit.at < 10 * 60_000 ? hit.bars : null;
  if (!bars) {
    const rows = await get<[number, number, number, number, number, number][]>(ctx, `/products/${encodeURIComponent(symbol)}/candles?granularity=86400`);
    bars = rows
      .map(([t, l, h, o, c, v]) => ({ t: new Date(t * 1000).toISOString().slice(0, 10), o, h, l, c, v }))
      .sort((a, b) => a.t.localeCompare(b.t));
    barsCache.set(symbol, { at: Date.now(), bars });
  }
  return bars.slice(-days);
}

/** For tests: clear all cached crypto data. */
export function resetCryptoCache() {
  listCache = null;
  listLoading = null;
  listFailedAt = 0;
  quoteCache.clear();
  barsCache.clear();
}
