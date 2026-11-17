import { afterEach, describe, expect, it, vi } from "vitest";
import { fromAlpacaSymbol, toAlpacaSymbol } from "../src/services/trading/brokers/alpaca.js";
import { paperBroker } from "../src/services/trading/brokers/paper.js";
import { resetCryptoCache } from "../src/services/trading/crypto.js";
import { cleanName, parseDirectory, resetStockDirectory } from "../src/services/trading/directory.js";
import { frontMonth, FUTURES_BY_SYMBOL, normalizeSymbol } from "../src/services/trading/instruments.js";
import type { MarketData, Quote } from "../src/services/trading/market.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

afterEach(() => {
  resetCryptoCache();
  resetStockDirectory();
  vi.restoreAllMocks();
});

/** A market whose prices the test sets. */
function fakeMarket(prices: Record<string, number>): MarketData {
  return {
    source: "simulated",
    async quote(symbol) {
      const price = prices[symbol];
      if (price === undefined) throw new Error(`no price for ${symbol}`);
      return { symbol, name: symbol, price, prevClose: price, change: 0, changePct: 0, dayHigh: price, dayLow: price, asOf: new Date().toISOString(), source: "simulated", assetClass: "stock", hours: "" } as Quote;
    },
    async bars() {
      return [];
    },
  };
}

describe("instruments", () => {
  it("normalizes stock, crypto and futures symbols", () => {
    expect(normalizeSymbol(" aapl ")).toBe("AAPL");
    expect(normalizeSymbol("brk.b")).toBe("BRK.B");
    expect(normalizeSymbol("btc/usd")).toBe("BTC-USD");
    expect(normalizeSymbol("ETH-USD")).toBe("ETH-USD");
    expect(normalizeSymbol("/es")).toBe("ES=F");
    expect(normalizeSymbol("6E=F")).toBe("6E=F");
    expect(() => normalizeSymbol("BTC/EUR")).toThrow();
    expect(() => normalizeSymbol("DROP TABLE")).toThrow();
  });

  it("knows each futures contract's size and front month", () => {
    const es = FUTURES_BY_SYMBOL.get("ES=F")!;
    expect(es.multiplier * es.tickSize).toBe(12.5); // $12.50 per tick
    expect(frontMonth(es, new Date(Date.UTC(2026, 10, 17))).code).toBe("ESZ6");
    expect(frontMonth(es, new Date(Date.UTC(2026, 11, 20))).code).toBe("ESH7"); // after the December roll
    const cl = FUTURES_BY_SYMBOL.get("CL=F")!;
    expect(frontMonth(cl, new Date(Date.UTC(2026, 10, 17))).label).toBe("Dec 2026");
    expect(frontMonth(cl, new Date(Date.UTC(2026, 10, 25))).label).toBe("Jan 2027");
  });

  it("maps crypto symbols to and from Alpaca's formats", () => {
    expect(toAlpacaSymbol("BTC-USD")).toBe("BTC/USD");
    expect(toAlpacaSymbol("AAPL")).toBe("AAPL");
    expect(fromAlpacaSymbol("BTC/USD")).toBe("BTC-USD");
    expect(fromAlpacaSymbol("BTCUSD", "crypto")).toBe("BTC-USD");
    expect(fromAlpacaSymbol("AAPL", "us_equity")).toBe("AAPL");
  });

  it("parses the Nasdaq symbol directory", () => {
    const nasdaq = [
      "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
      "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
      "QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N",
      "ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N",
      "ABCDW|Example Corp - Warrants|S|N|N|100|N|N",
      "File Creation Time: 1117202603:02|||||||",
    ].join("\n");
    const other = [
      "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
      "A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A",
      "BF.B|Brown Forman Inc Class B Common Stock|N|BF.B|N|100|N|BF.B",
      "ABR$D|Arbor Realty Preferred|N|ABRpD|N|100|N|ABR-D",
      "File Creation Time: 1117202603:02|||||||",
    ].join("\n");
    const d = parseDirectory(nasdaq, other);
    expect([...d.keys()].sort()).toEqual(["A", "AAPL", "BF.B", "QQQ"]);
    expect(d.get("AAPL")!.name).toBe("Apple Inc.");
    expect(d.get("BF.B")!.name).toBe("Brown Forman Inc Class B");
    expect(d.get("QQQ")!.etf).toBe(true);
    expect(d.get("A")!.exchange).toBe("NYSE");
    expect(cleanName("Example Plc - American Depositary Shares, each representing two")).toBe("Example Plc");
  });
});

