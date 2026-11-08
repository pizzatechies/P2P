import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { badRequest, HttpError, unprocessable } from "../../lib/errors.js";
import { alpacaBroker } from "./brokers/alpaca.js";
import { ensureTradingAccount, paperBroker } from "./brokers/paper.js";
import type { Broker, OrderInput } from "./brokers/types.js";
import { alpacaCredentials, marketFor, normalizeSymbol, type MarketData } from "./market.js";

export function tradingSettings(ctx: Ctx, userId: string) {
  const acct = ensureTradingAccount(ctx, userId);
  const creds = alpacaCredentials(ctx, userId);
  return {
    broker: acct.broker,
    alpacaConnected: !!creds,
    alpacaEnv: creds?.env ?? null,
    liveTradingAllowed: ctx.config.ALLOW_LIVE_TRADING,
    dataSource: marketFor(ctx, userId).source,
  };
}

export function brokerFor(ctx: Ctx, userId: string): { broker: Broker; market: MarketData } {
  const acct = ensureTradingAccount(ctx, userId);
  const market = marketFor(ctx, userId);
  if (acct.broker === "alpaca") {
    const creds = alpacaCredentials(ctx, userId);
    if (!creds) {
      // Keys were removed: fall back to paper rather than failing every request.
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
}

/**
 * Validates and routes an order. AI-originated orders carry extra guardrails: they must be
 * explicitly confirmed by the user and are capped at AI_MAX_POSITION_PCT of portfolio equity.
 */
export async function placeOrder(ctx: Ctx, userId: string, req: PlaceOrderRequest) {
  const symbol = normalizeSymbol(req.symbol);
  if (!(req.qty > 0) || req.qty > 1_000_000) throw badRequest("Quantity must be between 0 and 1,000,000");
  if (Math.round(req.qty * 10000) !== req.qty * 10000) throw badRequest("Quantity supports up to 4 decimal places");
  if (req.type === "limit" && !(req.limitPrice && req.limitPrice > 0)) throw badRequest("Limit orders need a limit price");

  const { broker, market } = brokerFor(ctx, userId);
  const quote = await market.quote(symbol);
  const source: OrderInput["source"] = req.signalId ? "ai" : "manual";

  if (source === "ai") {
    const signal = one<{ id: string; symbol: string; executed_order_id: string | null }>(
      ctx.db,
      "SELECT id, symbol, executed_order_id FROM ai_signals WHERE id = ? AND user_id = ?",
      req.signalId!,
      userId,
    );
    if (!signal) throw badRequest("Unknown AI signal");
    if (signal.symbol !== symbol) throw badRequest("Order symbol doesn't match the AI signal");
    if (signal.executed_order_id) throw unprocessable("signal_used", "This AI signal has already been executed");
    if (!req.confirm) throw unprocessable("confirmation_required", "Confirm that you want to place this AI-suggested order");
    if (req.side === "buy") {
      const account = await broker.account();
      const cap = account.equity * ctx.config.AI_MAX_POSITION_PCT;
      if (req.qty * (req.limitPrice ?? quote.price) > cap + 0.01) {
        throw unprocessable(
          "ai_position_cap",
          `AI-suggested orders are capped at ${Math.round(ctx.config.AI_MAX_POSITION_PCT * 100)}% of your portfolio ($${cap.toFixed(2)})`,
        );
      }
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
