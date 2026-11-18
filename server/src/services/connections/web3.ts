import { createHash } from "node:crypto";
import type { Ctx } from "../../context.js";
import { all } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { STABLECOINS } from "../trading/instruments.js";
import { marketFor } from "../trading/market.js";
import { jsonRequest } from "./http.js";
import { ConnectorError, type AccountSnapshot, type Aggregator } from "./types.js";

/**
 * Watch-only Web3 wallets. The customer pastes a public address and Aurex reads its balances from
 * public blockchain data. Nothing is signed and no key is ever involved, so nothing can be moved.
 * Anything that looks like a recovery phrase or private key is refused, and never stored or echoed.
 *
 * Addresses are recognised by their format:
 * - 0x… (EVM): checked on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain, with each
 *   network's native coin plus USDC and USDT (and DAI and WBTC on Ethereum).
 * - Bitcoin: legacy (1…, 3…) and SegWit/Taproot (bc1…) addresses, with checksums verified.
 * - Solana: base58 public keys, with SOL, USDC and USDT.
 * Endpoints default to free public ones and can point at your own node (WEB3_*_RPC, WEB3_BITCOIN_API).
 */

export type Chain = "evm" | "bitcoin" | "solana";

interface Token {
  symbol: string;
  address: string;
  decimals: number;
}

interface EvmNetwork {
  id: string;
  name: string;
  rpc: (ctx: Ctx) => string;
  native: string;
  tokens: Token[];
}

// Token contracts and decimals were checked on-chain (symbol() and decimals() on each network).
export const EVM_NETWORKS: EvmNetwork[] = [
  {
    id: "ethereum",
    name: "Ethereum",
    rpc: (ctx) => ctx.config.WEB3_ETHEREUM_RPC,
    native: "ETH",
    tokens: [
      { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
      { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
      { symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
      { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
    ],
  },
  {
    id: "base",
    name: "Base",
    rpc: (ctx) => ctx.config.WEB3_BASE_RPC,
    native: "ETH",
    tokens: [{ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 }],
  },
  {
    id: "arbitrum",
    name: "Arbitrum",
    rpc: (ctx) => ctx.config.WEB3_ARBITRUM_RPC,
    native: "ETH",
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
    ],
  },
  {
    id: "optimism",
    name: "Optimism",
    rpc: (ctx) => ctx.config.WEB3_OPTIMISM_RPC,
    native: "ETH",
    tokens: [
      { symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
      { symbol: "USDT", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
    ],
  },
  {
    id: "polygon",
    name: "Polygon",
    rpc: (ctx) => ctx.config.WEB3_POLYGON_RPC,
    native: "POL",
    tokens: [
      { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
      { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
    ],
  },
  {
    id: "bnb",
    name: "BNB Chain",
    rpc: (ctx) => ctx.config.WEB3_BNB_RPC,
    native: "BNB",
    tokens: [
      { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
      { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
    ],
  },
];

export const SOLANA_TOKENS: Token[] = [
  { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
];

export const CHAIN_LABEL: Record<Chain, string> = { evm: "Ethereum & EVM networks", bitcoin: "Bitcoin", solana: "Solana" };

// ---------------------------------------------------------------------------
// Recognising (and refusing) what people paste
// ---------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

/** Legacy Bitcoin address (1… or 3…) with a valid checksum. */
function validBase58Check(addr: string) {
  const bytes = base58Decode(addr);
  if (!bytes || bytes.length !== 25 || (bytes[0] !== 0x00 && bytes[0] !== 0x05)) return false;
  const check = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
  return Buffer.from(bytes.subarray(21)).equals(check);
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

/** SegWit (bech32, bc1q…) or Taproot (bech32m, bc1p…) address with a valid checksum. */
function validBech32(addr: string) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (s.slice(0, pos) !== "bc") return false;
  const data = [...s.slice(pos + 1)].map((c) => BECH32.indexOf(c));
  if (data.length < 8 || data.some((d) => d < 0)) return false;
  const hrp = [..."bc"].map((c) => c.charCodeAt(0));
  const pm = polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]);
  return data[0] === 0 ? pm === 1 : pm === 0x2bc830a3;
}

/** Why a pasted value must not be used, without ever repeating it. Null when it's not a secret. */
export function secretWarning(raw: string): string | null {
  const v = raw.trim();
  const words = v.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-zA-Z]{3,8}$/.test(w))) {
    return "That looks like a recovery phrase. Never share it with anyone, Aurex included: whoever has it owns your wallet. Paste your public address instead.";
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) {
    return "That looks like a private key (or a transaction ID), not an address. Never share a private key. Paste your public address, which starts with 0x and has 40 characters after it.";
  }
  if (/^[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,}$/.test(v)) return "That's an extended private key. Never share it. Paste a single public address instead.";
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(v) && base58Decode(v)?.length && [37, 38].includes(base58Decode(v)!.length)) {
    return "That looks like a Bitcoin private key. Never share it. Paste your public address, which starts with bc1, 1 or 3.";
  }
  if (/^\[\s*\d+(\s*,\s*\d+){63}\s*\]$/.test(v) || (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v) && base58Decode(v)?.length === 64)) {
    return "That looks like a Solana private key. Never share it. Paste your wallet's public address instead.";
  }
  return null;
}

export interface ParsedAddress {
  chain: Chain;
  address: string;
}

/** Recognises a public address, or explains (without echoing it) why the input can't be used. */
export function parseAddress(raw: string): ParsedAddress {
  const warning = secretWarning(raw);
  if (warning) throw badRequest(warning);
  const v = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
    if (/^0x0{40}$/.test(v)) throw badRequest("That's the zero address, which nobody owns");
    return { chain: "evm", address: v.toLowerCase() };
  }
  if (/^(bc1|BC1)[0-9A-Za-z]{8,87}$/.test(v)) {
    if (!validBech32(v)) throw badRequest("That Bitcoin address has a typo (its checksum doesn't match). Copy it again from your wallet.");
    return { chain: "bitcoin", address: v.toLowerCase() };
  }
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(v)) {
    if (!validBase58Check(v)) throw badRequest("That Bitcoin address has a typo (its checksum doesn't match). Copy it again from your wallet.");
    return { chain: "bitcoin", address: v };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) && base58Decode(v)?.length === 32) {
    return { chain: "solana", address: v };
  }
  if (/^[xyz]pub/.test(v)) throw badRequest("Extended public keys (xpub) aren't supported yet. Paste one receiving address from your wallet.");
  if (/\.(eth|sol)$/i.test(v)) throw badRequest("Names like .eth or .sol aren't supported yet. Paste the address they point to.");
  throw badRequest("That doesn't look like a wallet address. Paste a public address: 0x… for Ethereum and similar networks, bc1…, 1… or 3… for Bitcoin, or a Solana address.");
}

