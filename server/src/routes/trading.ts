import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { HttpError, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
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
import { marketFor, normalizeSymbol, searchSymbols } from "../services/trading/market.js";
import { audit } from "../services/users.js";

const OrderBody = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  qty: z.coerce.number().positive(),
  limitPrice: z.coerce.number().positive().optional(),
  signalId: z.string().max(64).optional(),
  confirm: z.boolean().optional(),
});

const AnalyzeBody = z.object({
  symbol: z.string().min(1).max(12),
  provider: z.string().max(30).optional(),
  model: z.string().max(200).optional(),
});

const AutopilotBody = z.object({
  enabled: z.boolean().optional(),
  acknowledge: z.boolean().optional(),
  mode: z.enum(["auto", "approve"]).optional(),
  provider: z.string().max(30).optional(),
  model: z.string().max(200).nullable().optional(),
  symbols: z.array(z.string().min(1).max(12)).max(20).optional(),
  intervalMin: z.coerce.number().int().optional(),
  maxPositionPct: z.coerce.number().optional(),
  maxExposurePct: z.coerce.number().optional(),
  maxTradesPerDay: z.coerce.number().int().optional(),
  maxDailyLossPct: z.coerce.number().optional(),
  minConfidence: z.coerce.number().optional(),
  useExits: z.boolean().optional(),
  allowLive: z.boolean().optional(),
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
    res.json({ settings, account: await broker.account() });
  });

  r.post("/account/reset", (req, res) => {
    resetPaperAccount(ctx, req.user!.id);
    audit(ctx, req.user!.id, "trading.paper_reset", {}, req.ip);
    res.json({ ok: true });
  });

  r.put("/broker", (req, res) => {
    const { broker } = parse(z.object({ broker: z.enum(["paper", "alpaca"]) }), req.body);
    setBroker(ctx, req.user!.id, broker);
    audit(ctx, req.user!.id, "trading.broker_changed", { broker }, req.ip);
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  /** Saves the user's own Alpaca keys after checking them against Alpaca (paper first, then live). */
  r.put("/alpaca-keys", async (req, res) => {
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
    saveUserKey(ctx, req.user!.id, "alpaca", JSON.stringify(creds), { env });
    audit(ctx, req.user!.id, "trading.alpaca_connected", { env }, req.ip);
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  r.delete("/alpaca-keys", (req, res) => {
    deleteUserKey(ctx, req.user!.id, "alpaca");
    setBroker(ctx, req.user!.id, "paper");
    res.json({ settings: tradingSettings(ctx, req.user!.id) });
  });

  r.get("/symbols", (req, res) => {
    res.json({ symbols: searchSymbols(String(req.query.q ?? "")), source: marketFor(ctx, req.user!.id).source });
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
    const { symbol } = parse(z.object({ symbol: z.string().min(1).max(12) }), req.body);
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
