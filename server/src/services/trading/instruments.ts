import { badRequest } from "../../lib/errors.js";

/**
 * What can be traded: US stocks and ETFs ("AAPL"), crypto against the US dollar ("BTC-USD") and futures
 * contracts ("ES=F", the front month of the E-mini S&P 500). The symbol alone tells the asset class.
 */
export type AssetClass = "stock" | "crypto" | "future";

const STOCK_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const CRYPTO_RE = /^[A-Z0-9]{1,12}-USD$/;
const FUTURE_RE = /^[A-Z0-9]{1,4}=F$/;

export function assetClassOf(symbol: string): AssetClass {
  if (symbol.endsWith("=F")) return "future";
  if (symbol.endsWith("-USD")) return "crypto";
  return "stock";
}

/** Accepts "aapl", "BTC/USD", "btc-usd", "/ES" or "ES=F"; returns the canonical symbol. */
export function normalizeSymbol(raw: string) {
  let s = String(raw ?? "").trim().toUpperCase();
  if (/^\/[A-Z0-9]{1,4}$/.test(s)) s = `${s.slice(1)}=F`;
  if (/^[A-Z0-9]{1,12}\/USD$/.test(s)) s = s.replace("/", "-");
  if (STOCK_RE.test(s) || CRYPTO_RE.test(s) || FUTURE_RE.test(s)) return s;
  throw badRequest("Use a stock ticker like AAPL, a crypto pair like BTC-USD, or a futures symbol like ES=F");
}

export const ASSET_LABEL: Record<AssetClass, string> = { stock: "Stock", crypto: "Crypto", future: "Futures" };

// ---------------------------------------------------------------------------
// Futures: continuous front-month contracts with real contract sizes. Margin rates approximate the
// exchanges' initial margin as a share of contract value; maintenance margin is 90% of that.
// ---------------------------------------------------------------------------
export interface FutureSpec {
  symbol: string;
  root: string;
  name: string;
  category: "Equity index" | "Energy" | "Metals" | "Agriculture" | "Interest rates" | "Currencies" | "Crypto";
  exchange: "CME" | "CBOT" | "NYMEX" | "COMEX";
  /** Dollars per 1.00 move in the quoted price. */
  multiplier: number;
  tickSize: number;
  /** Initial margin as a share of contract value. */
  marginRate: number;
  unit: string;
  /** Contract months, as month codes. */
  cycle: string;
  /** How the front month rolls: "before" = trading ends in the month before delivery. */
  roll: "mid" | "before" | "late";
  micro?: boolean;
  /** Simulator: typical price and yearly volatility. */
  base: number;
  vol: number;
}

const QUARTERLY = "HMUZ";
const MONTHLY = "FGHJKMNQUVXZ";

const f = (s: Omit<FutureSpec, "symbol">): FutureSpec => ({ ...s, symbol: `${s.root}=F` });