/** A shortened form that's safe to show around the app. */
export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

// ---------------------------------------------------------------------------
// Reading balances
// ---------------------------------------------------------------------------
/** A raw integer amount in the token's smallest unit, as a decimal number. */
export function fromUnits(raw: bigint, decimals: number): number {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const n = Number(frac ? `${whole}.${frac}` : `${whole}`);
  return neg ? -n : n;
}

interface RpcReply {
  id: number;
  result?: string;
  error?: { message?: string };
}

async function evmBalances(ctx: Ctx, net: EvmNetwork, address: string) {
  const owner = address.slice(2).padStart(64, "0");
  const calls = [
    { jsonrpc: "2.0", id: 0, method: "eth_getBalance", params: [address, "latest"] },
    ...net.tokens.map((t, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: t.address, data: `0x70a08231${owner}` }, "latest"] })),
  ];
  const replies = await jsonRequest<RpcReply[] | RpcReply>(net.name, net.rpc(ctx), { method: "POST", body: calls, timeoutMs: 12_000 });
  if (!Array.isArray(replies)) throw new ConnectorError(`${net.name}: ${replies.error?.message ?? "unexpected reply"}`, "web3");
  const byId = new Map(replies.map((r) => [r.id, r]));
  const read = (id: number) => {
    const r = byId.get(id);
    if (!r || r.error || typeof r.result !== "string") throw new ConnectorError(`${net.name}: ${r?.error?.message ?? "no answer"}`, "web3");
    return r.result === "0x" ? 0n : BigInt(r.result);
  };
  return [
    { symbol: net.native, amount: fromUnits(read(0), 18), key: "native" },
    ...net.tokens.map((t, i) => ({ symbol: t.symbol, amount: fromUnits(read(i + 1), t.decimals), key: t.symbol })),
  ];
}

async function bitcoinBalance(ctx: Ctx, address: string) {
  const r = await jsonRequest<{ chain_stats?: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number } }>(
    "Bitcoin",
    `${ctx.config.WEB3_BITCOIN_API.replace(/\/$/, "")}/address/${encodeURIComponent(address)}`,
    { timeoutMs: 12_000 },
  );
  const sats = (s?: { funded_txo_sum: number; spent_txo_sum: number }) => BigInt(s?.funded_txo_sum ?? 0) - BigInt(s?.spent_txo_sum ?? 0);
  return fromUnits(sats(r.chain_stats) + sats(r.mempool_stats), 8);
}

