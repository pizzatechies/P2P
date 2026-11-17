import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { toCsv } from "../../lib/csv.js";
import { badRequest } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { AccountView } from "./brokers/types.js";
import { assetClassOf, FUTURES_BY_SYMBOL, type AssetClass } from "./instruments.js";

/**
 * Trading records: every execution (trade_fills), every change to the demo account's cash
 * (trading_cash_entries) and a daily valuation of each portfolio (portfolio_snapshots). Fills and cash
 * entries are immutable; the reports below (trade history, realised profit and loss, performance) are
 * built from them.
 */

export type Broker = "paper" | "alpaca";
export type AccountType = "demo" | "real";

const toCents = (dollars: number) => Math.round(dollars * 100);
const fromCents = (cents: number | null) => (cents === null ? null : cents / 100);
const today = () => new Date().toISOString().slice(0, 10);

export interface FillInput {
  userId: string;
  broker: Broker;
  accountType: AccountType;
  /** Aurex's order id for the demo broker, the broker's order id otherwise. */
  orderRef: string;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  feeCents?: number;
  /** How much of an existing position this fill closed (0 when it opened or added to one). */
  closedQty?: number;
  costBasisCents?: number | null;
  /** Profit or loss realised by the closed part; null when it can't be known. */
  realizedCents?: number | null;
  positionAfter?: number | null;
  avgCostAfter?: number | null;
  cashAfterCents?: number | null;
  placedBy?: string;
  source?: string;
  executedAt?: string;
}