export const FUTURES: FutureSpec[] = [
  f({ root: "ES", name: "E-mini S&P 500", category: "Equity index", exchange: "CME", multiplier: 50, tickSize: 0.25, marginRate: 0.06, unit: "index points", cycle: QUARTERLY, roll: "mid", base: 6000, vol: 0.18 }),
  f({ root: "MES", name: "Micro E-mini S&P 500", category: "Equity index", exchange: "CME", multiplier: 5, tickSize: 0.25, marginRate: 0.06, unit: "index points", cycle: QUARTERLY, roll: "mid", micro: true, base: 6000, vol: 0.18 }),
  f({ root: "NQ", name: "E-mini Nasdaq-100", category: "Equity index", exchange: "CME", multiplier: 20, tickSize: 0.25, marginRate: 0.07, unit: "index points", cycle: QUARTERLY, roll: "mid", base: 21000, vol: 0.24 }),
  f({ root: "MNQ", name: "Micro E-mini Nasdaq-100", category: "Equity index", exchange: "CME", multiplier: 2, tickSize: 0.25, marginRate: 0.07, unit: "index points", cycle: QUARTERLY, roll: "mid", micro: true, base: 21000, vol: 0.24 }),
  f({ root: "YM", name: "E-mini Dow ($5)", category: "Equity index", exchange: "CBOT", multiplier: 5, tickSize: 1, marginRate: 0.06, unit: "index points", cycle: QUARTERLY, roll: "mid", base: 44000, vol: 0.16 }),
  f({ root: "RTY", name: "E-mini Russell 2000", category: "Equity index", exchange: "CME", multiplier: 50, tickSize: 0.1, marginRate: 0.07, unit: "index points", cycle: QUARTERLY, roll: "mid", base: 2300, vol: 0.24 }),
  f({ root: "CL", name: "Crude Oil (WTI)", category: "Energy", exchange: "NYMEX", multiplier: 1000, tickSize: 0.01, marginRate: 0.1, unit: "$ per barrel", cycle: MONTHLY, roll: "before", base: 70, vol: 0.35 }),
  f({ root: "MCL", name: "Micro WTI Crude Oil", category: "Energy", exchange: "NYMEX", multiplier: 100, tickSize: 0.01, marginRate: 0.1, unit: "$ per barrel", cycle: MONTHLY, roll: "before", micro: true, base: 70, vol: 0.35 }),
  f({ root: "NG", name: "Natural Gas (Henry Hub)", category: "Energy", exchange: "NYMEX", multiplier: 10000, tickSize: 0.001, marginRate: 0.15, unit: "$ per MMBtu", cycle: MONTHLY, roll: "before", base: 3.5, vol: 0.6 }),
  f({ root: "GC", name: "Gold", category: "Metals", exchange: "COMEX", multiplier: 100, tickSize: 0.1, marginRate: 0.08, unit: "$ per troy ounce", cycle: "GJMQVZ", roll: "before", base: 2700, vol: 0.16 }),
  f({ root: "MGC", name: "Micro Gold", category: "Metals", exchange: "COMEX", multiplier: 10, tickSize: 0.1, marginRate: 0.08, unit: "$ per troy ounce", cycle: "GJMQVZ", roll: "before", micro: true, base: 2700, vol: 0.16 }),
  f({ root: "SI", name: "Silver", category: "Metals", exchange: "COMEX", multiplier: 5000, tickSize: 0.005, marginRate: 0.1, unit: "$ per troy ounce", cycle: "HKNUZ", roll: "before", base: 31, vol: 0.28 }),
  f({ root: "HG", name: "Copper", category: "Metals", exchange: "COMEX", multiplier: 25000, tickSize: 0.0005, marginRate: 0.08, unit: "$ per pound", cycle: "HKNUZ", roll: "before", base: 4.3, vol: 0.24 }),
  f({ root: "ZC", name: "Corn", category: "Agriculture", exchange: "CBOT", multiplier: 50, tickSize: 0.25, marginRate: 0.06, unit: "cents per bushel", cycle: "HKNUZ", roll: "before", base: 450, vol: 0.25 }),
  f({ root: "ZW", name: "Wheat (Chicago)", category: "Agriculture", exchange: "CBOT", multiplier: 50, tickSize: 0.25, marginRate: 0.08, unit: "cents per bushel", cycle: "HKNUZ", roll: "before", base: 550, vol: 0.3 }),
  f({ root: "ZS", name: "Soybeans", category: "Agriculture", exchange: "CBOT", multiplier: 50, tickSize: 0.25, marginRate: 0.06, unit: "cents per bushel", cycle: "FHKNQUX", roll: "before", base: 1000, vol: 0.2 }),
  f({ root: "ZN", name: "10-Year US Treasury Note", category: "Interest rates", exchange: "CBOT", multiplier: 1000, tickSize: 0.015625, marginRate: 0.02, unit: "points (% of par)", cycle: QUARTERLY, roll: "before", base: 110, vol: 0.07 }),
  f({ root: "6E", name: "Euro FX", category: "Currencies", exchange: "CME", multiplier: 125000, tickSize: 0.00005, marginRate: 0.03, unit: "$ per euro", cycle: QUARTERLY, roll: "mid", base: 1.08, vol: 0.08 }),
  f({ root: "BTC", name: "Bitcoin (CME)", category: "Crypto", exchange: "CME", multiplier: 5, tickSize: 5, marginRate: 0.35, unit: "$ per bitcoin", cycle: MONTHLY, roll: "late", base: 65000, vol: 0.6 }),
  f({ root: "MBT", name: "Micro Bitcoin (CME)", category: "Crypto", exchange: "CME", multiplier: 0.1, tickSize: 5, marginRate: 0.35, unit: "$ per bitcoin", cycle: MONTHLY, roll: "late", micro: true, base: 65000, vol: 0.6 }),
];
export const FUTURES_BY_SYMBOL = new Map(FUTURES.map((s) => [s.symbol, s]));

