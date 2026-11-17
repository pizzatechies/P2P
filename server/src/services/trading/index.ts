import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { badRequest, HttpError, unprocessable } from "../../lib/errors.js";
import { alpacaBroker, futuresDemoOnly } from "./brokers/alpaca.js";
import { ensureTradingAccount, paperBroker } from "./brokers/paper.js";
import type { Broker, OrderInput } from "./brokers/types.js";
import { assetClassOf, FUTURES_BY_SYMBOL, futureMargin, QTY_RULES } from "./instruments.js";
import { alpacaCredentials, marketFor, normalizeSymbol, type MarketData } from "./market.js";
import { assertLiveApproved, liveApproved } from "../upgrade.js";
import { snapshotPortfolio } from "./records.js";

export function tradingSettings(ctx: Ctx, userId: string) {
  const acct = ensureTradingAccount(ctx, userId);
  const creds = alpacaCredentials(ctx, userId);
  const live = acct.broker === "alpaca" && creds?.env === "live";
  return {
    /** "demo" covers both the built-in paper account and Alpaca paper accounts. */
    accountType: live ? ("real" as const) : ("demo" as const),
    realAccountApproved: liveApproved(ctx, userId),
    demoStartingCash: acct.starting_cents / 100,
    broker: acct.broker,
    alpacaConnected: !!creds,
    alpacaEnv: creds?.env ?? null,
    liveTradingAllowed: ctx.config.ALLOW_LIVE_TRADING,
    dataSource: marketFor(ctx, userId).source,
    /** Where each market's prices come from, and whether futures can be traded on the current account. */
    markets: {
      stock: marketFor(ctx, userId).source,
      crypto: ctx.config.cryptoData === "coinbase" ? ("coinbase" as const) : ("simulated" as const),
      future: "simulated" as const,
      futuresTradable: acct.broker === "paper",
    },
  };
}

export function brokerFor(ctx: Ctx, userId: string): { broker: Broker; market: MarketData } {
  const acct = ensureTradingAccount(ctx, userId);
  const market = marketFor(ctx, userId);
  if (acct.broker === "alpaca") {
    const creds = alpacaCredentials(ctx, userId);
    if (!creds || (creds.env === "live" && (!ctx.config.ALLOW_LIVE_TRADING || !liveApproved(ctx, userId)))) {
      // Keys removed, live trading switched off, or real-account approval revoked: back to the demo account.
      run(ctx.db, "UPDATE trading_accounts SET broker = 'paper' WHERE user_id = ?", userId);
    } else {
      return { broker: alpacaBroker(ctx, userId, creds), market };
    }
  }
  return { broker: paperBroker(ctx, userId, market), market };
}

export function setBroker(ctx: Ctx, userId: string, broker: "paper" | "alpaca") {
  ensureTradingAccount(ctx, userId);
  if (broker === "alpaca") {
    const creds = alpacaCredentials(ctx, userId);
    if (!creds) throw badRequest("Connect your Alpaca API keys first");
    if (creds.env === "live" && !ctx.config.ALLOW_LIVE_TRADING) {
      throw new HttpError(403, "live_trading_disabled", "Live trading is disabled on this server");
    }
    if (creds.env === "live") assertLiveApproved(ctx, userId);
  }
  run(ctx.db, "UPDATE trading_accounts SET broker = ? WHERE user_id = ?", broker, userId);
}

export interface PlaceOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice?: number;
  signalId?: string;
  confirm?: boolean;
  /** "autopilot" when the AI places the order itself under the user's autopilot limits. */
  placedBy?: "user" | "autopilot";
}

/**
 * Validates and routes an order. AI-originated orders carry extra guardrails: they must be
 * explicitly confirmed by the user and are capped at AI_MAX_POSITION_PCT of portfolio equity.
 */