/** Records an execution. Idempotent per order: returns the new fill's id, or null if it was already recorded. */
export function recordFill(ctx: Ctx, f: FillInput): string | null {
  const assetClass = assetClassOf(f.symbol);
  const multiplier = assetClass === "future" ? (FUTURES_BY_SYMBOL.get(f.symbol)?.multiplier ?? 1) : 1;
  const id = newId("fill");
  const res = run(
    ctx.db,
    `INSERT OR IGNORE INTO trade_fills
       (id, user_id, broker, account_type, order_ref, order_id, symbol, asset_class, side, qty, price, multiplier, notional_cents,
        fee_cents, closed_qty, cost_basis_cents, realized_pl_cents, position_after, avg_cost_after, cash_after_cents, placed_by, source, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    f.userId,
    f.broker,
    f.accountType,
    f.orderRef,
    f.orderId,
    f.symbol,
    assetClass,
    f.side,
    f.qty,
    f.price,
    multiplier,
    toCents(f.qty * f.price * multiplier),
    f.feeCents ?? 0,
    f.closedQty ?? 0,
    f.costBasisCents ?? null,
    f.realizedCents === undefined ? 0 : f.realizedCents,
    f.positionAfter ?? null,
    f.avgCostAfter ?? null,
    f.cashAfterCents ?? null,
    f.placedBy ?? "user",
    f.source ?? "manual",
    f.executedAt ?? nowIso(),
  );
  return res.changes ? id : null;
}

export type CashKind = "opening" | "buy" | "sell" | "futures_pl" | "fee" | "reset";

/**
 * Journals a change to the demo account's cash. Call inside the same transaction, after
 * trading_accounts.cash_cents has been updated, so balance_after matches the account.
 */
export function recordCash(ctx: Ctx, userId: string, kind: CashKind, amountCents: number, opts: { fillId?: string | null; memo?: string } = {}) {
  if (amountCents === 0 && kind !== "opening" && kind !== "reset") return;
  const balance = one<{ cash_cents: number }>(ctx.db, "SELECT cash_cents FROM trading_accounts WHERE user_id = ?", userId)!.cash_cents;
  run(
    ctx.db,
    "INSERT INTO trading_cash_entries (user_id, kind, amount_cents, balance_after_cents, fill_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    userId,
    kind,
    amountCents,
    balance,
    opts.fillId ?? null,
    opts.memo ?? null,
    nowIso(),
  );
}

/** Saves today's valuation of a portfolio (the latest one each day wins). */
export function snapshotPortfolio(ctx: Ctx, userId: string, account: AccountView) {
  const equity = toCents(account.equity);
  const cash = toCents(account.cash);
  run(
    ctx.db,
    `INSERT INTO portfolio_snapshots (user_id, day, broker, equity_cents, cash_cents, positions_cents, unrealized_cents, positions, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, broker, day) DO UPDATE SET equity_cents = excluded.equity_cents, cash_cents = excluded.cash_cents,
       positions_cents = excluded.positions_cents, unrealized_cents = excluded.unrealized_cents, positions = excluded.positions,
       updated_at = excluded.updated_at`,
    userId,
    today(),
    account.broker,
    equity,
    cash,
    equity - cash,
    toCents(account.positions.reduce((s, p) => s + p.unrealizedPl, 0)),
    account.positions.length,
    nowIso(),
  );
}

/**
 * Demo orders filled before trading records began get a fill record from the order itself. Their
 * profit or loss is unknown (null): demo resets weren't recorded, so the history can't be replayed.
 */
export function backfillFills(ctx: Ctx) {
  const missing = all<{
    id: string;
    user_id: string;
    symbol: string;
    side: "buy" | "sell";
    filled_qty: number;
    qty: number;
    filled_avg_price: number | null;
    placed_by: string;
    source: string;
    updated_at: string;
  }>(
    ctx.db,
    `SELECT o.id, o.user_id, o.symbol, o.side, o.filled_qty, o.qty, o.filled_avg_price, o.placed_by, o.source, o.updated_at
     FROM orders o LEFT JOIN trade_fills f ON f.user_id = o.user_id AND f.broker = 'paper' AND f.order_ref = o.id
     WHERE o.broker = 'paper' AND o.status = 'filled' AND o.filled_avg_price > 0 AND f.id IS NULL`,
  );
  for (const o of missing) {
    recordFill(ctx, {
      userId: o.user_id,
      broker: "paper",
      accountType: "demo",
      orderRef: o.id,
      orderId: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: o.filled_qty || o.qty,
      price: o.filled_avg_price!,
      realizedCents: null,
      placedBy: o.placed_by,
      source: o.source,
      executedAt: o.updated_at,
    });
  }
  return missing.length;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
interface FillRow {
  id: string;
  user_id: string;
  broker: Broker;
  account_type: AccountType;
  order_id: string | null;
  symbol: string;
  asset_class: AssetClass;
  side: "buy" | "sell";
  qty: number;
  price: number;
  multiplier: number;
  notional_cents: number;
  fee_cents: number;
  closed_qty: number;
  cost_basis_cents: number | null;
  realized_pl_cents: number | null;
  position_after: number | null;
  avg_cost_after: number | null;
  cash_after_cents: number | null;
  placed_by: string;
  source: string;
  executed_at: string;
}

export const fillView = (r: FillRow) => ({
  id: r.id,
  executedAt: r.executed_at,
  broker: r.broker,
  accountType: r.account_type,
  orderId: r.order_id,
  symbol: r.symbol,
  assetClass: r.asset_class,
  side: r.side,
  qty: r.qty,
  price: r.price,
  multiplier: r.multiplier,
  notional: r.notional_cents / 100,
  fee: r.fee_cents / 100,
  closedQty: r.closed_qty,
  costBasis: fromCents(r.cost_basis_cents),
  /** Null for a fill that only opened or added to a position, or when it can't be known. */
  realizedPl: r.closed_qty > 0 ? fromCents(r.realized_pl_cents) : null,
  positionAfter: r.position_after,
  avgCostAfter: r.avg_cost_after,
  cashAfter: fromCents(r.cash_after_cents),
  placedBy: r.placed_by,
  source: r.source,
});
export type FillView = ReturnType<typeof fillView>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: string) => `${d}T00:00:00.000Z`;
const nextDayStart = (d: string) => new Date(Date.parse(dayStart(d)) + 86_400_000).toISOString();

export interface HistoryQuery {
  from?: string;
  to?: string;
  symbol?: string;
  assetClass?: AssetClass;
  accountType?: AccountType;
  /** Cursor: fills executed before this time (the previous page's nextBefore). */
  before?: string;
  limit?: number;
}

const validDay = (d: string) => DAY_RE.test(d) && !Number.isNaN(Date.parse(dayStart(d)));

function historyWhere(userId: string | null, q: HistoryQuery) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (userId) {
    where.push("user_id = ?");
    params.push(userId);
  }
  if (q.from) {
    if (!validDay(q.from)) throw badRequest("Use dates like 2026-11-01");
    where.push("executed_at >= ?");
    params.push(dayStart(q.from));
  }
  if (q.to) {
    if (!validDay(q.to)) throw badRequest("Use dates like 2026-11-30");
    where.push("executed_at < ?");
    params.push(nextDayStart(q.to));
  }
  if (q.symbol) {
    where.push("symbol = ?");
    params.push(q.symbol.toUpperCase());
  }
  if (q.assetClass) {
    where.push("asset_class = ?");
    params.push(q.assetClass);
  }
  if (q.accountType) {
    where.push("account_type = ?");
    params.push(q.accountType);
  }
  if (q.before) {
    where.push("executed_at < ?");
    params.push(q.before);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** A page of executions, newest first. */
export function tradeHistory(ctx: Ctx, userId: string, q: HistoryQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const w = historyWhere(userId, q);
  const rows = all<FillRow>(ctx.db, `SELECT * FROM trade_fills ${w.sql} ORDER BY executed_at DESC, id DESC LIMIT ${limit + 1}`, ...w.params);
  const fills = rows.slice(0, limit).map(fillView);
  return { fills, nextBefore: rows.length > limit ? fills[fills.length - 1].executedAt : null };
}

/** Every execution matching the filters (capped), for a CSV download. */
export function tradesCsv(ctx: Ctx, userId: string, q: HistoryQuery = {}) {
  const w = historyWhere(userId, { ...q, before: undefined });
  const rows = all<FillRow>(ctx.db, `SELECT * FROM trade_fills ${w.sql} ORDER BY executed_at, id LIMIT 50000`, ...w.params).map(fillView);
  return toCsv([
    ["Date (UTC)", "Account", "Symbol", "Asset class", "Side", "Quantity", "Price", "Contract multiplier", "Value", "Fee", "Closed quantity", "Cost basis", "Realised P&L", "Position after", "Placed by", "Order"],
    ...rows.map((f) => [
      f.executedAt.replace("T", " ").slice(0, 19),
      f.accountType,
      f.symbol,
      f.assetClass,
      f.side,
      f.qty,
      f.price,
      f.multiplier,
      f.notional.toFixed(2),
      f.fee.toFixed(2),
      f.closedQty || "",
      f.costBasis?.toFixed(2) ?? "",
      f.realizedPl?.toFixed(2) ?? (f.closedQty > 0 ? "unknown" : ""),
      f.positionAfter ?? "",
      f.placedBy,
      f.orderId ?? "",
    ]),
  ]);
}

/** Years with trades, newest first. */
export function tradingYears(ctx: Ctx, userId: string): number[] {
  return all<{ y: string }>(ctx.db, "SELECT DISTINCT substr(executed_at, 1, 4) AS y FROM trade_fills WHERE user_id = ? ORDER BY y DESC", userId).map((r) =>
    Number(r.y),
  );
}

/**
 * Realised profit and loss for a calendar year: totals, each month, each symbol and each asset class.
 * Only fills that closed (part of) a position count. Stocks and crypto use the average-cost method.
 */
export function realizedReport(ctx: Ctx, userId: string, year: number, accountType: AccountType) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest("Choose a year");
  const from = `${year}-01-01T00:00:00.000Z`;
  const to = `${year + 1}-01-01T00:00:00.000Z`;
  const rows = all<FillRow>(
    ctx.db,
    "SELECT * FROM trade_fills WHERE user_id = ? AND account_type = ? AND executed_at >= ? AND executed_at < ? ORDER BY executed_at, id",
    userId,
    accountType,
    from,
    to,
  );
  const closing = rows.filter((r) => r.closed_qty > 0 && r.realized_pl_cents !== null);
  const unknown = rows.filter((r) => r.closed_qty > 0 && r.realized_pl_cents === null).length;
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, "0")}`, realizedPl: 0, trades: 0 }));
  const bySymbol = new Map<string, { symbol: string; assetClass: AssetClass; trades: number; wins: number; losses: number; realizedCents: number; proceedsCents: number; costCents: number }>();
  const byClass = new Map<AssetClass, { assetClass: AssetClass; trades: number; realizedCents: number }>();
  let total = 0;
  let wins = 0;
  let losses = 0;
  let proceeds = 0;
  let cost = 0;
  for (const r of closing) {
    const pl = r.realized_pl_cents!;
    total += pl;
    if (pl > 0) wins++;
    else if (pl < 0) losses++;
    const m = months[Number(r.executed_at.slice(5, 7)) - 1];
    m.realizedPl += pl;
    m.trades++;
    const s = bySymbol.get(r.symbol) ?? { symbol: r.symbol, assetClass: r.asset_class, trades: 0, wins: 0, losses: 0, realizedCents: 0, proceedsCents: 0, costCents: 0 };
    s.trades++;
    s.realizedCents += pl;
    if (pl > 0) s.wins++;
    else if (pl < 0) s.losses++;
    if (r.cost_basis_cents !== null) {
      // Stocks and crypto: what the closed part sold for, and what it cost.
      const sold = Math.round((r.notional_cents * r.closed_qty) / r.qty);
      s.proceedsCents += sold;
      s.costCents += r.cost_basis_cents;
      proceeds += sold;
      cost += r.cost_basis_cents;
    }
    bySymbol.set(r.symbol, s);
    const c = byClass.get(r.asset_class) ?? { assetClass: r.asset_class, trades: 0, realizedCents: 0 };
    c.trades++;
    c.realizedCents += pl;
    byClass.set(r.asset_class, c);
  }
  return {
    year,
    accountType,
    method: "average cost",
    realizedPl: total / 100,
    closingTrades: closing.length,
    wins,
    losses,
    winRatePct: closing.length ? Math.round((wins / closing.length) * 1000) / 10 : null,
    proceeds: proceeds / 100,
    costBasis: cost / 100,
    fees: rows.reduce((s, r) => s + r.fee_cents, 0) / 100,
    trades: rows.length,
    unknownTrades: unknown,
    months: months.map((m) => ({ ...m, realizedPl: m.realizedPl / 100 })),
    bySymbol: [...bySymbol.values()]
      .sort((a, b) => Math.abs(b.realizedCents) - Math.abs(a.realizedCents))
      .map(({ realizedCents, proceedsCents, costCents, ...rest }) => ({ ...rest, realizedPl: realizedCents / 100, proceeds: proceedsCents / 100, costBasis: costCents / 100 })),
    byAssetClass: [...byClass.values()].map(({ realizedCents, ...rest }) => ({ ...rest, realizedPl: realizedCents / 100 })),
    lines: closing.map((r) => ({
      date: r.executed_at,
      symbol: r.symbol,
      assetClass: r.asset_class,
      side: r.side,
      closedQty: r.closed_qty,
      proceeds: r.cost_basis_cents !== null ? Math.round((r.notional_cents * r.closed_qty) / r.qty) / 100 : null,
      costBasis: fromCents(r.cost_basis_cents),
      realizedPl: r.realized_pl_cents! / 100,
    })),
  };
}

