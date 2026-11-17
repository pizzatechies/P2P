import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { HttpError, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth, requireRecentAuth } from "../middleware/auth.js";
import { assertRecentAuth } from "../services/security.js";
import { assertLiveApproved, saveApplication, submitApplication, upgradeOverview } from "../services/upgrade.js";
import { deleteUserKey, saveUserKey } from "../services/keys.js";
import { analyze, getSignal, listSignals } from "../services/trading/analyst.js";
import {
  autopilotStatus,
  pauseAutopilot,
  resumeAutopilot,
  runAutopilot,
  updateAutopilotSettings,
} from "../services/trading/autopilot.js";
import { ALPACA_LIVE, ALPACA_PAPER, alpacaRequest } from "../services/trading/brokers/alpaca.js";
import { resetPaperAccount } from "../services/trading/brokers/paper.js";
import {
  addToWatchlist,
  brokerFor,
  getWatchlist,
  placeOrder,
  removeFromWatchlist,
  setBroker,
  tradingSettings,
} from "../services/trading/index.js";
import { marketFor, normalizeSymbol, searchInstruments } from "../services/trading/market.js";
import {
  cashJournal,
  performance,
  realizedCsv,
  realizedReport,
  snapshotPortfolio,
  tradeHistory,
  tradesCsv,
  tradingYears,
} from "../services/trading/records.js";
import { audit } from "../services/users.js";

const OrderBody = z.object({
  symbol: z.string().min(1).max(16),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  qty: z.coerce.number().positive(),
  limitPrice: z.coerce.number().positive().optional(),
  signalId: z.string().max(64).optional(),
  confirm: z.boolean().optional(),
});

const AnalyzeBody = z.object({
  symbol: z.string().min(1).max(16),
  provider: z.string().max(30).optional(),
  model: z.string().max(200).optional(),
});