describe("markets API", () => {
  it("searches stocks, crypto and futures together or one market at a time", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "search");
    const T = api(agent);
    const bit = (await T.get("/api/trading/symbols?q=bitcoin")).body.symbols;
    expect(bit.map((s: { symbol: string }) => s.symbol)).toEqual(expect.arrayContaining(["BTC-USD", "BTC=F", "MBT=F"]));
    const apple = (await T.get("/api/trading/symbols?q=apple")).body.symbols;
    expect(apple[0]).toMatchObject({ symbol: "AAPL", assetClass: "stock" });
    const futures = (await T.get("/api/trading/symbols?class=future")).body.symbols;
    expect(futures.length).toBeGreaterThanOrEqual(18);
    expect(futures.every((s: { assetClass: string }) => s.assetClass === "future")).toBe(true);
    const slashEs = (await T.get(`/api/trading/symbols?q=${encodeURIComponent("/ES")}`)).body.symbols;
    expect(slashEs[0].symbol).toBe("ES=F");
  });

  it("quotes futures with contract details, and crypto around the clock", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "quotes");
    const T = api(agent);
    const es = (await T.get(`/api/trading/quote/${encodeURIComponent("ES=F")}`)).body.quote;
    expect(es.assetClass).toBe("future");
    expect(es.contract).toMatchObject({ multiplier: 50, tickSize: 0.25, tickValue: 12.5, exchange: "CME" });
    expect(es.contract.marginPerContract).toBeCloseTo(es.price * 50 * 0.06, 0);
    expect(es.price % 0.25).toBe(0);
    const btc = (await T.get("/api/trading/quote/BTC-USD")).body.quote;
    expect(btc).toMatchObject({ assetClass: "crypto", hours: "24/7", name: "Bitcoin" });
    const bars = (await T.get("/api/trading/bars/BTC-USD?days=30")).body.bars;
    expect(bars).toHaveLength(30);
    // Crypto has weekend bars; stocks don't.
    expect(bars.some((b: { t: string }) => [0, 6].includes(new Date(b.t).getUTCDay()))).toBe(true);
    expect((await T.get("/api/trading/quote/NOTREAL")).status).toBe(404);
    expect((await T.get(`/api/trading/quote/${encodeURIComponent("XX=F")}`)).status).toBe(404);
    const wl = (await T.get("/api/trading/watchlist")).body.items.map((i: { symbol: string }) => i.symbol);
    expect(wl).toEqual(expect.arrayContaining(["BTC-USD", "ES=F"]));
  });

  it("trades futures long and short with margin in the demo account", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "futures");
    const T = api(agent);
    const buy = await T.post("/api/trading/orders", { symbol: "ES=F", side: "buy", qty: 1 });
    expect(buy.status).toBe(201);
    expect(buy.body.order.status).toBe("filled");
    let acct = (await T.get("/api/trading/account")).body.account;
    const pos = acct.positions.find((p: { symbol: string }) => p.symbol === "ES=F");
    expect(pos).toMatchObject({ assetClass: "future", qty: 1, side: "long", multiplier: 50 });
    expect(acct.cash).toBe(100000); // futures hold margin; they don't spend cash
    expect(acct.marginUsed).toBeCloseTo(pos.margin, 2);
    expect(acct.buyingPower).toBeLessThan(100000 - pos.margin + 1000);

    const flip = await T.post("/api/trading/orders", { symbol: "ES=F", side: "sell", qty: 2 });
    expect(flip.status).toBe(201);
    acct = (await T.get("/api/trading/account")).body.account;
    expect(acct.positions.find((p: { symbol: string }) => p.symbol === "ES=F")).toMatchObject({ qty: -1, side: "short" });

    expect((await T.post("/api/trading/orders", { symbol: "ES=F", side: "buy", qty: 1.5 })).body.error.message).toMatch(/whole contracts/);
    const tooBig = await T.post("/api/trading/orders", { symbol: "ES=F", side: "sell", qty: 200 });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe("insufficient_margin");
  });

  it("buys crypto in fractions and enforces quantity rules", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "crypto");
    const T = api(agent);
    const r = await T.post("/api/trading/orders", { symbol: "btc/usd", side: "buy", qty: 0.0005 });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ symbol: "BTC-USD", qty: 0.0005, status: "filled" });
    expect((await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "buy", qty: 0.123456789 })).body.error.message).toMatch(/8 decimal/);
    expect((await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "buy", qty: 0.00000001 })).body.error.message).toMatch(/at least \$1/);
    expect((await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "sell", qty: 1 })).body.error.code).toBe("insufficient_shares");
  });

  it("lets the AI analyst size crypto in fractions and futures in contracts, and keeps the autopilot off futures", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "aimarkets");
    const T = api(agent);
    for (const symbol of ["BTC-USD", "ES=F", "SHIB-USD"]) {
      const res = await T.post("/api/trading/analyze", { symbol, provider: "rules" });
      expect(res.status).toBe(201);
      const s = res.body.signal;
      if (symbol === "ES=F") expect(Number.isInteger(s.suggestedQty)).toBe(true);
      if (s.stopLoss !== null) expect(s.stopLoss).toBeGreaterThan(0);
    }
    const bad = await T.put("/api/trading/autopilot", { symbols: ["AAPL", "ES=F"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/stocks and crypto only/);
    expect((await T.put("/api/trading/autopilot", { symbols: ["AAPL", "BTC-USD"] })).status).toBe(200);
  });
});

