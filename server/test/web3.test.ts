import { describe, expect, it } from "vitest";
import { fromUnits, parseAddress, secretWarning } from "../src/services/connections/web3.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub, type Recorded } from "./stub.js";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const hex = (n: bigint) => `0x${n.toString(16)}`;
const E18 = 10n ** 18n;

/** One stub answering JSON-RPC batches for every EVM network (/ethereum, /base, …). */
async function evmStub(balances: Record<string, { native: bigint; tokens?: Record<string, bigint> }>, failing = new Set<string>()) {
  return stub((req: Recorded) => {
    const net = req.route.slice(1);
    if (failing.has(net)) return { status: 503, body: { message: "upstream unavailable" } };
    const b = balances[net] ?? { native: 0n };
    const calls = req.body as { id: number; method: string; params: [{ to?: string; data?: string } | string, string] }[];
    return {
      body: calls.map((c) => {
        if (c.method === "eth_getBalance") return { jsonrpc: "2.0", id: c.id, result: hex(b.native) };
        const to = (c.params[0] as { to: string }).to;
        return { jsonrpc: "2.0", id: c.id, result: hex(b.tokens?.[to] ?? 0n) };
      }),
    };
  });
}

const evmEnv = (url: string) => ({
  WEB3_ETHEREUM_RPC: `${url}/ethereum`,
  WEB3_BASE_RPC: `${url}/base`,
  WEB3_ARBITRUM_RPC: `${url}/arbitrum`,
  WEB3_OPTIMISM_RPC: `${url}/optimism`,
  WEB3_POLYGON_RPC: `${url}/polygon`,
  WEB3_BNB_RPC: `${url}/bnb`,
});

