import { beforeEach, describe, expect, it, vi } from "vitest";
import { run as dbRun } from "../src/db/index.js";
import { api, makeApp, signup } from "./helpers.js";

/**
 * The analyst's real output depends on the (simulated) market of the day, so these tests wrap it and
 * override the verdict. The real analyze() still runs, so a genuine signal row exists for every order.
 */
const override: { action?: "buy" | "sell" | "hold"; confidence?: number; stopPct?: number; targetPct?: number } = {};

vi.mock("../src/services/trading/analyst.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/trading/analyst.js")>();
  return {
    ...mod,
    analyze: vi.fn(async (...args: Parameters<typeof mod.analyze>) => {
      const result = await mod.analyze(...args);
      if (!override.action) return result;
      const price = result.signal.price;
      return {
        ...result,
        signal: {
          ...result.signal,
          action: override.action,
          confidence: override.confidence ?? 0.8,
          suggestedQty: 100_000,
          stopLoss: override.stopPct ? Math.round(price * (1 - override.stopPct) * 100) / 100 : null,
          takeProfit: override.targetPct ? Math.round(price * (1 + override.targetPct) * 100) / 100 : null,
        },
      };
    }),
  };
});

async function setup(settings: Record<string, unknown> = {}) {
  const { app, ctx } = makeApp();
  const { agent, user } = await signup(app, "pilot");
  const T = api(agent);
  const res = await T.put("/api/trading/autopilot", {
    enabled: true,
    acknowledge: true,
    provider: "rules",
    symbols: ["AAPL", "MSFT"],
    maxPositionPct: 5,
    maxExposurePct: 50,
    maxTradesPerDay: 5,
    minConfidence: 0.6,
    ...settings,
  });
  expect(res.status).toBe(200);
  return { T, ctx, user };
}

beforeEach(() => {
  for (const k of Object.keys(override)) delete override[k as keyof typeof override];
});