describe("demo broker accounting", () => {
  async function setup(prices: Record<string, number>) {
    const { app, ctx } = makeApp();
    const { user } = await signup(app, "book");
    return { broker: paperBroker(ctx, user.id, fakeMarket(prices)), prices };
  }
  const order = (symbol: string, side: "buy" | "sell", qty: number) => ({ symbol, side, qty, type: "market" as const, source: "manual" as const });

  it("settles futures profit and loss to cash when positions close", async () => {
    const { broker, prices } = await setup({ "ES=F": 6000 });
    await broker.placeOrder(order("ES=F", "buy", 2));
    prices["ES=F"] = 6010;
    let acct = await broker.account();
    expect(acct.positions[0]).toMatchObject({ unrealizedPl: 1000, marketValue: 1000, notional: 601000 });
    expect(acct.equity).toBe(101000);
    await broker.placeOrder(order("ES=F", "sell", 2));
    acct = await broker.account();
    expect(acct.positions).toHaveLength(0);
    expect(acct.cash).toBe(101000);

    await broker.placeOrder(order("ES=F", "sell", 1)); // short at 6010
    prices["ES=F"] = 6000;
    await broker.placeOrder(order("ES=F", "buy", 1)); // cover 10 points lower: +$500
    expect((await broker.account()).cash).toBe(101500);
  });

  it("averages entries, flips direction and reserves margin from stock buying power", async () => {
    const { broker, prices } = await setup({ "CL=F": 70, AAPL: 100 });
    await broker.placeOrder(order("CL=F", "buy", 1));
    prices["CL=F"] = 72;
    await broker.placeOrder(order("CL=F", "buy", 1));
    let acct = await broker.account();
    expect(acct.positions[0]).toMatchObject({ qty: 2, avgCost: 71 });
    await broker.placeOrder(order("CL=F", "sell", 3)); // close 2 (+$2,000 at 72 vs 71) and go short 1 at 72
    acct = await broker.account();
    expect(acct.cash).toBe(102000);
    expect(acct.positions[0]).toMatchObject({ qty: -1, side: "short", avgCost: 72 });
    // $7,200 of margin is held, so a $100,000 stock purchase no longer fits.
    await expect(broker.placeOrder(order("AAPL", "buy", 1000))).rejects.toMatchObject({ code: "insufficient_buying_power" });
    await broker.placeOrder(order("AAPL", "buy", 900));
  });

  it("closes futures automatically on a margin call", async () => {
    const { broker, prices } = await setup({ "ES=F": 6000 });
    await broker.placeOrder(order("ES=F", "sell", 5)); // $90,000 of margin on $100,000
    prices["ES=F"] = 6100; // -$25,000: below the $82,350 maintenance margin
    const acct = await broker.account();
    expect(acct.positions).toHaveLength(0);
    expect(acct.cash).toBe(75000);
    const orders = await broker.listOrders();
    expect(orders[0]).toMatchObject({ placedBy: "system", side: "buy", qty: 5, status: "filled", rejectReason: "Margin call: closed automatically" });
  });
});