export function realizedCsv(report: ReturnType<typeof realizedReport>) {
  return toCsv([
    [`Aurex realised profit and loss ${report.year} (${report.accountType} account, ${report.method} method)`],
    ["Realised P&L", report.realizedPl.toFixed(2)],
    ["Closing trades", report.closingTrades],
    ["Proceeds (stocks and crypto)", report.proceeds.toFixed(2)],
    ["Cost basis (stocks and crypto)", report.costBasis.toFixed(2)],
    ["Fees", report.fees.toFixed(2)],
    ...(report.unknownTrades ? [["Closing trades with unknown P&L (before records began)", report.unknownTrades]] : []),
    [],
    ["Date (UTC)", "Symbol", "Asset class", "Side", "Quantity closed", "Proceeds", "Cost basis", "Realised P&L"],
    ...report.lines.map((l) => [
      l.date.replace("T", " ").slice(0, 19),
      l.symbol,
      l.assetClass,
      l.side,
      l.closedQty,
      l.proceeds?.toFixed(2) ?? "",
      l.costBasis?.toFixed(2) ?? "",
      l.realizedPl.toFixed(2),
    ]),
  ]);
}

/**
 * How a portfolio has done: daily equity, maximum drawdown and trade statistics. For the demo
 * account it starts at the last reset.
 */
