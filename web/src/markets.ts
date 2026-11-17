import { price } from "./format";
import type { AssetClass, Quote } from "./types";

/** The symbol alone tells the market: "BTC-USD" is crypto, "ES=F" a futures contract, anything else a stock. */
export function assetClassOf(symbol: string): AssetClass {
  if (symbol.endsWith("=F")) return "future";
  if (symbol.endsWith("-USD")) return "crypto";
  return "stock";
}

export const MARKET_LABEL: Record<AssetClass, string> = { stock: "Stock", crypto: "Crypto", future: "Futures" };

const UNITS: Record<AssetClass, [string, string]> = { stock: ["share", "shares"], crypto: ["coin", "coins"], future: ["contract", "contracts"] };

/** "1 share", "2 contracts", "0.5 BTC". */
export function units(symbol: string, n: number) {
  const cls = assetClassOf(symbol);
  if (cls === "crypto") return symbol.replace("-USD", "");
  return UNITS[cls][Math.abs(n) === 1 ? 0 : 1];
}

/** Price decimals for a quote: the tick size for futures, otherwise automatic. */
export function priceDecimals(quote?: Quote | null) {
  const tick = quote?.contract?.tickSize;
  if (!tick) return undefined;
  return Math.max(2, Math.min(6, Math.ceil(-Math.log10(tick) - 1e-9)));
}

export const fmtPrice = (n: number | null | undefined, quote?: Quote | null) => price(n, priceDecimals(quote));

export function sourceLabel(source: Quote["source"]) {
  return source === "coinbase" ? "Live price (Coinbase)" : source === "alpaca" ? "Live price (Alpaca)" : "Simulated price";
}
