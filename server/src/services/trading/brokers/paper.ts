import type { Ctx } from "../../../context.js";
import { all, nowIso, one, run, tx } from "../../../db/index.js";
import { notFound, unprocessable } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import type { MarketData } from "../market.js";
import type { AccountView, Broker, OrderInput, OrderView, PositionView } from "./types.js";

interface TradingAccountRow {
  user_id: string;
  broker: "paper" | "alpaca";
  cash_cents: number;
  starting_cents: number;
}

interface PositionRow {
  symbol: string;
  qty: number;
  avg_cost: number;
}

export interface OrderRow {
  id: string;
  user_id: string;
  broker: string;
  broker_order_id: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limit_price: number | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
  source: "manual" | "ai";
  signal_id: string | null;
  reject_reason: string | null;
  created_at: string;
}

export const orderView = (o: OrderRow): OrderView => ({
  id: o.id,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  qty: o.qty,
  limitPrice: o.limit_price,
  status: o.status,
  filledQty: o.filled_qty,
  filledAvgPrice: o.filled_avg_price,
  source: o.source,
  rejectReason: o.reject_reason,
  createdAt: o.created_at,
});

const EPS = 1e-9;
const toCents = (dollars: number) => Math.round(dollars * 100);

export function ensureTradingAccount(ctx: Ctx, userId: string): TradingAccountRow {
  const existing = one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId);
  if (existing) return existing;
  const cents = toCents(ctx.config.PAPER_STARTING_CASH);
  tx(ctx.db, () => {
    run(
      ctx.db,
      "INSERT INTO trading_accounts (user_id, broker, cash_cents, starting_cents, created_at) VALUES (?, 'paper', ?, ?, ?)",
      userId,
      cents,
      cents,
      nowIso(),
    );
    for (const s of ["SPY", "AAPL", "MSFT", "NVDA"]) {
      run(ctx.db, "INSERT OR IGNORE INTO watchlist (user_id, symbol, created_at) VALUES (?, ?, ?)", userId, s, nowIso());
    }
  });
  return one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId)!;
}

/**
 * Built-in paper broker: virtual cash, instant fills at the current quote for market orders,
 * limit orders that fill when the price crosses. Long-only (no shorting, no margin).
 */
