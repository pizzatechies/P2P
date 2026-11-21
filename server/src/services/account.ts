import type { Ctx } from "../context.js";
import { exportBusiness } from "./business.js";
import { exportCases } from "./support.js";
import { toCsv } from "../lib/csv.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, notFound, unprocessable } from "../lib/errors.js";
import { assertCurrency, fromMinor } from "../lib/money.js";
import { exportVerification, limitsFor, verificationOverview } from "./kyc.js";
import { dailyOutflowUsdMinor } from "./payments.js";
import { audit, getUserRow, publicProfile } from "./users.js";

/**
 * The customer's account: details and limits, monthly statements, a copy of their data, and closing
 * the account. Financial and identity records outlive a closed account, as anti-money-laundering
 * rules require; personal content (AI chats, keys, connections, watchlists) is deleted on closure.
 */

const formatAccountNumber = (n: string | null) => (n ? `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}` : null);

export async function accountOverview(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const limits = limitsFor(ctx, user);
  const usedTodayUsd = (await dailyOutflowUsdMinor(ctx, userId)) / 100;
  const balances = all<{ currency: string; balance: number }>(
    ctx.db,
    "SELECT currency, balance FROM accounts WHERE owner_type = 'user' AND user_id = ? ORDER BY currency",
    userId,
  ).map((a) => ({ currency: a.currency, balance: fromMinor(a.balance, a.currency) }));
  return {
    accountNumber: user.account_number,
    accountNumberFormatted: formatAccountNumber(user.account_number),
    holder: user.display_name,
    handle: user.handle,
    email: user.email,
    memberSince: user.created_at,
    status: user.closed_at ? "closed" : user.status,
    limits: { ...limits, usedTodayUsd, leftTodayUsd: Math.max(0, limits.dailyUsd - usedTodayUsd) },
    balances,
    verification: verificationOverview(ctx, userId),
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthStart = (period: string) => `${period}-01T00:00:00.000Z`;
const nextMonth = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** Months with a statement (from account opening to now), newest first, with the currencies held. */
export function statementPeriods(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const currencies = all<{ currency: string }>(ctx.db, "SELECT currency FROM accounts WHERE owner_type = 'user' AND user_id = ? ORDER BY currency", userId).map((r) => r.currency);
  const periods: string[] = [];
  let p = user.created_at.slice(0, 7);
  const now = new Date().toISOString().slice(0, 7);
  while (p <= now && periods.length < 120) {
    periods.unshift(p);
    p = nextMonth(p);
  }
  return { currencies, periods };
}

interface StatementRow {
  id: number;
  amount: number;
  created_at: string;
  journal_id: string;
  kind: string;
  memo: string | null;
  metadata: string;
}

function describe(ctx: Ctx, userId: string, row: StatementRow) {
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  if (row.kind === "transfer") {
    const outgoing = meta.from === userId;
    const otherId = String(outgoing ? meta.to : meta.from);
    const other = one<{ id: string; handle: string; display_name: string }>(ctx.db, "SELECT id, handle, display_name FROM users WHERE id = ?", otherId);
    const who = other ? `@${publicProfile(other).handle}` : "another account";
    return `${outgoing ? "Payment to" : "Payment from"} ${who}${row.memo ? ` · ${row.memo}` : ""}`;
  }
  return row.memo ?? row.kind.replace(/_/g, " ");
}

/** One month's statement for one currency: opening balance, every movement with a running balance, closing balance. */
export function buildStatement(ctx: Ctx, userId: string, period: string, rawCurrency: string) {
  if (!PERIOD_RE.test(period)) throw badRequest("Use a month like 2026-11");
  if (period > new Date().toISOString().slice(0, 7)) throw badRequest("That month hasn't started yet");
  return statementFor(ctx, userId, rawCurrency, monthStart(period), monthStart(nextMonth(period)), period);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Wallet activity between two days (inclusive, UTC), in the statement's format: up to a year at a time. */
export function buildRangeStatement(ctx: Ctx, userId: string, fromDay: string, toDay: string, rawCurrency: string) {
  if (!DAY_RE.test(fromDay) || !DAY_RE.test(toDay) || Number.isNaN(Date.parse(fromDay)) || Number.isNaN(Date.parse(toDay))) {
    throw badRequest("Use dates like 2026-11-01");
  }
  if (toDay < fromDay) throw badRequest("The end date is before the start date");
  if (fromDay > new Date().toISOString().slice(0, 10)) throw badRequest("That date hasn't happened yet");
  const from = `${fromDay}T00:00:00.000Z`;
  const to = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86_400_000).toISOString();
  if (Date.parse(to) - Date.parse(from) > 367 * 86_400_000) throw badRequest("Choose at most a year at a time");
  return statementFor(ctx, userId, rawCurrency, from, to, `${fromDay} to ${toDay}`);
}

function statementFor(ctx: Ctx, userId: string, rawCurrency: string, from: string, to: string, period: string) {
  const currency = assertCurrency(rawCurrency).code;
  const user = getUserRow(ctx, userId);
  const account = one<{ id: string }>(ctx.db, "SELECT id FROM accounts WHERE owner_type = 'user' AND user_id = ? AND currency = ?", userId, currency);
  if (!account) throw notFound(`You don't have a ${currency} wallet`);
  const opening = one<{ s: number | null }>(ctx.db, "SELECT SUM(amount) AS s FROM entries WHERE account_id = ? AND created_at < ?", account.id, from)!.s ?? 0;
  const rows = all<StatementRow>(
    ctx.db,
    `SELECT e.id, e.amount, e.created_at, j.id AS journal_id, j.kind, j.memo, j.metadata FROM entries e JOIN journals j ON j.id = e.journal_id
     WHERE e.account_id = ? AND e.created_at >= ? AND e.created_at < ? ORDER BY e.id`,
    account.id,
    from,
    to,
  );
  let balance = opening;
  let totalIn = 0;
  let totalOut = 0;
  const lines = rows.map((r) => {
    balance += r.amount;
    if (r.amount > 0) totalIn += r.amount;
    else totalOut -= r.amount;
    return {
      date: r.created_at,
      description: describe(ctx, userId, r),
      reference: r.journal_id,
      moneyIn: r.amount > 0 ? fromMinor(r.amount, currency) : null,
      moneyOut: r.amount < 0 ? fromMinor(-r.amount, currency) : null,
      balance: fromMinor(balance, currency),
    };
  });
  return {
    accountNumber: formatAccountNumber(user.account_number),
    holder: user.display_name,
    handle: user.handle,
    currency,
    period,
    from,
    to,
    openingBalance: fromMinor(opening, currency),
    moneyIn: fromMinor(totalIn, currency),
    moneyOut: fromMinor(totalOut, currency),
    closingBalance: fromMinor(balance, currency),
    lines,
    generatedAt: nowIso(),
  };
}


export function statementCsv(st: ReturnType<typeof buildStatement>) {
  const head = [
    ["Aurex statement"],
    ["Account holder", st.holder],
    ["Account number", st.accountNumber],
    ["Currency", st.currency],
    ["Period", `${st.from.slice(0, 10)} to ${st.to.slice(0, 10)} (exclusive)`],
    ["Opening balance", st.openingBalance],
    ["Money in", st.moneyIn],
    ["Money out", st.moneyOut],
    ["Closing balance", st.closingBalance],
    [],
    ["Date (UTC)", "Description", "Reference", "Money in", "Money out", "Balance"],
  ];
  const body = st.lines.map((l) => [l.date.replace("T", " ").slice(0, 19), l.description, l.reference, l.moneyIn ?? "", l.moneyOut ?? "", l.balance]);
  return toCsv([...head, ...body]);
}

// ---------------------------------------------------------------------------
// Data export
// ---------------------------------------------------------------------------
/** A copy of everything Aurex holds about the user. Passwords, keys and other secrets are left out. */
export function exportData(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const q = <T>(sql: string, ...args: unknown[]) => all<T>(ctx.db, sql, ...(args as never[]));
  const accounts = q<{ id: string; currency: string; balance: number; created_at: string }>("SELECT id, currency, balance, created_at FROM accounts WHERE owner_type = 'user' AND user_id = ?", userId);
  const accountIds = accounts.map((a) => a.id);
  const marks = accountIds.map(() => "?").join(",") || "''";
  const ledger = accountIds.length
    ? q<{ created_at: string; amount: number; currency: string; journal_id: string; kind: string; memo: string | null }>(
        `SELECT e.created_at, e.amount, e.currency, e.journal_id, j.kind, j.memo FROM entries e JOIN journals j ON j.id = e.journal_id WHERE e.account_id IN (${marks}) ORDER BY e.id`,
        ...accountIds,
      )
    : [];
  const conversations = q<{ id: string; title: string; created_at: string }>("SELECT id, title, created_at FROM ai_conversations WHERE user_id = ? ORDER BY created_at", userId);
  return {
    exportedAt: nowIso(),
    notice: "Your Aurex data. Passwords, two-factor secrets and API keys are not included. Identity documents are listed with a download link.",
    profile: {
      id: user.id,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at),
      handle: user.handle,
      displayName: user.display_name,
      accountNumber: user.account_number,
      defaultCurrency: user.default_currency,
      role: user.role,
      status: user.closed_at ? "closed" : user.status,
      twoFactorEnabled: user.totp_enabled === 1,
      createdAt: user.created_at,
      closedAt: user.closed_at,
    },
    limits: limitsFor(ctx, user),
    verification: exportVerification(ctx, userId),
    wallets: accounts.map((a) => ({ currency: a.currency, balance: fromMinor(a.balance, a.currency), openedAt: a.created_at })),
    transactions: ledger.map((l) => ({ date: l.created_at, kind: l.kind, description: l.memo, currency: l.currency, amount: fromMinor(l.amount, l.currency), reference: l.journal_id })),
    paymentRequests: q("SELECT id, requester_id AS requesterId, payer_id AS payerId, currency, amount, memo, status, created_at AS createdAt FROM payment_requests WHERE requester_id = ? OR payer_id = ? ORDER BY created_at", userId, userId),
    depositsAndWithdrawals: q("SELECT id, direction, rail, currency, amount, status, created_at AS createdAt, updated_at AS updatedAt FROM external_transfers WHERE user_id = ? ORDER BY created_at", userId),
    connections: q("SELECT id, provider, status, institution, country, created_at AS createdAt FROM linked_connections WHERE user_id = ? ORDER BY created_at", userId),
    trading: {
      account: one(ctx.db, "SELECT broker, cash_cents / 100.0 AS cash, starting_cents / 100.0 AS startingCash, created_at AS createdAt FROM trading_accounts WHERE user_id = ?", userId) ?? null,
      positions: q("SELECT symbol, qty, avg_cost AS avgCost, updated_at AS updatedAt FROM positions WHERE user_id = ?", userId),
      orders: q("SELECT id, broker, symbol, side, type, qty, limit_price AS limitPrice, status, filled_qty AS filledQty, filled_avg_price AS filledAvgPrice, source, placed_by AS placedBy, created_at AS createdAt FROM orders WHERE user_id = ? ORDER BY created_at", userId),
      aiSignals: q("SELECT id, symbol, provider, model, action, confidence, suggested_qty AS suggestedQty, price, rationale, created_at AS createdAt FROM ai_signals WHERE user_id = ? ORDER BY created_at", userId),
      watchlist: q("SELECT symbol, created_at AS addedAt FROM watchlist WHERE user_id = ?", userId),
      fills: q("SELECT id, broker, account_type AS accountType, symbol, asset_class AS assetClass, side, qty, price, multiplier, fee_cents / 100.0 AS fee, realized_pl_cents / 100.0 AS realizedPnl, executed_at AS executedAt FROM trade_fills WHERE user_id = ? ORDER BY executed_at", userId),
      autopilot: {
        settings: one(ctx.db, "SELECT enabled, mode, provider, model, symbols, interval_min AS intervalMin, max_position_pct AS maxPositionPct, max_exposure_pct AS maxExposurePct, max_trades_per_day AS maxTradesPerDay, max_daily_loss_pct AS maxDailyLossPct, min_confidence AS minConfidence, allow_live AS allowLive, acknowledged_at AS acknowledgedAt FROM autopilot_settings WHERE user_id = ?", userId) ?? null,
        events: q("SELECT kind, symbol, message, order_id AS orderId, created_at AS createdAt FROM autopilot_events WHERE user_id = ? ORDER BY id", userId),
      },
    },
    plan: one(ctx.db, "SELECT status, currency, amount_minor AS amountMinor, started_at AS startedAt, current_period_end AS currentPeriodEnd, cancel_at_period_end AS cancelAtPeriodEnd, comped FROM subscriptions WHERE user_id = ?", userId) ?? null,
    support: exportCases(ctx, userId),
    business: exportBusiness(ctx, userId),
    aiConversations: conversations.map((c) => ({
      ...c,
      messages: q("SELECT role, content, provider, model, created_at AS createdAt FROM ai_messages WHERE conversation_id = ? ORDER BY created_at", c.id),
    })),
    learning: q("SELECT item_id AS lesson, score, completed_at AS completedAt FROM learning_progress WHERE user_id = ?", userId),
    security: {
      sessions: q("SELECT created_at AS createdAt, expires_at AS expiresAt, ip, user_agent AS userAgent FROM sessions WHERE user_id = ?", userId),
      alerts: q("SELECT kind, message, ip, created_at AS createdAt FROM security_alerts WHERE user_id = ? ORDER BY id", userId),
      activityLog: q("SELECT action, ip, details, created_at AS createdAt FROM audit_events WHERE user_id = ? ORDER BY id", userId),
      apiKeysConnected: q("SELECT provider, created_at AS createdAt FROM user_api_keys WHERE user_id = ?", userId),
    },
  };
}

// ---------------------------------------------------------------------------
// Closing an account
// ---------------------------------------------------------------------------
/** What stops the account from closing right now (empty when it can close). */
export function closureBlockers(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const blockers: string[] = [];
  if (user.role === "admin") blockers.push("Admin accounts can't be closed. Ask another admin to remove your admin role first.");
  const funded = all<{ currency: string; balance: number }>(ctx.db, "SELECT currency, balance FROM accounts WHERE owner_type = 'user' AND user_id = ? AND balance <> 0", userId);
  if (funded.length) {
    blockers.push(`Withdraw or send your remaining money first: ${funded.map((a) => `${a.currency} ${fromMinor(a.balance, a.currency)}`).join(", ")}.`);
  }
  const pending = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM external_transfers WHERE user_id = ? AND status IN ('pending','processing')", userId)!.n;
  if (pending) blockers.push(`Wait for ${pending} deposit${pending === 1 ? "" : "s"} or withdrawal${pending === 1 ? "" : "s"} in progress to finish.`);
  const broker = one<{ broker: string }>(ctx.db, "SELECT broker FROM trading_accounts WHERE user_id = ?", userId)?.broker;
  if (broker === "alpaca") blockers.push("Switch trading back to your demo account and disconnect your brokerage first (Settings → Trading).");
  return blockers;
}

export function closeAccount(ctx: Ctx, userId: string, confirmHandle: string, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (user.closed_at) throw unprocessable("already_closed", "This account is already closed");
  if (confirmHandle.trim().replace(/^@/, "").toLowerCase() !== user.handle.toLowerCase()) throw badRequest("Type your handle exactly to confirm");
  const blockers = closureBlockers(ctx, userId);
  if (blockers.length) throw unprocessable("cannot_close", blockers.join(" "));
  const now = nowIso();
  tx(ctx.db, () => {
    // Personal content goes; ledger, transfers, identity records and the audit trail stay (legal retention).
    run(ctx.db, "UPDATE payment_requests SET status = 'canceled', updated_at = ? WHERE status = 'pending' AND (requester_id = ? OR payer_id = ?)", now, userId, userId);
    run(ctx.db, "DELETE FROM ai_messages WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = ?)", userId);
    run(ctx.db, "DELETE FROM ai_conversations WHERE user_id = ?", userId);
    run(ctx.db, "DELETE FROM user_api_keys WHERE user_id = ?", userId);
    run(ctx.db, "DELETE FROM linked_connections WHERE user_id = ?", userId);
    run(ctx.db, "DELETE FROM watchlist WHERE user_id = ?", userId);
    run(ctx.db, "UPDATE autopilot_settings SET enabled = 0 WHERE user_id = ?", userId);
    run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", userId);
    run(ctx.db, "UPDATE users SET status = 'frozen', closed_at = ? WHERE id = ?", now, userId);
  });
  audit(ctx, userId, "account.closed", {}, ip);
}

/** Admin: reopen a closed account (the customer signs in again with their password). */
export function reopenAccount(ctx: Ctx, adminId: string, userId: string, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (!user.closed_at) throw unprocessable("not_closed", "This account isn't closed");
  run(ctx.db, "UPDATE users SET status = 'active', closed_at = NULL WHERE id = ?", userId);
  audit(ctx, adminId, "admin.account_reopened", { target: userId }, ip);
}