describe("live data sources", () => {
  it("uses Coinbase for crypto prices and lists every USD pair except stablecoins", async () => {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000 / day) * day;
    const coinbase = await stub((req) => {
      if (req.route === "/products") {
        return {
          body: [
            { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", status: "online", trading_disabled: false },
            { id: "PEPE-USD", base_currency: "PEPE", quote_currency: "USD", status: "online", trading_disabled: false },
            { id: "USDT-USD", base_currency: "USDT", quote_currency: "USD", status: "online", trading_disabled: false },
            { id: "BTC-EUR", base_currency: "BTC", quote_currency: "EUR", status: "online", trading_disabled: false },
            { id: "OLD-USD", base_currency: "OLD", quote_currency: "USD", status: "delisted", trading_disabled: true },
          ],
        };
      }
      if (req.route === "/currencies") return { body: [{ id: "BTC", name: "Bitcoin" }, { id: "PEPE", name: "Pepe" }] };
      if (req.route === "/products/BTC-USD/stats") return { body: { open: "60000", high: "65000", low: "59000", last: "63000", volume: "1" } };
      if (req.route === "/products/PEPE-USD/stats") return { body: { open: "0.00001", high: "0.000012", low: "0.000009", last: "0.0000105", volume: "1" } };
      if (req.route === "/products/BTC-USD/candles") {
        return { body: [[now - day, 1, 3, 2, 2.5, 10], [now - 2 * day, 1, 3, 2, 2.2, 10], [now - 3 * day, 1, 3, 2, 2.1, 10]] };
      }
      return undefined;
    });
    const { app } = makeApp({ CRYPTO_DATA: "coinbase", COINBASE_EXCHANGE_URL: coinbase.url });
    const { agent } = await signup(app, "coinbase");
    const T = api(agent);
    const btc = (await T.get("/api/trading/quote/BTC-USD")).body.quote;
    expect(btc).toMatchObject({ name: "Bitcoin", price: 63000, prevClose: 60000, changePct: 5, source: "coinbase", dayHigh: 65000 });
    const pepe = (await T.get("/api/trading/quote/PEPE-USD")).body.quote;
    expect(pepe.price).toBe(0.0000105);
    const bars = (await T.get("/api/trading/bars/BTC-USD?days=5")).body.bars;
    expect(bars.map((b: { c: number }) => b.c)).toEqual([2.1, 2.2, 2.5]); // oldest first
    const found = (await T.get("/api/trading/symbols?class=crypto&q=p")).body.symbols.map((s: { symbol: string }) => s.symbol);
    expect(found).toContain("PEPE-USD");
    expect(found).not.toContain("USDT-USD");
    expect((await T.get("/api/trading/quote/USDT-USD")).status).toBe(404);
    expect((await T.post("/api/trading/orders", { symbol: "PEPE-USD", side: "buy", qty: 1000000 })).status).toBe(201);
  });

  it("searches every US listing from the Nasdaq directory and prices them in the simulator", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `TST${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}|Test Company ${i} - Common Stock|S|N|N|100|N|N`);
    const nasdaq = await stub((req) => {
      if (req.route === "/nasdaqlisted.txt") {
        return { text: ["Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares", "ZYN|PTL LTD - Class A Ordinary Shares|S|N|N|100|N|N", ...rows, "File Creation Time: 1117202603:02|||||||"].join("\n") };
      }
      if (req.route === "/otherlisted.txt") {
        return { text: ["ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol", "A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A", "File Creation Time|||||||"].join("\n") };
      }
      return undefined;
    });
    const { app } = makeApp({ STOCK_DIRECTORY: "nasdaq", NASDAQ_DIRECTORY_URL: nasdaq.url });
    const { agent } = await signup(app, "directory");
    const T = api(agent);
    const hits = (await T.get("/api/trading/symbols?q=agilent")).body.symbols;
    expect(hits[0]).toMatchObject({ symbol: "A", name: "Agilent Technologies, Inc.", assetClass: "stock" });
    const zyn = (await T.get("/api/trading/quote/ZYN")).body.quote;
    expect(zyn).toMatchObject({ symbol: "ZYN", name: "PTL LTD", assetClass: "stock", source: "simulated" });
    expect(zyn.price).toBeGreaterThan(0);
    expect((await T.get("/api/trading/quote/NOTLISTED")).status).toBe(404);
  });
});

