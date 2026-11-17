import { afterEach, describe, expect, it, vi } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { snapshotLedger, verifySnapshots } from "../src/services/ledgerData.js";
import { backfillFills, verifyTradingRecords } from "../src/services/trading/records.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;
const cents = (n: number) => Math.round(n * 100);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function makeAdmin({ app, ctx }: App) {
  const { agent, user } = await signup(app, "admin");
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, agent, user };
}

describe("trading records", () => {
  it("records every fill with realised profit and loss on average cost, and journals the demo cash", async () => {
    const env = makeApp();
    const { agent, user } = await signup(env.app, "trader");
    const T = api(agent);
    const start = (await T.get("/api/trading/account")).body.account.cash;

    const b1 = (await T.post("/api/trading/orders", { symbol: "AAPL", side: "buy", qty: 10 })).body.order;
    const b2 = (await T.post("/api/trading/orders", { symbol: "AAPL", side: "buy", qty: 10 })).body.order;
    const s1 = (await T.post("/api/trading/orders", { symbol: "AAPL", side: "sell", qty: 5 })).body.order;
    expect([b1.status, b2.status, s1.status]).toEqual(["filled", "filled", "filled"]);

    const { fills } = (await T.get("/api/trading/records/trades")).body;
    expect(fills).toHaveLength(3);
    const [sell, buy2, buy1] = fills; // newest first
    expect(buy1).toMatchObject({ symbol: "AAPL", assetClass: "stock", side: "buy", qty: 10, closedQty: 0, realizedPl: null, positionAfter: 10, accountType: "demo" });
    expect(buy2.positionAfter).toBe(20);
    const avg = (10 * b1.filledAvgPrice + 10 * b2.filledAvgPrice) / 20;
    expect(buy2.avgCostAfter).toBeCloseTo(avg, 6);
    expect(sell).toMatchObject({ side: "sell", qty: 5, closedQty: 5, positionAfter: 15 });
    expect(sell.costBasis).toBeCloseTo(cents(5 * avg) / 100, 2);
    expect(sell.realizedPl).toBeCloseTo((cents(5 * s1.filledAvgPrice) - cents(5 * avg)) / 100, 2);

    // Cash journal: opening, two buys and a sell, adding up to the cash balance.
    const entries = (await T.get("/api/trading/records/cash")).body.entries;
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(["sell", "buy", "buy", "opening"]);
    const acct = (await T.get("/api/trading/account")).body.account;
    expect(entries[0].balanceAfter).toBeCloseTo(acct.cash, 2);
    expect(entries.reduce((s: number, e: { amount: number }) => s + cents(e.amount), 0)).toBe(cents(acct.cash));
    expect(entries[3].amount).toBe(start);
    expect(verifyTradingRecords(env.ctx).ok).toBe(true);

    // Records can't be edited or deleted.
    expect(() => env.ctx.db.prepare("UPDATE trade_fills SET price = 1").run()).toThrow(/immutable/);
    expect(() => env.ctx.db.prepare("DELETE FROM trading_cash_entries WHERE user_id = ?").run(user.id)).toThrow(/immutable/);
  });

  it("records futures profit and loss, including a position that flips from long to short", async () => {
    const env = makeApp();
    const { agent } = await signup(env.app, "futures");
    const T = api(agent);
    const open = (await T.post("/api/trading/orders", { symbol: "ES=F", side: "buy", qty: 1 })).body.order;
    const flip = (await T.post("/api/trading/orders", { symbol: "ES=F", side: "sell", qty: 2 })).body.order;
    expect(flip.status).toBe("filled");
    const [f2, f1] = (await T.get("/api/trading/records/trades?assetClass=future")).body.fills;
    expect(f1).toMatchObject({ symbol: "ES=F", assetClass: "future", multiplier: 50, closedQty: 0, positionAfter: 1 });
    expect(f2).toMatchObject({ closedQty: 1, positionAfter: -1, avgCostAfter: flip.filledAvgPrice });
    expect(f2.realizedPl).toBeCloseTo((flip.filledAvgPrice - open.filledAvgPrice) * 50, 2);
    expect(f2.notional).toBeCloseTo(2 * flip.filledAvgPrice * 50, 2);
    expect(verifyTradingRecords(env.ctx).ok).toBe(true);
  });

  it("reports realised P&L by year, month and symbol, with CSV downloads", async () => {
    const env = makeApp();
    const { agent } = await signup(env.app, "reporter");
    const T = api(agent);
    await T.post("/api/trading/orders", { symbol: "MSFT", side: "buy", qty: 4 });
    await T.post("/api/trading/orders", { symbol: "MSFT", side: "sell", qty: 4 });
    await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "buy", qty: 0.01 });
    await T.post("/api/trading/orders", { symbol: "BTC-USD", side: "sell", qty: 0.004 });

    const { years, report } = (await T.get("/api/trading/records/realized")).body;
    const year = new Date().getUTCFullYear();
    expect(years).toEqual([year]);
    expect(report).toMatchObject({ year, accountType: "demo", closingTrades: 2, trades: 4, method: "average cost" });
    const lineSum = report.lines.reduce((s: number, l: { realizedPl: number }) => s + cents(l.realizedPl), 0);
    expect(cents(report.realizedPl)).toBe(lineSum);
    expect(report.bySymbol.map((s: { symbol: string }) => s.symbol).sort()).toEqual(["BTC-USD", "MSFT"]);
    expect(report.months.reduce((s: number, m: { trades: number }) => s + m.trades, 0)).toBe(2);
    expect(cents(report.proceeds) - cents(report.costBasis)).toBe(lineSum);

    const csv = await T.get("/api/trading/records/realized?format=csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toContain('"MSFT"');
    const trades = await T.get("/api/trading/records/trades?format=csv&symbol=msft");
    expect(trades.text.trim().split("\r\n")).toHaveLength(3); // header + 2 MSFT fills
    expect((await T.get("/api/trading/records/trades?from=2026-13-01")).status).toBe(400);
  });

  it("values the portfolio each day and measures performance from the last demo reset", async () => {
    const env = makeApp();
    const { agent, user } = await signup(env.app, "perf");
    const T = api(agent);
    await T.post("/api/trading/orders", { symbol: "SPY", side: "buy", qty: 3 });
    await T.get("/api/trading/account");
    // Earlier days, as the daily job would have written them.
    const ins = env.ctx.db.prepare(
      "INSERT INTO portfolio_snapshots (user_id, day, broker, equity_cents, cash_cents, positions_cents, unrealized_cents, positions, updated_at) VALUES (?, ?, 'paper', ?, 0, 0, 0, 1, ?)",
    );
    ins.run(user.id, "2026-01-02", 12_000_00, new Date().toISOString());
    ins.run(user.id, "2026-01-03", 9_000_00, new Date().toISOString());
    let perf = (await T.get("/api/trading/records/performance")).body.performance;
    expect(perf.series.length).toBeGreaterThanOrEqual(3);
    expect(perf.maxDrawdownPct).toBeGreaterThanOrEqual(25); // 12,000 -> 9,000
    expect(perf.trades).toBe(1);

    await T.post("/api/trading/account/reset", { startingCash: 5000 });
    const cash = (await T.get("/api/trading/records/cash")).body.entries;
    expect(cash[0]).toMatchObject({ kind: "reset", balanceAfter: 5000 });
    perf = (await T.get("/api/trading/records/performance")).body.performance;
    expect(perf.since).toBeTruthy();
    expect(perf.series.every((s: { day: string }) => s.day >= perf.since.slice(0, 10))).toBe(true);
    expect(perf.trades).toBe(0);
    expect(verifyTradingRecords(env.ctx).ok).toBe(true);
  });

  it("backfills orders filled before records began, with unknown profit and loss", async () => {
    const env = makeApp();
    const { agent, user } = await signup(env.app, "legacy");
    await api(agent).get("/api/trading/account");
    const now = new Date().toISOString();
    env.ctx.db
      .prepare(
        `INSERT INTO orders (id, user_id, broker, symbol, side, type, qty, status, filled_qty, filled_avg_price, created_at, updated_at)
         VALUES ('ord_old', ?, 'paper', 'NVDA', 'sell', 'market', 2, 'filled', 2, 100, ?, ?)`,
      )
      .run(user.id, now, now);
    expect(verifyTradingRecords(env.ctx).missingFills).toBe(1);
    expect(backfillFills(env.ctx)).toBe(1);
    expect(backfillFills(env.ctx)).toBe(0);
    const fill = (await api(agent).get("/api/trading/records/trades")).body.fills[0];
    expect(fill).toMatchObject({ symbol: "NVDA", qty: 2, price: 100, realizedPl: null });
    expect(verifyTradingRecords(env.ctx).missingFills).toBe(0);
  });

  it("records Alpaca executions once they're final, without guessing profit and loss", async () => {
    const realFetch = globalThis.fetch;
    const now = new Date().toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://paper-api.alpaca.markets")) return realFetch(input, init);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/v2/account")) return json({ cash: "1000", equity: "1000", buying_power: "1000", last_equity: "1000" });
      if (url.endsWith("/v2/positions")) return json([]);
      if (url.includes("/v2/orders?status=all")) {
        return json([
          { id: "a1", symbol: "AAPL", side: "buy", type: "market", qty: "3", limit_price: null, status: "filled", filled_qty: "3", filled_avg_price: "190.5", created_at: now, filled_at: now },
          { id: "a2", symbol: "BTC/USD", side: "buy", type: "limit", qty: "0.01", limit_price: "50000", status: "new", filled_qty: "0", filled_avg_price: null, created_at: now },
          { id: "a3", symbol: "MSFT", side: "buy", type: "limit", qty: "5", limit_price: "300", status: "canceled", filled_qty: "2", filled_avg_price: "299", created_at: now },
        ]);
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeApp();
    const { agent } = await signup(env.app, "alpacafills");
    const T = api(agent);
    await T.put("/api/trading/alpaca-keys", { keyId: "PKTEST0000000000", secretKey: "secret0000000000000000" });
    await T.put("/api/trading/broker", { broker: "alpaca" });
    await T.get("/api/trading/orders");
    await T.get("/api/trading/orders"); // seen twice, recorded once
    const { fills } = (await T.get("/api/trading/records/trades")).body;
    expect(fills.map((f: { symbol: string; qty: number }) => `${f.symbol}:${f.qty}`).sort()).toEqual(["AAPL:3", "MSFT:2"]);
    expect(fills.every((f: { broker: string; accountType: string }) => f.broker === "alpaca" && f.accountType === "demo")).toBe(true);
  });
});