describe("AI autopilot", () => {
  it("stays off until the user accepts how it works, and clamps limits to the server caps", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "careful");
    const T = api(agent);
    const noAck = await T.put("/api/trading/autopilot", { enabled: true });
    expect(noAck.status).toBe(422);
    expect(noAck.body.error.code).toBe("acknowledgement_required");

    const res = await T.put("/api/trading/autopilot", { enabled: true, acknowledge: true, maxPositionPct: 50, minConfidence: 0.1, intervalMin: 1 });
    expect(res.body.settings.enabled).toBe(true);
    expect(res.body.settings.maxPositionPct).toBe(10); // AI_MAX_POSITION_PCT default 10%
    expect(res.body.settings.minConfidence).toBe(0.5);
    expect(res.body.settings.intervalMin).toBe(5);

    const live = await T.put("/api/trading/autopilot", { allowLive: true });
    expect(live.status).toBe(403);
  });

  it("buys within the per-position cap, sets exits, and logs every decision", async () => {
    const { T } = await setup();
    override.action = "buy";
    override.stopPct = 0.08;
    override.targetPct = 0.15;

    const run1 = await T.post("/api/trading/autopilot/run");
    expect(run1.status).toBe(200);
    expect(run1.body.result.buys).toBe(2);

    const { account } = (await T.get("/api/trading/account")).body;
    for (const p of account.positions) {
      expect(p.marketValue).toBeLessThanOrEqual(account.equity * 0.05 + 0.01);
    }
    const orders = (await T.get("/api/trading/orders")).body.orders;
    expect(orders.every((o: { placedBy: string; source: string }) => o.placedBy === "autopilot" && o.source === "ai")).toBe(true);

    const kinds = run1.body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("buy");
    expect(kinds).toContain("run");

    // A second pass finds no room left under the 5% cap, so it holds instead of piling in.
    const run2 = await T.post("/api/trading/autopilot/run");
    expect(run2.body.result.buys).toBe(0);
    expect((await T.get("/api/trading/account")).body.account.positions).toHaveLength(2);
  });

  it("respects the daily trade limit and the confidence threshold", async () => {
    const { T } = await setup({ maxTradesPerDay: 1, symbols: ["AAPL", "MSFT", "NVDA"] });
    override.action = "buy";
    const r = await T.post("/api/trading/autopilot/run");
    expect(r.body.result.buys).toBe(1);
    expect(r.body.events.some((e: { kind: string; message: string }) => e.kind === "skip" && /Daily trade limit/.test(e.message))).toBe(true);

    const { T: T2 } = await setup({ minConfidence: 0.7 });
    override.confidence = 0.65;
    const low = await T2.post("/api/trading/autopilot/run");
    expect(low.body.result.buys).toBe(0);
    expect(low.body.result.holds).toBe(2);
  });

  it("only proposes trades in approve mode, and the user can approve one", async () => {
    const { T } = await setup({ mode: "approve" });
    override.action = "buy";
    const r = await T.post("/api/trading/autopilot/run");
    expect(r.body.result.buys).toBe(0);
    expect(r.body.result.approvals).toBe(2);
    expect((await T.get("/api/trading/orders")).body.orders).toHaveLength(0);

    const proposal = r.body.events.find((e: { kind: string }) => e.kind === "approval");
    const approve = await T.post(`/api/trading/signals/${proposal.signalId}/execute`, { confirm: true, qty: proposal.detail.qty });
    expect(approve.status).toBe(201);
    expect(approve.body.order.status).toBe("filled");
    const after = (await T.get("/api/trading/autopilot")).body.events.find((e: { id: number }) => e.id === proposal.id);
    expect(after.executed).toBe(true);
  });

  it("sells on a confident AI sell signal and exits on stop-loss", async () => {
    const { T, ctx, user } = await setup();
    override.action = "buy";
    override.stopPct = 0.05;
    await T.post("/api/trading/autopilot/run");

    // Move AAPL's stop above the current price: the next pass must exit it, whatever the AI says.
    dbRun(ctx.db, "UPDATE autopilot_guards SET stop_loss = 1000000 WHERE user_id = ? AND symbol = 'AAPL'", user.id);
    override.action = "hold";
    const exitRun = await T.post("/api/trading/autopilot/run");
    expect(exitRun.body.result.exits).toBe(1);
    let positions = (await T.get("/api/trading/account")).body.account.positions.map((p: { symbol: string }) => p.symbol);
    expect(positions).toEqual(["MSFT"]);

    override.action = "sell";
    const sellRun = await T.post("/api/trading/autopilot/run");
    expect(sellRun.body.result.sells).toBe(1);
    positions = (await T.get("/api/trading/account")).body.account.positions;
    expect(positions).toHaveLength(0);
  });

  it("pauses itself at the daily loss limit until the user resumes", async () => {
    const { T, ctx, user } = await setup({ maxDailyLossPct: 2 });
    const today = new Date().toISOString().slice(0, 10);
    // Pretend the day started with far more equity than the account has now (a >2% drawdown).
    dbRun(ctx.db, "UPDATE autopilot_settings SET day_date = ?, day_start_equity = 200000 WHERE user_id = ?", today, user.id);
    override.action = "buy";
    const r = await T.post("/api/trading/autopilot/run");
    expect(r.body.result.skipped).toBe("daily_loss_limit");
    expect(r.body.settings.pausedReason).toBe("daily_loss_limit");
    expect((await T.get("/api/trading/orders")).body.orders).toHaveLength(0);

    const blocked = await T.post("/api/trading/autopilot/run");
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("autopilot_paused");

    dbRun(ctx.db, "UPDATE autopilot_settings SET day_start_equity = NULL WHERE user_id = ?", user.id);
    const resumed = await T.post("/api/trading/autopilot/resume");
    expect(resumed.body.settings.pausedReason).toBeNull();
    expect((await T.post("/api/trading/autopilot/run")).body.result.buys).toBe(2);
  });

  it("can be paused and switched off by the user", async () => {
    const { T } = await setup();
    expect((await T.post("/api/trading/autopilot/pause")).body.settings.pausedReason).toBe("user");
    const off = await T.put("/api/trading/autopilot", { enabled: false });
    expect(off.body.settings.enabled).toBe(false);
    expect((await T.post("/api/trading/autopilot/run")).body.error.code).toBe("autopilot_off");
  });
});