describe("real (Alpaca) accounts", () => {
  it("sends crypto orders in Alpaca's format and keeps futures to the demo account", async () => {
    const realFetch = globalThis.fetch;
    const sent: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://paper-api.alpaca.markets") && !url.startsWith("https://data.alpaca.markets")) return realFetch(input, init);
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/v2/account")) return json({ cash: "1000", equity: "1100", buying_power: "1000", last_equity: "1000" });
      if (url.endsWith("/v2/positions")) {
        return json([{ symbol: "BTCUSD", asset_class: "crypto", qty: "0.001", avg_entry_price: "60000", current_price: "63000", market_value: "63", cost_basis: "60", unrealized_pl: "3", unrealized_plpc: "0.05" }]);
      }
      if (url.endsWith("/v2/orders") && init?.method === "POST") {
        return json({ id: "alp-1", symbol: "BTC/USD", side: "buy", type: "market", qty: "0.001", limit_price: null, status: "accepted", filled_qty: "0", filled_avg_price: null, created_at: new Date().toISOString() });
      }
      return new Response("{}", { status: 404 });
    });
    const { app } = makeApp();
    const { agent } = await signup(app, "alpacacrypto");
    const T = api(agent);
    expect((await T.put("/api/trading/alpaca-keys", { keyId: "PKTEST0000000000", secretKey: "secret0000000000000000" })).status).toBe(200);
    expect((await T.put("/api/trading/broker", { broker: "alpaca" })).status).toBe(200);
    const r = await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "buy", qty: 0.001 });
    expect(r.status).toBe(201);
    expect(r.body.order.symbol).toBe("BTC-USD");
    expect(sent.find((s) => s.url.endsWith("/v2/orders"))!.body).toMatchObject({ symbol: "BTC/USD", time_in_force: "gtc", qty: "0.001" });
    const acct = (await T.get("/api/trading/account")).body.account;
    expect(acct.positions[0]).toMatchObject({ symbol: "BTC-USD", assetClass: "crypto" });
    const fut = await T.post("/api/trading/orders", { symbol: "ES=F", side: "buy", qty: 1 });
    expect(fut.status).toBe(422);
    expect(fut.body.error.code).toBe("futures_demo_only");
    expect((await T.get("/api/trading/account")).body.settings.markets.futuresTradable).toBe(false);
  });
});
