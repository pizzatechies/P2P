import type { Ctx } from "../../../context.js";
import { all, nowIso, one, run, tx } from "../../../db/index.js";
import { notFound, unprocessable } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { assetClassOf, FUTURES_BY_SYMBOL, futureMargin, type FutureSpec } from "../instruments.js";
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
  placed_by: "user" | "autopilot" | "system";
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
  placedBy: o.placed_by ?? "user",
  rejectReason: o.reject_reason,
  createdAt: o.created_at,
});

const EPS = 1e-9;
const toCents = (dollars: number) => Math.round(dollars * 100);
const r2 = (n: number) => Math.round(n * 100) / 100;

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
    for (const s of ["SPY", "AAPL", "MSFT", "NVDA", "BTC-USD", "ES=F"]) {
      run(ctx.db, "INSERT OR IGNORE INTO watchlist (user_id, symbol, created_at) VALUES (?, ?, ?)", userId, s, nowIso());
    }
  });
  return one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId)!;
}

/** Open futures exposure at current prices: open profit/loss and the margin it ties up. */
interface FuturesBook {
  unrealizedCents: number;
  marginCents: number;
  maintenanceCents: number;
  positions: { row: PositionRow; spec: FutureSpec; price: number }[];
}

/**
 * Built-in demo broker: virtual cash, instant fills at the current quote for market orders, limit
 * orders that fill when the price crosses.
 * - Stocks and crypto: long only, paid in full (no borrowing). Crypto trades in fractions, 24/7.
 * - Futures: long or short, margined. Opening a position holds initial margin; profit or loss settles to
 *   cash as positions are reduced or closed. If cash plus open futures profit/loss falls below the
 *   maintenance margin, every futures position is closed at market (a margin call).
 */