const MONTH_CODES = "FGHJKMNQUVXZ";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The contract month currently traded as the front month, e.g. { code: "ESZ6", label: "Dec 2026" }. */
export function frontMonth(spec: FutureSpec, now = new Date()) {
  const months = [...spec.cycle].map((c) => MONTH_CODES.indexOf(c));
  for (let year = now.getUTCFullYear(); year <= now.getUTCFullYear() + 2; year++) {
    for (const m of months) {
      // Approximate last trading day: mid-month (index futures, FX), the month before delivery
      // (energy, metals, grains, Treasuries), or late in the month (CME Bitcoin).
      const lastTrade =
        spec.roll === "mid" ? Date.UTC(year, m, 12) : spec.roll === "before" ? Date.UTC(year, m - 1, 20) : Date.UTC(year, m, 24);
      if (lastTrade > now.getTime()) {
        return { code: `${spec.root}${MONTH_CODES[m]}${year % 10}`, label: `${MONTH_NAMES[m]} ${year}` };
      }
    }
  }
  return { code: spec.root, label: "front month" };
}

/** Margin per contract at a given price (initial; maintenance is 90%). */
export function futureMargin(spec: FutureSpec, price: number) {
  const initial = Math.round(price * spec.multiplier * spec.marginRate * 100) / 100;
  return { initial, maintenance: Math.round(initial * 0.9 * 100) / 100 };
}

export function roundToTick(price: number, tick: number) {
  return Number((Math.round(price / tick) * tick).toFixed(Math.max(0, Math.ceil(-Math.log10(tick)) + 1)));
}

// ---------------------------------------------------------------------------
// Popular stocks and ETFs: always searchable, and the simulator's reference prices.
// ---------------------------------------------------------------------------
export interface SimSpec {
  symbol: string;
  name: string;
  base: number;
  vol: number;
}

export const POPULAR_STOCKS: SimSpec[] = [
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
  { symbol: "AVGO", name: "Broadcom Inc.", base: 170, vol: 0.4 },
  { symbol: "ORCL", name: "Oracle Corp.", base: 170, vol: 0.3 },
  { symbol: "CRM", name: "Salesforce Inc.", base: 300, vol: 0.32 },
  { symbol: "ADBE", name: "Adobe Inc.", base: 500, vol: 0.3 },
  { symbol: "COST", name: "Costco Wholesale Corp.", base: 900, vol: 0.18 },
  { symbol: "PEP", name: "PepsiCo Inc.", base: 160, vol: 0.15 },
  { symbol: "MCD", name: "McDonald's Corp.", base: 290, vol: 0.16 },
  { symbol: "NKE", name: "Nike Inc.", base: 80, vol: 0.32 },
  { symbol: "BA", name: "Boeing Co.", base: 160, vol: 0.38 },
  { symbol: "CAT", name: "Caterpillar Inc.", base: 380, vol: 0.27 },
  { symbol: "GS", name: "Goldman Sachs Group", base: 520, vol: 0.25 },
  { symbol: "MA", name: "Mastercard Inc.", base: 510, vol: 0.19 },
  { symbol: "PYPL", name: "PayPal Holdings", base: 75, vol: 0.38 },
  { symbol: "UBER", name: "Uber Technologies", base: 75, vol: 0.4 },
  { symbol: "SHOP", name: "Shopify Inc.", base: 90, vol: 0.5 },
  { symbol: "TSM", name: "Taiwan Semiconductor (ADR)", base: 190, vol: 0.35 },
  { symbol: "BABA", name: "Alibaba Group (ADR)", base: 90, vol: 0.45 },
  { symbol: "JNJ", name: "Johnson & Johnson", base: 155, vol: 0.15 },
  { symbol: "LLY", name: "Eli Lilly and Co.", base: 850, vol: 0.32 },
  { symbol: "UNH", name: "UnitedHealth Group", base: 550, vol: 0.25 },
  { symbol: "PFE", name: "Pfizer Inc.", base: 28, vol: 0.25 },
  { symbol: "CVX", name: "Chevron Corp.", base: 150, vol: 0.24 },
  { symbol: "T", name: "AT&T Inc.", base: 22, vol: 0.2 },
  { symbol: "VZ", name: "Verizon Communications", base: 42, vol: 0.18 },
  { symbol: "F", name: "Ford Motor Co.", base: 11, vol: 0.38 },
  { symbol: "GM", name: "General Motors Co.", base: 50, vol: 0.35 },
  { symbol: "COIN", name: "Coinbase Global", base: 230, vol: 0.75 },
  { symbol: "MSTR", name: "MicroStrategy (Strategy)", base: 300, vol: 0.9 },
  { symbol: "HOOD", name: "Robinhood Markets", base: 35, vol: 0.7 },
  { symbol: "SOFI", name: "SoFi Technologies", base: 12, vol: 0.6 },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", base: 525, vol: 0.15 },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF", base: 430, vol: 0.14 },
  { symbol: "IWM", name: "iShares Russell 2000 ETF", base: 225, vol: 0.22 },
  { symbol: "GLD", name: "SPDR Gold Shares", base: 245, vol: 0.15 },
  { symbol: "SLV", name: "iShares Silver Trust", base: 28, vol: 0.27 },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", base: 92, vol: 0.15 },
  { symbol: "ARKK", name: "ARK Innovation ETF", base: 55, vol: 0.45 },
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", base: 285, vol: 0.15 },
];
export const POPULAR_STOCKS_BY_SYMBOL = new Map(POPULAR_STOCKS.map((s) => [s.symbol, s]));