async function solanaBalances(ctx: Ctx, address: string) {
  const rpc = ctx.config.WEB3_SOLANA_RPC;
  const call = <T>(method: string, params: unknown[]) =>
    jsonRequest<{ result?: T; error?: { message?: string } }>("Solana", rpc, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params }, timeoutMs: 12_000 }).then((r) => {
      if (r.error || r.result === undefined) throw new ConnectorError(`Solana: ${r.error?.message ?? "no answer"}`, "web3");
      return r.result;
    });
  const lamports = await call<{ value: number }>("getBalance", [address]);
  const out = [{ symbol: "SOL", amount: fromUnits(BigInt(lamports.value), 9), key: "native" }];
  for (const t of SOLANA_TOKENS) {
    const accounts = await call<{ value: { account: { data: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } }[] }>("getTokenAccountsByOwner", [
      address,
      { mint: t.address },
      { encoding: "jsonParsed" },
    ]);
    const raw = accounts.value.reduce((s, a) => s + BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
    out.push({ symbol: t.symbol, amount: fromUnits(raw, t.decimals), key: t.symbol });
  }
  return out;
}

/** USD prices for this sync, from the same crypto prices the Trading page uses. */
function pricer(ctx: Ctx, userId: string) {
  const cache = new Map<string, Promise<number | null>>();
  const market = marketFor(ctx, userId);
  return (symbol: string) => {
    if (STABLECOINS.has(symbol)) return Promise.resolve(1);
    const pair = `${symbol === "WBTC" ? "BTC" : symbol}-USD`;
    let p = cache.get(pair);
    if (!p) {
      p = market.quote(pair).then((q) => q.price, () => null);
      cache.set(pair, p);
    }
    return p;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const web3Aggregator: Aggregator = {
  info: {
    id: "web3",
    name: "Web3 wallets",
    category: "crypto",
    kind: "aggregator",
    coverage: "Any public address on Bitcoin, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana",
    regions: ["Global"],
    countries: [],
    capabilities: ["balances"],
    description:
      "Watch-only: paste a public wallet address (MetaMask, Coinbase Wallet, Trust Wallet, Phantom, Ledger…) to see its coins and stablecoins in your net worth. No keys and no signing: nothing can be moved.",
    envKeys: [],
  },
  configured: (ctx) => ctx.config.WEB3_WALLETS,
  async start() {
    throw badRequest("Add a Web3 wallet by pasting its public address");
  },
  async complete() {
    throw badRequest("Add a Web3 wallet by pasting its public address");
  },
  async accounts(ctx, user, conn, secret) {
    if (!secret) throw new ConnectorError("This wallet's address is missing; remove it and add it again", "web3");
    const { chain, address } = JSON.parse(secret) as ParsedAddress;
    const price = pricer(ctx, user.id);
    const mask = address.slice(-4);
    const out: AccountSnapshot[] = [];
    const add = async (externalId: string, name: string, symbol: string, amount: number, always = false) => {
      if (!always && amount === 0) return;
      const p = await price(symbol);
      out.push({ externalId, name, kind: "crypto", mask, currency: symbol, balance: amount, available: null, valueUsd: p === null ? null : round2(amount * p) });
    };

    if (chain === "bitcoin") {
      await add("bitcoin:native", "Bitcoin", "BTC", await bitcoinBalance(ctx, address), true);
    } else if (chain === "solana") {
      for (const b of await solanaBalances(ctx, address)) await add(`solana:${b.key}`, `${b.symbol} on Solana`, b.symbol, b.amount, b.key === "native");
    } else {
      const results = await Promise.allSettled(EVM_NETWORKS.map((n) => evmBalances(ctx, n, address)));
      if (results.every((r) => r.status === "rejected")) {
        throw new ConnectorError(`Couldn't reach the networks right now: ${(results[0] as PromiseRejectedResult).reason?.message ?? "no answer"}`, "web3");
      }
      for (const [i, r] of results.entries()) {
        const net = EVM_NETWORKS[i];
        if (r.status === "fulfilled") {
          for (const b of r.value) await add(`${net.id}:${b.key}`, `${b.symbol} on ${net.name}`, b.symbol, b.amount, net.id === "ethereum" && b.key === "native");
        } else {
          // A network that didn't answer keeps its last known balances rather than vanishing.
          for (const prev of all<{ external_id: string; name: string; currency: string; balance: number; value_usd: number | null }>(
            ctx.db,
            "SELECT external_id, name, currency, balance, value_usd FROM linked_accounts WHERE connection_id = ? AND external_id LIKE ?",
            conn.id,
            `${net.id}:%`,
          )) {
            out.push({ externalId: prev.external_id, name: prev.name, kind: "crypto", mask, currency: prev.currency, balance: prev.balance, available: null, valueUsd: prev.value_usd });
          }
        }
      }
    }
    return out;
  },
};