export function paperBroker(ctx: Ctx, userId: string, market: MarketData): Broker {
  ensureTradingAccount(ctx, userId);

  async function futuresBook(): Promise<FuturesBook> {
    const rows = all<PositionRow>(ctx.db, "SELECT symbol, qty, avg_cost FROM positions WHERE user_id = ? AND symbol LIKE '%=F'", userId);
    const book: FuturesBook = { unrealizedCents: 0, marginCents: 0, maintenanceCents: 0, positions: [] };
    for (const row of rows) {
      const spec = FUTURES_BY_SYMBOL.get(row.symbol);
      if (!spec) continue;
      let price = row.avg_cost;
      try {
        price = (await market.quote(row.symbol)).price;
      } catch {
        /* value at entry price if no quote */
      }
      const margin = futureMargin(spec, price);
      book.unrealizedCents += toCents((price - row.avg_cost) * row.qty * spec.multiplier);
      book.marginCents += toCents(Math.abs(row.qty) * margin.initial);
      book.maintenanceCents += toCents(Math.abs(row.qty) * margin.maintenance);
      book.positions.push({ row, spec, price });
    }
    return book;
  }

  const accountRow = () => one<TradingAccountRow>(ctx.db, "SELECT * FROM trading_accounts WHERE user_id = ?", userId)!;
  /** Cash free for new purchases or new futures margin. */
  const available = (acct: TradingAccountRow, book: FuturesBook) => acct.cash_cents + book.unrealizedCents - book.marginCents;

  /** Applies a fill atomically. Throws if cash, shares or margin are insufficient. */
  function fill(orderId: string, price: number, book: FuturesBook) {
    tx(ctx.db, () => {
      const order = one<OrderRow>(ctx.db, "SELECT * FROM orders WHERE id = ?", orderId)!;
      if (order.status !== "new") return;
      const acct = accountRow();
      const pos = one<PositionRow>(ctx.db, "SELECT * FROM positions WHERE user_id = ? AND symbol = ?", userId, order.symbol);

      if (assetClassOf(order.symbol) === "future") {
        const spec = FUTURES_BY_SYMBOL.get(order.symbol);
        if (!spec) throw notFound(`${order.symbol} isn't a futures contract here`);
        const signed = order.side === "buy" ? order.qty : -order.qty;
        const cur = pos?.qty ?? 0;
        const next = cur + signed;
        let realized = 0;
        let avg = pos?.avg_cost ?? price;
        if (Math.abs(cur) < EPS || Math.sign(cur) === Math.sign(signed)) {
          avg = (Math.abs(cur) * (pos?.avg_cost ?? 0) + Math.abs(signed) * price) / Math.abs(next);
        } else {
          const closing = Math.min(Math.abs(cur), Math.abs(signed));
          realized = (price - avg) * closing * spec.multiplier * Math.sign(cur);
          if (Math.abs(signed) > Math.abs(cur) + EPS) avg = price; // flipped from long to short or back
        }
        if (Math.abs(next) > Math.abs(cur) + EPS) {
          const extraMargin = toCents((Math.abs(next) - Math.abs(cur)) * futureMargin(spec, price).initial);
          if (extraMargin > available(acct, book) + toCents(realized)) {
            throw unprocessable(
              "insufficient_margin",
              `Not enough margin: ${Math.abs(signed)} ${order.symbol} needs $${(extraMargin / 100).toFixed(2)} more than you have free`,
            );
          }
        }
        if (Math.abs(next) < EPS) {
          run(ctx.db, "DELETE FROM positions WHERE user_id = ? AND symbol = ?", userId, order.symbol);
        } else {
          run(
            ctx.db,
            `INSERT INTO positions (user_id, symbol, qty, avg_cost, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (user_id, symbol) DO UPDATE SET qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at`,
            userId,
            order.symbol,
            next,
            avg,
            nowIso(),
          );
        }
        if (realized) run(ctx.db, "UPDATE trading_accounts SET cash_cents = cash_cents + ? WHERE user_id = ?", toCents(realized), userId);
      } else {
        const notional = toCents(order.qty * price);
        if (order.side === "buy") {
          if (notional > available(acct, book)) throw unprocessable("insufficient_buying_power", "Not enough demo cash for this order");
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

  function insertOrder(input: OrderInput, placedBy: OrderRow["placed_by"]) {
    const id = newId("ord");
    const now = nowIso();
    run(
      ctx.db,
      `INSERT INTO orders (id, user_id, broker, symbol, side, type, qty, limit_price, status, source, signal_id, placed_by, created_at, updated_at)
       VALUES (?, ?, 'paper', ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
      id,
      userId,
      input.symbol,
      input.side,
      input.type,
      input.qty,
      input.limitPrice ?? null,
      input.source,
      input.signalId ?? null,
      placedBy,
      now,
      now,
    );
    return id;
  }

  /** Margin call: if the futures book can't cover maintenance margin, close all futures at market. */
  async function enforceMargin() {
    const book = await futuresBook();
    if (book.positions.length === 0 || accountRow().cash_cents + book.unrealizedCents >= book.maintenanceCents) return;
    for (const { row, price } of book.positions) {
      const id = insertOrder(
        { symbol: row.symbol, side: row.qty > 0 ? "sell" : "buy", type: "market", qty: Math.abs(row.qty), source: "manual" },
        "system",
      );
      run(ctx.db, "UPDATE orders SET reject_reason = ? WHERE id = ?", "Margin call: closed automatically", id);
      fill(id, price, { unrealizedCents: 0, marginCents: 0, maintenanceCents: 0, positions: [] });
    }
  }

  /** Checks resting limit orders against current prices. */
  async function processOpenOrders() {
    await enforceMargin();
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
        fill(o.id, o.side === "buy" ? Math.min(price, o.limit_price!) : Math.max(price, o.limit_price!), await futuresBook());
      } catch (err) {
        reject(o.id, (err as Error).message);
      }
    }
  }

  return {
    id: "paper",

    async account(): Promise<AccountView> {
      await processOpenOrders();
      const acct = accountRow();
      const rows = all<PositionRow>(ctx.db, "SELECT symbol, qty, avg_cost FROM positions WHERE user_id = ? ORDER BY symbol", userId);
      const positions: PositionView[] = [];
      let marginUsed = 0;
      for (const p of rows) {
        const assetClass = assetClassOf(p.symbol);
        const spec = assetClass === "future" ? FUTURES_BY_SYMBOL.get(p.symbol) : undefined;
        let price = p.avg_cost;
        try {
          price = (await market.quote(p.symbol)).price;
        } catch {
          /* keep cost basis if the quote is unavailable */
        }
        const multiplier = spec?.multiplier ?? 1;
        const costBasis = Math.abs(p.qty) * p.avg_cost * multiplier;
        const unrealized = (price - p.avg_cost) * p.qty * multiplier;
        const margin = spec ? Math.abs(p.qty) * futureMargin(spec, price).initial : 0;
        marginUsed += margin;
        positions.push({
          symbol: p.symbol,
          assetClass,
          qty: p.qty,
          side: p.qty < 0 ? "short" : "long",
          avgCost: Math.round(p.avg_cost * 1e8) / 1e8,
          price,
          marketValue: r2(spec ? unrealized : p.qty * price),
          notional: r2(Math.abs(p.qty) * price * multiplier),
          multiplier,
          margin: r2(margin),
          costBasis: r2(costBasis),
          unrealizedPl: r2(unrealized),
          unrealizedPlPct: costBasis ? Math.round((unrealized / costBasis) * 10000) / 100 : 0,
        });
      }
      const cash = acct.cash_cents / 100;
      const equity = r2(cash + positions.reduce((s, p) => s + p.marketValue, 0));
      const futuresPl = positions.filter((p) => p.assetClass === "future").reduce((s, p) => s + p.marketValue, 0);
      const starting = acct.starting_cents / 100;
      return {
        broker: "paper",
        live: false,
        currency: "USD",
        cash,
        equity,
        buyingPower: Math.max(0, r2(cash + futuresPl - marginUsed)),
        marginUsed: r2(marginUsed),
        startingCash: starting,
        totalReturnPct: Math.round(((equity - starting) / starting) * 10000) / 100,
        positions,
      };
    },

    async placeOrder(input: OrderInput): Promise<OrderView> {
      await enforceMargin();
      const quote = await market.quote(input.symbol);
      const id = insertOrder(input, input.placedBy ?? "user");
      const marketable =
        input.type === "market" || (input.side === "buy" ? quote.price <= input.limitPrice! : quote.price >= input.limitPrice!);
      const book = await futuresBook();
      if (marketable) {
        const price =
          input.type === "market"
            ? quote.price
            : input.side === "buy"
              ? Math.min(quote.price, input.limitPrice!)
              : Math.max(quote.price, input.limitPrice!);
        try {
          fill(id, price, book);
        } catch (err) {
          reject(id, (err as Error).message);
          throw err;
        }
      } else {
        // A resting limit order must be affordable when placed (it's checked again when it fills).
        const acct = accountRow();
        let shortfall: string | null = null;
        if (assetClassOf(input.symbol) === "future") {
          const spec = FUTURES_BY_SYMBOL.get(input.symbol)!;
          const held = one<PositionRow>(ctx.db, "SELECT * FROM positions WHERE user_id = ? AND symbol = ?", userId, input.symbol)?.qty ?? 0;
          const next = held + (input.side === "buy" ? input.qty : -input.qty);
          const extra = toCents((Math.abs(next) - Math.abs(held)) * futureMargin(spec, input.limitPrice!).initial);
          if (extra > 0 && extra > available(acct, book)) shortfall = "Not enough margin for this order";
        } else if (input.side === "buy" && toCents(input.qty * input.limitPrice!) > available(acct, book)) {
          shortfall = "Not enough demo cash for this order";
        }
        if (shortfall) {
          reject(id, shortfall);
          throw unprocessable(shortfall.includes("margin") ? "insufficient_margin" : "insufficient_buying_power", shortfall);
        }
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

/** Starts the demo account over with a fresh virtual balance (default PAPER_STARTING_CASH). */
export function resetPaperAccount(ctx: Ctx, userId: string, startingCash = ctx.config.PAPER_STARTING_CASH) {
  const cents = toCents(startingCash);
  tx(ctx.db, () => {
    ensureTradingAccount(ctx, userId);
    run(ctx.db, "DELETE FROM positions WHERE user_id = ?", userId);
    run(ctx.db, "UPDATE orders SET status = 'canceled', updated_at = ? WHERE user_id = ? AND broker = 'paper' AND status = 'new'", nowIso(), userId);
    run(ctx.db, "UPDATE trading_accounts SET cash_cents = ?, starting_cents = ? WHERE user_id = ?", cents, cents, userId);
  });
}