export function paperBroker(ctx: Ctx, userId: string, market: MarketData): Broker {
  ensureTradingAccount(ctx, userId);

  /** Applies a fill atomically. Throws if cash or shares are insufficient. */
  function fill(orderId: string, price: number) {
    tx(ctx.db, () => {
      const order = one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ?", orderId)!;
      if (order.status !== "new") return;
      const acct = one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId)!;
      const pos = one<PositionRow>(ctx.db, "SELECT * FROM positions WHERE user_id = ? AND symbol = ?", userId, order.symbol);
      const notional = toCents(order.qty * price);

      if (order.side === "buy") {
        if (notional > acct.cash_cents) throw unprocessable("insufficient_buying_power", "Not enough paper cash for this order");
        const newQty = (pos?.qty ?? 0) + order.qty;
        const newAvg = ((pos?.qty ?? 0) * (pos?.avg_cost ?? 0) + order.qty * price) / newQty;
        run(
          ctx.db,
          `INSERT INTO positions (user_id, symbol, qty, avg_cost, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, symbol) DO UPDATE SET qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at`,
          userId,
          order.symbol,
          newQty,
          newAvg,
          nowIso(),
        );
        run(ctx.db, "UPDATE trading_accounts SET cash_cents = cash_cents - ? WHERE user_id = ?", notional, userId);
      } else {
        if (!pos || pos.qty + EPS < order.qty) {
          throw unprocessable("insufficient_shares", `You only hold ${pos?.qty ?? 0} ${order.symbol}`);
        }
        const remaining = pos.qty - order.qty;
        if (remaining <= EPS) run(ctx.db, "DELETE FROM positions WHERE user_id = ? AND symbol = ?", userId, order.symbol);
        else run(ctx.db, "UPDATE positions SET qty = ?, updated_at = ? WHERE user_id = ? AND symbol = ?", remaining, nowIso(), userId, order.symbol);
        run(ctx.db, "UPDATE trading_accounts SET cash_cents = cash_cents + ? WHERE user_id = ?", notional, userId);
      }
      run(
        ctx.db,
        "UPDATE orders SET status = 'filled', filled_qty = qty, filled_avg_price = ?, updated_at = ? WHERE id = ?",
        price,
        nowIso(),
        orderId,
      );
    });
  }

  function reject(orderId: string, reason: string) {
    run(ctx.db, "UPDATE orders SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), orderId);
  }

  /** Checks resting limit orders against current prices. */
  async function processOpenOrders() {
    const open = all<OrderRow>(ctx.db, "SELECT * FROM orders WHERE user_id = ? AND broker = 'paper' AND status = 'new'", userId);
    for (const o of open) {
      let price: number;
      try {
        price = (await market.quote(o.symbol)).price;
      } catch {
        continue;
      }
      const crosses = o.side === "buy" ? price <= o.limit_price! : price >= o.limit_price!;
      if (!crosses) continue;
      try {
        fill(o.id, o.side === "buy" ? Math.min(price, o.limit_price!) : Math.max(price, o.limit_price!));
      } catch (err) {
        reject(o.id, (err as Error).message);
      }
    }
  }

  return {
    id: "paper",

    async account(): Promise<AccountView> {
      await processOpenOrders();
      const acct = one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId)!;
      const rows = all<PositionRow>(ctx.db, "SELECT symbol, qty, avg_cost FROM positions WHERE user_id = ? ORDER BY symbol", userId);
      const positions: PositionView[] = [];
      for (const p of rows) {
        let price = p.avg_cost;
        try {
          price = (await market.quote(p.symbol)).price;
        } catch {
          /* keep cost basis if the quote is unavailable */
        }
        const marketValue = p.qty * price;
        const costBasis = p.qty * p.avg_cost;
        positions.push({
          symbol: p.symbol,
          qty: p.qty,
          avgCost: Math.round(p.avg_cost * 10000) / 10000,
          price,
          marketValue: Math.round(marketValue * 100) / 100,
          costBasis: Math.round(costBasis * 100) / 100,
          unrealizedPl: Math.round((marketValue - costBasis) * 100) / 100,
          unrealizedPlPct: costBasis ? Math.round(((marketValue - costBasis) / costBasis) * 10000) / 100 : 0,
        });
      }
      const cash = acct.cash_cents / 100;
      const equity = Math.round((cash + positions.reduce((s, p) => s + p.marketValue, 0)) * 100) / 100;
      const starting = acct.starting_cents / 100;
      return {
        broker: "paper",
        live: false,
        currency: "USD",
        cash,
        equity,
        buyingPower: cash,
        startingCash: starting,
        totalReturnPct: Math.round(((equity - starting) / starting) * 10000) / 100,
        positions,
      };
    },

    async placeOrder(input: OrderInput): Promise<OrderView> {
      const quote = await market.quote(input.symbol);
      const id = newId("ord");
      const now = nowIso();
      run(
        ctx.db,
        `INSERT INTO orders (id, user_id, broker, symbol, side, type, qty, limit_price, status, source, signal_id, created_at, updated_at)
         VALUES (?, ?, 'paper', ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
        id,
        userId,
        input.symbol,
        input.side,
        input.type,
        input.qty,
        input.limitPrice ?? null,
        input.source,
        input.signalId ?? null,
        now,
        now,
      );
      const marketable =
        input.type === "market" ||
        (input.side === "buy" ? quote.price <= input.limitPrice! : quote.price >= input.limitPrice!);
      if (marketable) {
        const price =
          input.type === "market"
            ? quote.price
            : input.side === "buy"
              ? Math.min(quote.price, input.limitPrice!)
              : Math.max(quote.price, input.limitPrice!);
        try {
          fill(id, price);
        } catch (err) {
          reject(id, (err as Error).message);
          throw err;
        }
      } else if (input.side === "buy" && toCents(input.qty * input.limitPrice!) > ensureTradingAccount(ctx, userId).cash_cents) {
        reject(id, "Not enough paper cash for this order");
        throw unprocessable("insufficient_buying_power", "Not enough paper cash for this order");
      }
      return orderView(one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ?", id)!);
    },

    async listOrders() {
      await processOpenOrders();
      return all<OrderRow>(ctx.db, "SELECT * FROM orders WHERE user_id = ? AND broker = 'paper' ORDER BY created_at DESC LIMIT 100", userId).map(orderView);
    },

    async cancelOrder(id: string) {
      const o = one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ? AND user_id = ?", id, userId);
      if (!o) throw notFound("Order not found");
      if (o.status !== "new") throw unprocessable("order_closed", `Order is already ${o.status}`);
      run(ctx.db, "UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?", nowIso(), id);
      return orderView({ ...o, status: "canceled" });
    },
  };
}

export function resetPaperAccount(ctx: Ctx, userId: string) {
  const cents = toCents(ctx.config.PAPER_STARTING_CASH);
  tx(ctx.db, () => {
    ensureTradingAccount(ctx, userId);
    run(ctx.db, "DELETE FROM positions WHERE user_id = ?", userId);
    run(ctx.db, "UPDATE orders SET status = 'canceled', updated_at = ? WHERE user_id = ? AND broker = 'paper' AND status = 'new'", nowIso(), userId);
    run(ctx.db, "UPDATE trading_accounts SET cash_cents = ?, starting_cents = ? WHERE user_id = ?", cents, cents, userId);
  });
}