describe("recognising addresses", () => {
  it("accepts public addresses on each chain and catches typos", () => {
    expect(parseAddress(EVM)).toEqual({ chain: "evm", address: EVM.toLowerCase() });
    expect(parseAddress(" 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa ")).toEqual({ chain: "bitcoin", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
    expect(parseAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").chain).toBe("bitcoin");
    expect(parseAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0").chain).toBe("bitcoin"); // Taproot (BIP-350)
    expect(parseAddress("vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg")).toEqual({ chain: "solana", address: "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg" });
    expect(() => parseAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx")).toThrow(/typo/);
    expect(() => parseAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toThrow(/typo/);
    expect(() => parseAddress("0x0000000000000000000000000000000000000000")).toThrow(/zero address/);
    expect(() => parseAddress("vitalik.eth")).toThrow(/aren't supported/);
    expect(() => parseAddress("xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz")).toThrow(/Extended public keys/);
    expect(() => parseAddress("hello")).toThrow(/doesn't look like a wallet address/);
  });

  it("refuses recovery phrases and private keys, without ever repeating them", () => {
    const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const cases = [
      [phrase, /recovery phrase/],
      [`0x${"4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"}`, /private key/],
      ["4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", /private key/],
      ["5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ", /Bitcoin private key/],
      [`[${Array.from({ length: 64 }, (_, i) => i * 3).join(",")}]`, /Solana private key/],
    ] as const;
    for (const [input, msg] of cases) {
      const warning = secretWarning(input)!;
      expect(warning).toMatch(msg);
      expect(warning).not.toContain(input.slice(2, 12));
      expect(() => parseAddress(input)).toThrow(msg);
    }
    expect(secretWarning(EVM)).toBeNull();
  });

  it("converts token units exactly", () => {
    expect(fromUnits(1_500_000n, 6)).toBe(1.5);
    expect(fromUnits(123n * E18 + 456n, 18)).toBe(123.000000000000000456);
    expect(fromUnits(0n, 8)).toBe(0);
  });
});

describe("watch-only wallets", () => {
  it("adds an EVM wallet by address and reads every network's coins and stablecoins", async () => {
    const rpc = await evmStub({
      ethereum: { native: 2n * E18 + E18 / 2n, tokens: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 125_500_000n } },
      base: { native: 0n, tokens: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 40_000_000n } },
      bnb: { native: 0n, tokens: { "0x55d398326f99059ff775485246999027b3197955": 10n * E18 } }, // USDT has 18 decimals on BNB Chain
    });
    const env = makeApp(evmEnv(rpc.url));
    const { agent, user } = await signup(env.app, "holder");
    const A = api(agent);

    const res = await A.post("/api/connections/web3", { address: EVM, label: "My MetaMask" });
    expect(res.status).toBe(201);
    const conn = res.body.connections.find((c: { provider: string }) => c.provider === "web3");
    expect(conn).toMatchObject({ institution: "My MetaMask", status: "active", wallet: { chain: "evm", address: "0xd8da…6045" } });
    const byName = Object.fromEntries(conn.accounts.map((a: { name: string; balance: number; valueUsd: number | null }) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(["ETH on Ethereum", "USDC on Base", "USDC on Ethereum", "USDT on BNB Chain"]);
    expect(byName["ETH on Ethereum"]).toMatchObject({ balance: 2.5, currency: "ETH", kind: "crypto", mask: "6045" });
    expect(byName["ETH on Ethereum"].valueUsd).toBeGreaterThan(0);
    expect(byName["USDC on Ethereum"]).toMatchObject({ balance: 125.5, valueUsd: 125.5 });
    expect(byName["USDT on BNB Chain"]).toMatchObject({ balance: 10, valueUsd: 10 });
    expect(res.body.netWorth).toBeGreaterThan(175);

    // What was asked: balances only, for this address.
    const ethCalls = rpc.calls.find((c) => c.route === "/ethereum")!.body as { method: string; params: unknown[] }[];
    expect(ethCalls[0]).toMatchObject({ method: "eth_getBalance", params: [EVM.toLowerCase(), "latest"] });
    expect((ethCalls[1].params[0] as { data: string }).data).toBe(`0x70a08231000000000000000000000000${EVM.slice(2).toLowerCase()}`);

    // The address isn't stored in the clear anywhere.
    const row = env.ctx.db.prepare("SELECT external_id, secret_enc, meta FROM linked_connections WHERE user_id = ?").get(user.id) as Record<string, string>;
    expect(JSON.stringify(row).toLowerCase()).not.toContain(EVM.slice(2).toLowerCase());
    const audit = env.ctx.db.prepare("SELECT details FROM audit_events WHERE action = 'connections.linked'").all() as { details: string }[];
    expect(JSON.stringify(audit).toLowerCase()).not.toContain(EVM.slice(2, 12).toLowerCase());

    // Same wallet again (any letter case) is refused.
    expect((await A.post("/api/connections/web3", { address: EVM.toUpperCase().replace("0X", "0x") })).status).toBe(409);
  });

  it("keeps a network's last balances when it doesn't answer, and flags the wallet when none do", async () => {
    const balances = { ethereum: { native: E18 }, polygon: { native: 3n * E18 } };
    const failing = new Set<string>();
    const rpc = await evmStub(balances, failing);
    const env = makeApp(evmEnv(rpc.url));
    const { agent } = await signup(env.app, "patient");
    const A = api(agent);
    const added = (await A.post("/api/connections/web3", { address: EVM })).body.connections[0];
    expect(added.accounts.map((a: { name: string }) => a.name).sort()).toEqual(["ETH on Ethereum", "POL on Polygon"]);

    balances.ethereum.native = 2n * E18;
    failing.add("polygon");
    let synced = (await A.post(`/api/connections/${added.id}/sync`)).body.connections[0];
    const names = Object.fromEntries(synced.accounts.map((a: { name: string; balance: number }) => [a.name, a.balance]));
    expect(names).toEqual({ "ETH on Ethereum": 2, "POL on Polygon": 3 });

    for (const n of ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb"]) failing.add(n);
    const res = await A.post(`/api/connections/${added.id}/sync`);
    expect(res.status).toBe(502);
    synced = (await A.get("/api/connections")).body.connections[0];
    expect(synced.status).toBe("error");
    expect(synced.error).toMatch(/Couldn't reach the networks/);
  });

  it("reads Bitcoin and Solana wallets, including Solana stablecoins", async () => {
    const btc = await stub((req) =>
      req.route === "/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
        ? { body: { chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 25_000_000 }, mempool_stats: { funded_txo_sum: 1_000, spent_txo_sum: 0 } } }
        : undefined,
    );
    const sol = await stub((req) => {
      const { method, params, id } = req.body as { method: string; params: [string, { mint?: string }]; id: number };
      if (method === "getBalance") return { body: { jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 2_500_000_000 } } };
      if (method === "getTokenAccountsByOwner") {
        const usdc = params[1].mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const acct = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } });
        return { body: { jsonrpc: "2.0", id, result: { value: usdc ? [acct("1000000"), acct("2500000")] : [] } } };
      }
      return undefined;
    });
    const env = makeApp({ WEB3_BITCOIN_API: btc.url, WEB3_SOLANA_RPC: sol.url });
    const { agent } = await signup(env.app, "multichain");
    const A = api(agent);
    await A.post("/api/connections/web3", { address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });
    const res = await A.post("/api/connections/web3", { address: "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg", label: "Phantom" });
    const [bitcoin, solana] = res.body.connections;
    expect(bitcoin).toMatchObject({ institution: "Bitcoin wallet", wallet: { chain: "bitcoin", network: "Bitcoin" } });
    expect(bitcoin.accounts).toEqual([expect.objectContaining({ name: "Bitcoin", currency: "BTC", balance: 1.25001 })]);
    expect(solana.accounts.map((a: { name: string; balance: number }) => [a.name, a.balance])).toEqual([
      ["SOL on Solana", 2.5],
      ["USDC on Solana", 3.5],
    ]);
  });

  it("refuses secrets at the API without storing them, and can be switched off", async () => {
    const env = makeApp();
    const { agent } = await signup(env.app, "careful");
    const A = api(agent);
    const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const res = await A.post("/api/connections/web3", { address: phrase });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/recovery phrase/);
    expect(JSON.stringify(res.body)).not.toContain("sausage");
    const stored = env.ctx.db.prepare("SELECT (SELECT COUNT(*) FROM linked_connections) AS conns, (SELECT COUNT(*) FROM audit_events WHERE details LIKE '%sausage%') AS audits").get() as { conns: number; audits: number };
    expect(stored).toEqual({ conns: 0, audits: 0 });

    const off = makeApp({ WEB3_WALLETS: "false" });
    const o = await signup(off.app, "nowallets");
    expect((await api(o.agent).post("/api/connections/web3", { address: EVM })).status).toBe(422);
    const providers = (await api(o.agent).get("/api/connections/providers")).body.providers;
    expect(providers.find((p: { id: string }) => p.id === "web3").configured).toBe(false);
  });
});