export function performance(ctx: Ctx, userId: string, broker: Broker, accountType: AccountType) {
  const since =
    broker === "paper"
      ? (one<{ at: string }>(ctx.db, "SELECT created_at AS at FROM trading_cash_entries WHERE user_id = ? AND kind = 'reset' ORDER BY id DESC LIMIT 1", userId)?.at ?? null)
      : null;
  const fromDay = since ? since.slice(0, 10) : "0000-00-00";
  const snaps = all<{ day: string; equity_cents: number; cash_cents: number; unrealized_cents: number }>(
    ctx.db,
    `SELECT day, equity_cents, cash_cents, unrealized_cents FROM (
       SELECT * FROM portfolio_snapshots WHERE user_id = ? AND broker = ? AND day >= ? ORDER BY day DESC LIMIT 365
     ) ORDER BY day`,
    userId,
    broker,
    fromDay,
  );
  let peak = -Infinity;
  let maxDd = 0;
  for (const s of snaps) {
    peak = Math.max(peak, s.equity_cents);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - s.equity_cents) / peak);
  }
  const fills = all<FillRow>(
    ctx.db,
    "SELECT * FROM trade_fills WHERE user_id = ? AND broker = ? AND account_type = ? AND executed_at >= ? ORDER BY executed_at",
    userId,
    broker,
    accountType,
    since ?? "0000",
  );
  const closed = fills.filter((f) => f.closed_qty > 0 && f.realized_pl_cents !== null);
  const winners = closed.filter((f) => f.realized_pl_cents! > 0);
  const losers = closed.filter((f) => f.realized_pl_cents! < 0);
  const sum = (xs: FillRow[]) => xs.reduce((s, f) => s + f.realized_pl_cents!, 0);
  const best = closed.reduce<FillRow | null>((b, f) => (!b || f.realized_pl_cents! > b.realized_pl_cents! ? f : b), null);
  const worst = closed.reduce<FillRow | null>((b, f) => (!b || f.realized_pl_cents! < b.realized_pl_cents! ? f : b), null);
  const trade = (f: FillRow | null) => (f ? { symbol: f.symbol, realizedPl: f.realized_pl_cents! / 100, at: f.executed_at } : null);
  const first = snaps[0]?.equity_cents ?? null;
  const last = snaps[snaps.length - 1]?.equity_cents ?? null;
  return {
    broker,
    accountType,
    since,
    series: snaps.map((s) => ({ day: s.day, equity: s.equity_cents / 100, cash: s.cash_cents / 100, unrealizedPl: s.unrealized_cents / 100 })),
    changePct: first && last !== null ? Math.round(((last - first) / first) * 10000) / 100 : null,
    maxDrawdownPct: snaps.length > 1 ? Math.round(maxDd * 10000) / 100 : null,
    trades: fills.length,
    closingTrades: closed.length,
    winRatePct: closed.length ? Math.round((winners.length / closed.length) * 1000) / 10 : null,
    realizedPl: sum(closed) / 100,
    averageWin: winners.length ? Math.round(sum(winners) / winners.length) / 100 : null,
    averageLoss: losers.length ? Math.round(sum(losers) / losers.length) / 100 : null,
    profitFactor: losers.length && sum(losers) !== 0 ? Math.round((sum(winners) / Math.abs(sum(losers))) * 100) / 100 : null,
    bestTrade: trade(best),
    worstTrade: trade(worst),
    fees: fills.reduce((s, f) => s + f.fee_cents, 0) / 100,
  };
}