// ---------------------------------------------------------------------------
// Popular crypto: always listed, and the simulator's reference prices. With live data (Coinbase),
// every coin Coinbase lists against the US dollar is available.
// ---------------------------------------------------------------------------
export const POPULAR_CRYPTO: SimSpec[] = [
  { symbol: "BTC-USD", name: "Bitcoin", base: 65000, vol: 0.6 },
  { symbol: "ETH-USD", name: "Ethereum", base: 3000, vol: 0.7 },
  { symbol: "SOL-USD", name: "Solana", base: 150, vol: 0.9 },
  { symbol: "XRP-USD", name: "XRP", base: 0.6, vol: 0.8 },
  { symbol: "DOGE-USD", name: "Dogecoin", base: 0.15, vol: 0.9 },
  { symbol: "ADA-USD", name: "Cardano", base: 0.5, vol: 0.85 },
  { symbol: "AVAX-USD", name: "Avalanche", base: 30, vol: 0.9 },
  { symbol: "LINK-USD", name: "Chainlink", base: 15, vol: 0.85 },
  { symbol: "DOT-USD", name: "Polkadot", base: 6, vol: 0.85 },
  { symbol: "LTC-USD", name: "Litecoin", base: 80, vol: 0.7 },
  { symbol: "BCH-USD", name: "Bitcoin Cash", base: 400, vol: 0.75 },
  { symbol: "XLM-USD", name: "Stellar", base: 0.12, vol: 0.8 },
  { symbol: "UNI-USD", name: "Uniswap", base: 8, vol: 0.9 },
  { symbol: "AAVE-USD", name: "Aave", base: 150, vol: 0.9 },
  { symbol: "SHIB-USD", name: "Shiba Inu", base: 0.00002, vol: 1 },
  { symbol: "ATOM-USD", name: "Cosmos", base: 7, vol: 0.85 },
  { symbol: "NEAR-USD", name: "NEAR Protocol", base: 5, vol: 0.9 },
  { symbol: "SUI-USD", name: "Sui", base: 1.5, vol: 1 },
  { symbol: "HBAR-USD", name: "Hedera", base: 0.08, vol: 0.9 },
  { symbol: "FIL-USD", name: "Filecoin", base: 5, vol: 0.9 },
  { symbol: "ETC-USD", name: "Ethereum Classic", base: 25, vol: 0.8 },
  { symbol: "ARB-USD", name: "Arbitrum", base: 0.8, vol: 1 },
  { symbol: "OP-USD", name: "Optimism", base: 1.8, vol: 1 },
];
export const POPULAR_CRYPTO_BY_SYMBOL = new Map(POPULAR_CRYPTO.map((s) => [s.symbol, s]));

/** Stablecoins track the dollar, so there's nothing to trade against USD. */
export const STABLECOINS = new Set(["USDT", "USDC", "DAI", "PYUSD", "EURC", "GUSD", "PAX", "USDP", "FDUSD", "USDS", "USD1", "TUSD", "RLUSD"]);

/** How quantities work for each asset class. */
export const QTY_RULES: Record<AssetClass, { decimals: number; max: number; unit: string; units: string }> = {
  stock: { decimals: 4, max: 1_000_000, unit: "share", units: "shares" },
  crypto: { decimals: 8, max: 1_000_000_000_000, unit: "coin", units: "coins" },
  future: { decimals: 0, max: 500, unit: "contract", units: "contracts" },
};

export const TRADING_HOURS: Record<AssetClass, string> = {
  stock: "Weekdays 9:30–16:00 New York time",
  crypto: "24/7",
  future: "Nearly 24 hours, Sunday evening to Friday (New York time)",
};
