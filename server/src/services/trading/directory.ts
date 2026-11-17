import type { Ctx } from "../../context.js";

/**
 * Every US-listed stock and ETF, from Nasdaq Trader's daily symbol files (Nasdaq, NYSE, NYSE American,
 * NYSE Arca, Cboe and IEX listings). Loaded on first use and refreshed daily; while it can't be loaded,
 * search falls back to the built-in list of popular stocks.
 */
export interface Listing {
  symbol: string;
  name: string;
  etf: boolean;
  exchange: string;
}

const DAY = 86_400_000;
const RETRY_AFTER = 10 * 60_000;
const STOCK_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const EXCHANGES: Record<string, string> = { A: "NYSE American", N: "NYSE", P: "NYSE Arca", Z: "Cboe BZX", V: "IEX" };

let cache: { at: number; listings: Map<string, Listing> } | null = null;
let failedAt = 0;
let loading: Promise<void> | null = null;

/** "Apple Inc. - Common Stock" → "Apple Inc."; "Brown Forman Inc Class B Common Stock" → "Brown Forman Inc Class B". */
export function cleanName(raw: string) {
  let name = raw.trim();
  const dash = name.indexOf(" - ");
  if (dash > 2) name = name.slice(0, dash);
  name = name.replace(/\s+(Common Stock|Ordinary Shares|Common Shares|Shares of Beneficial Interest)\b.*$/i, "");
  return name.replace(/\s{2,}/g, " ").trim();
}

/** Parses nasdaqlisted.txt and otherlisted.txt (pipe-separated, header row, trailer row). */
export function parseDirectory(nasdaqListed: string, otherListed: string) {
  const listings = new Map<string, Listing>();
  const add = (symbol: string, name: string, etf: boolean, exchange: string, test: boolean) => {
    if (test || !STOCK_SYMBOL.test(symbol) || !name) return;
    if (/\b(warrants?|rights?|units?)\b/i.test(name) && !etf) return;
    listings.set(symbol, { symbol, name: cleanName(name), etf, exchange });
  };
  for (const line of nasdaqListed.split(/\r?\n/).slice(1)) {
    const c = line.split("|");
    if (c.length < 8 || line.startsWith("File Creation Time")) continue;
    add(c[0], c[1], c[6] === "Y", "Nasdaq", c[3] === "Y");
  }
  for (const line of otherListed.split(/\r?\n/).slice(1)) {
    const c = line.split("|");
    if (c.length < 8 || line.startsWith("File Creation Time")) continue;
    add(c[0], c[1], c[4] === "Y", EXCHANGES[c[2]] ?? "NYSE", c[6] === "Y");
  }
  return listings;
}

async function load(ctx: Ctx) {
  const get = async (file: string) => {
    const res = await fetch(`${ctx.config.NASDAQ_DIRECTORY_URL}/${file}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.text();
  };
  try {
    const [nasdaq, other] = await Promise.all([get("nasdaqlisted.txt"), get("otherlisted.txt")]);
    const listings = parseDirectory(nasdaq, other);
    if (listings.size < 100) throw new Error(`only ${listings.size} listings`);
    cache = { at: Date.now(), listings };
  } catch (err) {
    failedAt = Date.now();
    if (!ctx.config.isTest) console.warn(`[market] Couldn't load the US stock directory: ${(err as Error).message}`);
  }
}

/** The full US listing map, or null when it isn't available (built-in mode, or loading failed). */
export async function stockDirectory(ctx: Ctx): Promise<Map<string, Listing> | null> {
  if (ctx.config.stockDirectory !== "nasdaq") return null;
  const stale = !cache || Date.now() - cache.at > DAY;
  if (stale && !loading && Date.now() - failedAt > RETRY_AFTER) {
    loading = load(ctx).finally(() => {
      loading = null;
    });
  }
  // The first load is awaited; later refreshes happen in the background while the old copy serves.
  if (!cache && loading) await loading;
  return cache?.listings ?? null;
}

/** For tests: forget the cached directory. */
export function resetStockDirectory() {
  cache = null;
  failedAt = 0;
  loading = null;
}