/** The demo account's cash journal, newest first. */
export function cashJournal(ctx: Ctx, userId: string, limit = 100) {
  return all<{ id: number; kind: CashKind; amount_cents: number; balance_after_cents: number; fill_id: string | null; memo: string | null; created_at: string }>(
    ctx.db,
    "SELECT * FROM trading_cash_entries WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    userId,
    Math.min(limit, 1000),
  ).map((e) => ({
    id: e.id,
    kind: e.kind,
    amount: e.amount_cents / 100,
    balanceAfter: e.balance_after_cents / 100,
    fillId: e.fill_id,
    memo: e.memo,
    at: e.created_at,
  }));
}

/**
 * Checks the trading records: each demo account's cash journal adds up to its cash, and every filled
 * demo order has a fill record.
 */
export function verifyTradingRecords(ctx: Ctx) {
  const cashMismatches = all<{ user_id: string; cash_cents: number; computed: number }>(
    ctx.db,
    `SELECT * FROM (
       SELECT t.user_id, t.cash_cents, COALESCE((SELECT SUM(amount_cents) FROM trading_cash_entries e WHERE e.user_id = t.user_id), 0) AS computed
       FROM trading_accounts t
     ) WHERE computed <> cash_cents`,
  );
  const missingFills = one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM orders o
     WHERE o.broker = 'paper' AND o.status = 'filled'
       AND NOT EXISTS (SELECT 1 FROM trade_fills f WHERE f.user_id = o.user_id AND f.broker = 'paper' AND f.order_ref = o.id)`,
  )!.n;
  return {
    ok: cashMismatches.length === 0 && missingFills === 0,
    cashMismatches: cashMismatches.map((m) => ({ userId: m.user_id, cash: m.cash_cents / 100, journal: m.computed / 100 })),
    missingFills,
  };
}

/** Platform-wide trading activity for the admin: volume by asset class, top symbols, recent executions. */
export function tradingActivity(ctx: Ctx, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const byClass = all<{ asset_class: AssetClass; account_type: AccountType; trades: number; volume: number; traders: number; realized: number | null }>(
    ctx.db,
    `SELECT asset_class, account_type, COUNT(*) AS trades, SUM(notional_cents) AS volume, COUNT(DISTINCT user_id) AS traders,
            SUM(CASE WHEN closed_qty > 0 THEN realized_pl_cents END) AS realized
     FROM trade_fills WHERE executed_at >= ? GROUP BY asset_class, account_type ORDER BY volume DESC`,
    since,
  );
  const topSymbols = all<{ symbol: string; trades: number; volume: number }>(
    ctx.db,
    "SELECT symbol, COUNT(*) AS trades, SUM(notional_cents) AS volume FROM trade_fills WHERE executed_at >= ? GROUP BY symbol ORDER BY volume DESC LIMIT 10",
    since,
  );
  const recent = all<FillRow & { handle: string }>(
    ctx.db,
    "SELECT f.*, u.handle FROM trade_fills f JOIN users u ON u.id = f.user_id ORDER BY f.executed_at DESC LIMIT 50",
  );
  return {
    days,
    byAssetClass: byClass.map((r) => ({
      assetClass: r.asset_class,
      accountType: r.account_type,
      trades: r.trades,
      volume: r.volume / 100,
      traders: r.traders,
      realizedPl: fromCents(r.realized),
    })),
    topSymbols: topSymbols.map((s) => ({ symbol: s.symbol, trades: s.trades, volume: s.volume / 100 })),
    recent: recent.map((r) => ({ ...fillView(r), userId: r.user_id, handle: r.handle })),
    integrity: verifyTradingRecords(ctx),
  };
}