describe("ledger data", () => {
  it("explores journals, balances the books for any day and snapshots each day", async () => {
    const env = makeApp();
    const a = await signup(env.app, "payer");
    const b = await signup(env.app, "payee");
    const A = api(a.agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const sent = await A.post("/api/payments/send", { to: `@${b.user.handle}`, amount: "30", currency: "USD", memo: "lunch" });
    expect(sent.status).toBe(201);
    const admin = await makeAdmin(env);

    const list = (await admin.A.get(`/api/admin/ledger/journals?user=${b.user.id}`)).body;
    expect(list.journals).toHaveLength(1);
    expect(list.journals[0]).toMatchObject({ kind: "transfer", memo: "lunch" });
    expect(list.kinds).toEqual(expect.arrayContaining(["deposit", "transfer"]));
    const detail = (await admin.A.get(`/api/admin/ledger/journals/${list.journals[0].id}`)).body.journal;
    expect(detail.balanced).toBe(true);
    const payeeEntry = detail.entries.find((e: { account: { handle: string | null } }) => e.account.handle === b.user.handle);
    expect(payeeEntry).toMatchObject({ amount: "30.00", balanceAfter: "30.00", currency: "USD" });
    expect((await admin.A.get("/api/admin/ledger/journals/jrn_nope")).status).toBe(404);
    // Find a deposit by its transfer id.
    const ext = env.ctx.db.prepare("SELECT id FROM external_transfers WHERE user_id = ?").get(a.user.id) as { id: string };
    expect((await admin.A.get(`/api/admin/ledger/journals?q=${ext.id}`)).body.journals[0].kind).toBe("deposit");

    const tb = (await admin.A.get("/api/admin/ledger/trial-balance")).body.trialBalance;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: { currency: string }) => r.currency === "USD")).toMatchObject({ customerFunds: "100.00", customersWithBalance: 2, total: "0.00" });
    const csv = await admin.A.get("/api/admin/ledger/trial-balance?format=csv");
    expect(csv.text).toContain("Customer funds");

    // Snapshots for finished days: move the clock forward two days.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 86_400_000 });
    const written = snapshotLedger(env.ctx);
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(snapshotLedger(env.ctx)).toEqual([]);
    vi.useRealTimers(); // (two days on, the admin's session would have timed out)
    const snaps = (await admin.A.get("/api/admin/ledger/snapshots?currency=USD")).body;
    expect(snaps.snapshots[snaps.snapshots.length - 1]).toMatchObject({ currency: "USD", customerFunds: "100.00", balanced: true });
    expect(snaps.verification.ok).toBe(true);
    // A tampered snapshot is caught when recomputed from the entries.
    env.ctx.db.prepare("UPDATE ledger_snapshots SET customer_cents = customer_cents + 1").run();
    expect(verifySnapshots(env.ctx).ok).toBe(false);
  });

  it("exports ledger entries as CSV (audited, needs a recent sign-in) and wallet activity for a date range", async () => {
    const env = makeApp();
    const a = await signup(env.app, "exporter");
    const A = api(a.agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "25", currency: "USD" });
    const admin = await makeAdmin(env);
    const today = new Date().toISOString().slice(0, 10);
    const exp = await admin.A.get(`/api/admin/ledger/export?from=${today}&to=${today}`);
    expect(exp.status).toBe(200);
    expect(exp.text.split("\r\n")[0]).toContain("Debit");
    expect(exp.text).toContain(`"${a.user.handle}"`);
    const audited = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.ledger_exported'").get() as { n: number };
    expect(audited.n).toBe(1);
    expect((await admin.A.get(`/api/admin/ledger/export?from=2024-01-01&to=${today}`)).status).toBe(400); // more than a year

    const act = await A.get(`/api/account/activity?from=${today}&to=${today}&currency=USD`);
    expect(act.headers["content-type"]).toMatch(/text\/csv/);
    expect(act.text).toContain('"25.00"');
    expect((await A.get(`/api/account/activity?from=${today}&to=2020-01-01&currency=USD`)).status).toBe(400);
    // Customers can't reach the books.
    expect((await A.get("/api/admin/ledger/journals")).status).toBe(403);
  });
});