const band = z.enum(["under_10k", "10k_50k", "50k_100k", "100k_250k", "over_250k"]);
const ApplicationBody = z.object({
  legalName: z.string().trim().min(2).max(100).regex(/^[\p{L}\p{M}' .-]+$/u, "Use your name as on your ID"),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(d)), "Check your date of birth"),
  country: z.string().trim().length(2).transform((c) => c.toUpperCase()),
  employment: z.enum(["employed", "self_employed", "student", "retired", "unemployed"]),
  annualIncome: band,
  liquidNetWorth: band,
  sourceOfFunds: z.enum(["salary", "savings", "business", "investments", "inheritance", "other"]),
  experience: z.enum(["none", "under_1y", "1_3y", "over_3y"]),
  objective: z.enum(["growth", "income", "speculation", "preservation"]),
  riskTolerance: z.enum(["low", "medium", "high"]),
  timeHorizon: z.enum(["under_1y", "1_5y", "over_5y"]),
});
const AcknowledgeBody = z.object({
  riskOfLoss: z.boolean(),
  notAdvice: z.boolean(),
  ownAccount: z.boolean(),
  accurate: z.boolean(),
  understandsWarnings: z.boolean().optional(),
});

const AutopilotBody = z.object({
  enabled: z.boolean().optional(),
  acknowledge: z.boolean().optional(),
  mode: z.enum(["auto", "approve"]).optional(),
  provider: z.string().max(30).optional(),
  model: z.string().max(200).nullable().optional(),
  symbols: z.array(z.string().min(1).max(16)).max(20).optional(),
  intervalMin: z.coerce.number().int().optional(),
  maxPositionPct: z.coerce.number().optional(),
  maxExposurePct: z.coerce.number().optional(),
  maxTradesPerDay: z.coerce.number().int().optional(),
  maxDailyLossPct: z.coerce.number().optional(),
  minConfidence: z.coerce.number().optional(),
  useExits: z.boolean().optional(),
  allowLive: z.boolean().optional(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use dates like 2026-11-01");
const HistoryQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  symbol: z.string().trim().max(16).optional(),
  assetClass: z.enum(["stock", "crypto", "future"]).optional(),
  accountType: z.enum(["demo", "real"]).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  format: z.enum(["json", "csv"]).optional(),
});
const RealizedQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  accountType: z.enum(["demo", "real"]).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

const AlpacaKeysBody = z.object({
  keyId: z.string().trim().min(10).max(100),
  secretKey: z.string().trim().min(10).max(200),
});

export function tradingRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const orderLimiter = rateLimit({ name: "orders", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 30, key: (req) => req.user!.id });
  const aiLimiter = rateLimit({ name: "analyst", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 12, key: (req) => req.user!.id });

  r.get("/account", async (req, res) => {
    const settings = tradingSettings(ctx, req.user!.id);
    const { broker } = brokerFor(ctx, req.user!.id);
    const account = await broker.account();
    try {
      snapshotPortfolio(ctx, req.user!.id, account);
    } catch (err) {
      console.warn("[trading] snapshot failed:", (err as Error).message);
    }
    res.json({ settings, account });
  });

  // ---- Trading records: executions, realised profit and loss, performance, demo cash journal ----
  const recordsLimiter = rateLimit({ name: "trading-records", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 60, key: (req) => req.user!.id });

  r.get("/records/trades", recordsLimiter, (req, res) => {
    const q = parse(HistoryQuery, req.query);
    const filters = { ...q, symbol: q.symbol ? normalizeSymbol(q.symbol) : undefined };
    if (q.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aurex-trades${q.from ? `-${q.from}` : ""}${q.to ? `-to-${q.to}` : ""}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(tradesCsv(ctx, req.user!.id, filters));
      return;
    }
    res.json(tradeHistory(ctx, req.user!.id, filters));
  });

  r.get("/records/realized", recordsLimiter, (req, res) => {
    const q = parse(RealizedQuery, req.query);
    const settings = tradingSettings(ctx, req.user!.id);
    const years = tradingYears(ctx, req.user!.id);
    const year = q.year ?? years[0] ?? new Date().getUTCFullYear();
    const report = realizedReport(ctx, req.user!.id, year, q.accountType ?? settings.accountType);
    if (q.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aurex-realised-pl-${year}-${report.accountType}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(realizedCsv(report));
      return;
    }
    res.json({ years, report });
  });

  r.get("/records/performance", recordsLimiter, (req, res) => {
    const settings = tradingSettings(ctx, req.user!.id);
    res.json({ performance: performance(ctx, req.user!.id, settings.broker, settings.accountType) });
  });

  r.get("/records/cash", recordsLimiter, (req, res) => {
    res.json({ entries: cashJournal(ctx, req.user!.id) });
  });

  /** Starts the demo account over, optionally with a different virtual balance ($1,000 to $1,000,000). */
  r.post("/account/reset", (req, res) => {
    const { startingCash } = parse(z.object({ startingCash: z.coerce.number().min(1000).max(1_000_000).optional() }), req.body ?? {});
    resetPaperAccount(ctx, req.user!.id, startingCash);
    audit(ctx, req.user!.id, "trading.paper_reset", { startingCash: startingCash ?? ctx.config.PAPER_STARTING_CASH }, req.ip);
    res.json({ ok: true, settings: tradingSettings(ctx, req.user!.id) });
  });

  // ---- Upgrade from demo to a real account ----
  r.get("/upgrade", (req, res) => {
    res.json(upgradeOverview(ctx, req.user!.id));
  });

  r.put("/upgrade", (req, res) => {
    const data = parse(ApplicationBody, req.body);
    const out = saveApplication(ctx, req.user!.id, data);
    audit(ctx, req.user!.id, "upgrade.saved", {}, req.ip);
    res.json(out);
  });

  r.post("/upgrade/submit", requireRecentAuth(ctx), (req, res) => {
    const ack = parse(AcknowledgeBody, req.body);
    const out = submitApplication(ctx, req.user!.id, ack, req.ip);
    audit(ctx, req.user!.id, "upgrade.submitted", { status: out.status }, req.ip);
    res.json(out);
  });

  r.put("/broker", (req, res) => {
    const { broker } = parse(z.object({ broker: z.enum(["paper", "alpaca"]) }), req.body);
    if (broker === "alpaca") assertRecentAuth(ctx, req.reauthAt); // trading with a real brokerage account
    setBroker(ctx, req.user!.id, broker);
    audit(ctx, req.user!.id, "trading.broker_changed", { broker }, req.ip);
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  /** Saves the user's own Alpaca keys after checking them against Alpaca (paper first, then live). */
  r.put("/alpaca-keys", requireRecentAuth(ctx), async (req, res) => {
    const creds = parse(AlpacaKeysBody, req.body);
    let env: "paper" | "live" | null = null;
    for (const [candidate, base] of [["paper", ALPACA_PAPER], ["live", ALPACA_LIVE]] as const) {
      try {
        await alpacaRequest(base, creds, "/v2/account");
        env = candidate;
        break;
      } catch (err) {
        if ((err as HttpError).code !== "broker_auth") throw err;
      }
    }
    if (!env) throw new HttpError(422, "broker_auth", "Alpaca rejected these keys for both paper and live accounts");
    if (env === "live" && !ctx.config.ALLOW_LIVE_TRADING) {
      throw new HttpError(403, "live_trading_disabled", "These are live-account keys, and live trading is disabled on this server. Use paper keys.");
    }
    if (env === "live") assertLiveApproved(ctx, req.user!.id);
    saveUserKey(ctx, req.user!.id, "alpaca", JSON.stringify(creds), { env });
    audit(ctx, req.user!.id, "trading.alpaca_connected", { env }, req.ip);
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  r.delete("/alpaca-keys", (req, res) => {
    deleteUserKey(ctx, req.user!.id, "alpaca");
    setBroker(ctx, req.user!.id, "paper");
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  /** Search stocks, crypto and futures by ticker or name; `class` narrows it to one market. */
  r.get("/symbols", async (req, res) => {
    const cls = z.enum(["stock", "crypto", "future"]).optional().safeParse(req.query.class || undefined);
    const symbols = await searchInstruments(ctx, String(req.query.q ?? "").slice(0, 40), cls.success ? cls.data : undefined);
    res.json({ symbols, source: marketFor(ctx, req.user!.id).source });
  });

  r.get("/quote/:symbol", async (req, res) => {
    res.json({ quote: await marketFor(ctx, req.user!.id).quote(normalizeSymbol(req.params.symbol)) });
  });

  r.get("/bars/:symbol", async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 120, 5), 520);
    const market = marketFor(ctx, req.user!.id);
    res.json({ bars: await market.bars(normalizeSymbol(req.params.symbol), days), source: market.source });
  });

  r.get("/watchlist", async (req, res) => {
    res.json(await getWatchlist(ctx, req.user!.id));
  });

  r.post("/watchlist", async (req, res) => {
    const { symbol } = parse(z.object({ symbol: z.string().min(1).max(16) }), req.body);
    await addToWatchlist(ctx, req.user!.id, symbol);
    res.status(201).json(await getWatchlist(ctx, req.user!.id));
  });

  r.delete("/watchlist/:symbol", async (req, res) => {
    removeFromWatchlist(ctx, req.user!.id, req.params.symbol);
    res.json(await getWatchlist(ctx, req.user!.id));
  });

  r.get("/orders", async (req, res) => {
    const { broker } = brokerFor(ctx, req.user!.id);
    res.json({ orders: await broker.listOrders() });
  });

  r.post("/orders", orderLimiter, async (req, res) => {
    const body = parse(OrderBody, req.body);
    const result = await placeOrder(ctx, req.user!.id, body);
    audit(ctx, req.user!.id, "trading.order", { orderId: result.order.id, symbol: result.order.symbol, side: body.side, qty: body.qty, source: result.order.source }, req.ip);
    res.status(201).json(result);
  });

  r.post("/orders/:id/cancel", async (req, res) => {
    const { broker } = brokerFor(ctx, req.user!.id);
    res.json({ order: await broker.cancelOrder(req.params.id) });
  });

  r.post("/analyze", aiLimiter, async (req, res) => {
    const body = parse(AnalyzeBody, req.body);
    res.status(201).json(await analyze(ctx, req.user!.id, body));
  });

  r.get("/signals", (req, res) => {
    res.json({ signals: listSignals(ctx, req.user!.id, req.query.symbol ? String(req.query.symbol) : undefined) });
  });

  /** One-click execution of an AI signal (still requires confirm: true from the client). */
  r.post("/signals/:id/execute", orderLimiter, async (req, res) => {
    const body = parse(
      z.object({ qty: z.coerce.number().positive().optional(), confirm: z.boolean().optional() }),
      req.body ?? {},
    );
    const signal = getSignal(ctx, req.user!.id, String(req.params.id));
    if (!signal) throw notFound("Signal not found");
    if (signal.action === "hold") throw new HttpError(422, "nothing_to_execute", "This signal says HOLD, so there's no order to place");
    const result = await placeOrder(ctx, req.user!.id, {
      symbol: signal.symbol,
      side: signal.action,
      type: "market",
      qty: body.qty ?? signal.suggestedQty,
      signalId: signal.id,
      confirm: body.confirm,
    });
    audit(ctx, req.user!.id, "trading.ai_order", { orderId: result.order.id, signalId: signal.id }, req.ip);
    res.status(201).json(result);
  });

  // ---- AI Autopilot ---------------------------------------------------------
  async function autopilotView(userId: string) {
    const status = autopilotStatus(ctx, userId);
    let equity: number | null = null;
    try {
      equity = (await brokerFor(ctx, userId).broker.account()).equity;
    } catch {
      /* broker unreachable: show the rest */
    }
    const start = status.stats.dayStartEquity;
    const dayPnlPct = equity !== null && start ? Math.round(((equity - start) / start) * 10000) / 100 : null;
    return { ...status, stats: { ...status.stats, equity, dayPnlPct } };
  }

  r.get("/autopilot", async (req, res) => {
    res.json(await autopilotView(req.user!.id));
  });

  r.put("/autopilot", async (req, res) => {
    const body = parse(AutopilotBody, req.body);
    // Letting the AI place trades on its own is a sensitive change: confirm it's really the user.
    if (body.enabled === true || body.mode === "auto") assertRecentAuth(ctx, req.reauthAt);
    updateAutopilotSettings(ctx, req.user!.id, body, req.ip);
    res.json(await autopilotView(req.user!.id));
  });

  r.post("/autopilot/run", aiLimiter, async (req, res) => {
    const result = await runAutopilot(ctx, req.user!.id, { manual: true });
    res.json({ result, ...(await autopilotView(req.user!.id)) });
  });

  r.post("/autopilot/pause", async (req, res) => {
    pauseAutopilot(ctx, req.user!.id);
    res.json(await autopilotView(req.user!.id));
  });

  r.post("/autopilot/resume", async (req, res) => {
    resumeAutopilot(ctx, req.user!.id);
    res.json(await autopilotView(req.user!.id));
  });

  return r;
}