export async function placeOrder(ctx: Ctx, userId: string, req: PlaceOrderRequest) {
  const symbol = normalizeSymbol(req.symbol);
  const assetClass = assetClassOf(symbol);
  const rules = QTY_RULES[assetClass];
  if (!(req.qty > 0) || req.qty > rules.max) throw badRequest(`Quantity must be between 0 and ${rules.max.toLocaleString("en-US")} ${rules.units}`);
  const scale = 10 ** rules.decimals;
  if (Math.abs(Math.round(req.qty * scale) - req.qty * scale) > 1e-6) {
    throw badRequest(rules.decimals === 0 ? "Futures trade in whole contracts" : `Quantity supports up to ${rules.decimals} decimal places`);
  }
  if (req.type === "limit" && !(req.limitPrice && req.limitPrice > 0)) throw badRequest("Limit orders need a limit price");

  const { broker, market } = brokerFor(ctx, userId);
  if (assetClass === "future" && broker.id !== "paper") throw futuresDemoOnly();
  const quote = await market.quote(symbol);
  if (assetClass === "crypto" && req.qty * (req.limitPrice ?? quote.price) < 1) {
    throw badRequest("Crypto orders need to be worth at least $1");
  }
  const placedBy = req.placedBy ?? "user";
  const source: OrderInput["source"] = req.signalId || placedBy === "autopilot" ? "ai" : "manual";

  if (req.signalId) {
    const signal = one<{ id: string; symbol: string; executed_order_id: string | null }>(
      ctx.db,
      "SELECT id, symbol, executed_order_id FROM ai_signals WHERE id = ? AND user_id = ?",
      req.signalId!,
      userId,
    );
    if (!signal) throw badRequest("Unknown AI signal");
    if (signal.symbol !== symbol) throw badRequest("Order symbol doesn't match the AI signal");
    if (signal.executed_order_id) throw unprocessable("signal_used", "This AI signal has already been executed");
    // The autopilot's standing permission (switched on and acknowledged by the user) is its confirmation.
    if (!req.confirm && placedBy !== "autopilot") {
      throw unprocessable("confirmation_required", "Confirm that you want to place this AI-suggested order");
    }
  }
  if (source === "ai") {
    const account = await broker.account();
    const cap = account.equity * ctx.config.AI_MAX_POSITION_PCT;
    const capMsg = `AI-suggested orders are capped at ${Math.round(ctx.config.AI_MAX_POSITION_PCT * 100)}% of your portfolio ($${cap.toFixed(2)})`;
    if (assetClass === "future") {
      // Futures: the cap applies to the margin a new or bigger position ties up.
      const held = account.positions.find((p) => p.symbol === symbol)?.qty ?? 0;
      const next = held + (req.side === "buy" ? req.qty : -req.qty);
      if (Math.abs(next) > Math.abs(held)) {
        const margin = (Math.abs(next) - Math.abs(held)) * futureMargin(FUTURES_BY_SYMBOL.get(symbol)!, quote.price).initial;
        if (margin > cap + 0.01) throw unprocessable("ai_position_cap", `${capMsg}; this order needs $${margin.toFixed(2)} of margin`);
      }
    } else if (req.side === "buy" && req.qty * (req.limitPrice ?? quote.price) > cap + 0.01) {
      throw unprocessable("ai_position_cap", capMsg);
    }
  }

  const order = await broker.placeOrder({
    symbol,
    side: req.side,
    type: req.type,
    qty: req.qty,
    limitPrice: req.limitPrice,
    source,
    signalId: req.signalId,
    placedBy,
  });
  if (req.signalId) {
    run(ctx.db, "UPDATE ai_signals SET executed_order_id = ? WHERE id = ? AND user_id = ?", order.id, req.signalId, userId);
  }
  return { order, quote };
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
export async function getWatchlist(ctx: Ctx, userId: string) {
  ensureTradingAccount(ctx, userId);
  const market = marketFor(ctx, userId);
  const symbols = all<{ symbol: string }>(ctx.db, "SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY created_at", userId);
  const items = await Promise.all(
    symbols.map(async ({ symbol }) => {
      try {
        return { symbol, quote: await market.quote(symbol), error: null };
      } catch (err) {
        return { symbol, quote: null, error: (err as Error).message };
      }
    }),
  );
  return { source: market.source, items };
}

export async function addToWatchlist(ctx: Ctx, userId: string, raw: string) {
  const symbol = normalizeSymbol(raw);
  await marketFor(ctx, userId).quote(symbol); // validates the symbol exists
  const count = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", userId)!.n;
  if (count >= 50) throw unprocessable("watchlist_full", "Your watchlist is full (50 symbols)");
  run(ctx.db, "INSERT OR IGNORE INTO watchlist (user_id, symbol, created_at) VALUES (?, ?, ?)", userId, symbol, nowIso());
}

export function removeFromWatchlist(ctx: Ctx, userId: string, raw: string) {
  run(ctx.db, "DELETE FROM watchlist WHERE user_id = ? AND symbol = ?", userId, normalizeSymbol(raw));
}

// ---------------------------------------------------------------------------
// Daily valuations
// ---------------------------------------------------------------------------
/**
 * Values every active portfolio once a day, so performance charts have a point for each day even
 * when the customer doesn't open the app. Started from index.ts (not in tests).
 */
export function startPortfolioSnapshots(ctx: Ctx, everyMs = 30 * 60_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const due = all<{ user_id: string }>(
        ctx.db,
        `SELECT t.user_id FROM trading_accounts t JOIN users u ON u.id = t.user_id
         WHERE u.status = 'active' AND u.closed_at IS NULL
           AND (EXISTS (SELECT 1 FROM positions p WHERE p.user_id = t.user_id) OR t.broker = 'alpaca'
                OR EXISTS (SELECT 1 FROM trade_fills f WHERE f.user_id = t.user_id AND f.executed_at > ?))
           AND NOT EXISTS (SELECT 1 FROM portfolio_snapshots s WHERE s.user_id = t.user_id AND s.broker = t.broker AND s.day = ?)
         LIMIT 50`,
        new Date(Date.now() - 90 * 86_400_000).toISOString(),
        day,
      );
      for (const { user_id } of due) {
        try {
          const { broker } = brokerFor(ctx, user_id);
          snapshotPortfolio(ctx, user_id, await broker.account());
        } catch (err) {
          console.warn(`[snapshots] ${user_id}: ${(err as Error).message}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  first.unref();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
