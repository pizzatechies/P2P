import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { assertCurrency, CURRENCIES, fromMinor, toMinor } from "../lib/money.js";
import { convertMinor, getRates, midRate } from "./fx.js";
import { InsufficientFundsError, postJournal, systemAccount, userAccount } from "./ledger.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Aurex Pro: a monthly plan paid from the customer's own Aurex wallet, so it needs no card network or
 * extra payment provider. Each charge is a ledger journal (kind "subscription") from the customer's
 * wallet to fee income. Pro adds a bigger daily AI allowance, the AI Autopilot and more watched Web3
 * wallets. Statements, data downloads and everyday payments are never behind the plan.
 *
 * Renewal: on the renewal date the next month is charged. If the wallet can't cover it, the plan stays
 * active for a grace period (with an alert each day) and is then cancelled. Cancelling keeps Pro until
 * the end of the month already paid for. Off unless PRO_ENABLED=true.
 */

const PERIOD_DAYS = 30;
const GRACE_DAYS = 3;
const DAY = 86_400_000;

interface SubRow {
  user_id: string;
  status: "active" | "past_due" | "canceled";
  currency: string | null;
  amount_minor: number | null;
  started_at: string;
  current_period_end: string;
  cancel_at_period_end: number;
  comped: number;
  failed_attempts: number;
  last_attempt_at: string | null;
  updated_at: string;
}

const sub = (ctx: Ctx, userId: string) => one<SubRow>(ctx.db, "SELECT * FROM subscriptions WHERE user_id = ?", userId);

/** True while the customer has Pro (including the grace period after a failed renewal). */
export function isPro(ctx: Ctx, userId: string) {
  if (!ctx.config.PRO_ENABLED) return false;
  const s = sub(ctx, userId);
  if (!s || s.status === "canceled") return false;
  if (s.status === "active") return s.current_period_end > nowIso() || !s.cancel_at_period_end;
  return Date.now() - Date.parse(s.current_period_end) < GRACE_DAYS * DAY;
}

/** The plan's perks, used across the app. With Pro switched off, everyone gets the standard limits. */
export function perksFor(ctx: Ctx, userId: string) {
  const pro = isPro(ctx, userId);
  return {
    pro,
    aiDailyRequests: pro ? ctx.config.PRO_AI_DAILY_REQUESTS : ctx.config.AI_FREE_DAILY_REQUESTS,
    autopilot: !ctx.config.PRO_ENABLED || pro,
    web3Wallets: !ctx.config.PRO_ENABLED || pro ? 25 : ctx.config.FREE_WEB3_WALLETS,
  };
}

/** The monthly price in a given currency (converted at the mid-market rate when it isn't the plan's own). */
export async function priceIn(ctx: Ctx, currency: string) {
  const base = assertCurrency(ctx.config.PRO_CURRENCY).code;
  const target = assertCurrency(currency).code;
  const baseMinor = toMinor(String(ctx.config.PRO_PRICE), base);
  if (target === base) return baseMinor;
  const rates = await getRates(ctx);
  return convertMinor(baseMinor, base, target, midRate(rates, base, target));
}

export async function proOverview(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const s = sub(ctx, userId);
  const perks = perksFor(ctx, userId);
  const currencies = all<{ currency: string; balance: number }>(ctx.db, "SELECT currency, balance FROM accounts WHERE owner_type = 'user' AND user_id = ? ORDER BY currency", userId);
  const options = await Promise.all(
    [...new Set([ctx.config.PRO_CURRENCY, user.default_currency, ...currencies.map((c) => c.currency)])]
      .filter((c) => CURRENCIES[c])
      .map(async (c) => {
        const price = await priceIn(ctx, c);
        const balance = currencies.find((x) => x.currency === c)?.balance ?? 0;
        return { currency: c, price: fromMinor(price, c), affordable: balance >= price };
      }),
  );
  return {
    enabled: ctx.config.PRO_ENABLED,
    price: { amount: fromMinor(toMinor(String(ctx.config.PRO_PRICE), ctx.config.PRO_CURRENCY), ctx.config.PRO_CURRENCY), currency: ctx.config.PRO_CURRENCY, periodDays: PERIOD_DAYS },
    perks: {
      free: { aiDailyRequests: ctx.config.AI_FREE_DAILY_REQUESTS, autopilot: !ctx.config.PRO_ENABLED, web3Wallets: ctx.config.PRO_ENABLED ? ctx.config.FREE_WEB3_WALLETS : 25 },
      pro: { aiDailyRequests: ctx.config.PRO_AI_DAILY_REQUESTS, autopilot: true, web3Wallets: 25 },
    },
    payWith: options,
    pro: perks.pro,
    subscription: s
      ? {
          status: s.status,
          currency: s.currency,
          amount: s.amount_minor !== null && s.currency ? fromMinor(s.amount_minor, s.currency) : null,
          startedAt: s.started_at,
          renewsAt: s.cancel_at_period_end || s.status === "canceled" ? null : s.current_period_end,
          endsAt: s.cancel_at_period_end || s.status === "canceled" ? s.current_period_end : null,
          comped: Boolean(s.comped),
          graceEndsAt: s.status === "past_due" ? new Date(Date.parse(s.current_period_end) + GRACE_DAYS * DAY).toISOString() : null,
        }
      : null,
  };
}

/** Takes one month's payment from the wallet. Throws InsufficientFundsError if it can't. */
function charge(ctx: Ctx, userId: string, currency: string, amountMinor: number, period: string) {
  return postJournal(ctx, {
    kind: "subscription",
    initiatorId: userId,
    memo: `Aurex Pro, ${period}`,
    metadata: { plan: "pro", period, amount: amountMinor, currency },
    postings: [
      { accountId: userAccount(ctx, userId, currency).id, amount: -amountMinor, currency },
      { accountId: systemAccount(ctx, "fees", currency).id, amount: amountMinor, currency },
    ],
  });
}

const periodLabel = (from: Date) => `${from.toISOString().slice(0, 10)} to ${new Date(from.getTime() + PERIOD_DAYS * DAY).toISOString().slice(0, 10)}`;

export async function subscribe(ctx: Ctx, userId: string, rawCurrency: string | undefined, ip?: string) {
  if (!ctx.config.PRO_ENABLED) throw new HttpError(404, "not_available", "Aurex Pro isn't available on this server");
  const user = getUserRow(ctx, userId);
  if (user.status !== "active") throw new HttpError(403, "account_frozen", "This account is frozen");
  const existing = sub(ctx, userId);
  if (existing && existing.status !== "canceled" && isPro(ctx, userId)) {
    if (existing.cancel_at_period_end) throw unprocessable("already_pro", "You already have Pro until the end of this month. Resume it instead.");
    throw unprocessable("already_pro", "You already have Aurex Pro");
  }
  const currency = assertCurrency(rawCurrency ?? user.default_currency).code;
  const amount = await priceIn(ctx, currency);
  const now = new Date();
  try {
    tx(ctx.db, () => {
      const journal = charge(ctx, userId, currency, amount, periodLabel(now));
      run(
        ctx.db,
        `INSERT INTO subscriptions (user_id, status, currency, amount_minor, started_at, current_period_end, cancel_at_period_end, comped, failed_attempts, last_charge_journal, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?, 0, 0, 0, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET status = 'active', currency = excluded.currency, amount_minor = excluded.amount_minor, started_at = excluded.started_at,
           current_period_end = excluded.current_period_end, cancel_at_period_end = 0, comped = 0, failed_attempts = 0,
           last_charge_journal = excluded.last_charge_journal, updated_at = excluded.updated_at`,
        userId,
        currency,
        amount,
        now.toISOString(),
        new Date(now.getTime() + PERIOD_DAYS * DAY).toISOString(),
        journal.id,
        nowIso(),
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw unprocessable("insufficient_funds", `Aurex Pro costs ${currency} ${fromMinor(amount, currency)} a month. Add money to your ${currency} wallet first.`);
    }
    throw err;
  }
  audit(ctx, userId, "pro.subscribed", { currency, amount: fromMinor(amount, currency) }, ip);
  addAlert(ctx, userId, "account", `Welcome to Aurex Pro. ${currency} ${fromMinor(amount, currency)} was paid from your wallet; it renews every ${PERIOD_DAYS} days until you cancel.`);
  return proOverview(ctx, userId);
}

export async function cancel(ctx: Ctx, userId: string, ip?: string) {
  const s = sub(ctx, userId);
  if (!s || s.status === "canceled") throw notFound("You don't have Aurex Pro");
  run(ctx.db, "UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE user_id = ?", nowIso(), userId);
  audit(ctx, userId, "pro.cancelled", {}, ip);
  return proOverview(ctx, userId);
}

export async function resume(ctx: Ctx, userId: string, ip?: string) {
  const s = sub(ctx, userId);
  if (!s || s.status === "canceled" || !s.cancel_at_period_end) throw badRequest("There's nothing to resume");
  run(ctx.db, "UPDATE subscriptions SET cancel_at_period_end = 0, updated_at = ? WHERE user_id = ?", nowIso(), userId);
  audit(ctx, userId, "pro.resumed", {}, ip);
  return proOverview(ctx, userId);
}

/** Gives a customer Pro for free (testers, partners, goodwill). No charge, no renewal. */
export function comp(ctx: Ctx, adminId: string, userId: string, days: number, ip?: string) {
  getUserRow(ctx, userId);
  const end = new Date(Date.now() + days * DAY).toISOString();
  run(
    ctx.db,
    `INSERT INTO subscriptions (user_id, status, currency, amount_minor, started_at, current_period_end, cancel_at_period_end, comped, failed_attempts, updated_at)
     VALUES (?, 'active', NULL, NULL, ?, ?, 1, 1, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET status = 'active', current_period_end = MAX(subscriptions.current_period_end, excluded.current_period_end),
       cancel_at_period_end = CASE WHEN subscriptions.comped = 1 OR subscriptions.status = 'canceled' THEN 1 ELSE subscriptions.cancel_at_period_end END,
       comped = CASE WHEN subscriptions.status = 'canceled' THEN 1 ELSE subscriptions.comped END, updated_at = excluded.updated_at`,
    userId,
    nowIso(),
    end,
    nowIso(),
  );
  audit(ctx, adminId, "pro.comped", { target: userId, days }, ip);
  addAlert(ctx, userId, "account", `You've been given Aurex Pro free for ${days} days.`);
}

/** Renews, retries and ends plans that are due. Run hourly (started from index.ts). */
export function processRenewals(ctx: Ctx, now = new Date()) {
  const due = all<SubRow>(ctx.db, "SELECT * FROM subscriptions WHERE status <> 'canceled' AND current_period_end <= ?", now.toISOString());
  const out = { renewed: 0, failed: 0, ended: 0 };
  for (const s of due) {
    if (s.cancel_at_period_end || s.comped || !s.currency || s.amount_minor === null) {
      run(ctx.db, "UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ?", nowIso(), s.user_id);
      out.ended++;
      continue;
    }
    // One attempt a day while past due; give up after the grace period.
    if (s.last_attempt_at && now.getTime() - Date.parse(s.last_attempt_at) < DAY - 60_000) continue;
    const user = one<{ status: string; closed_at: string | null }>(ctx.db, "SELECT status, closed_at FROM users WHERE id = ?", s.user_id);
    try {
      if (!user || user.status !== "active" || user.closed_at) throw new InsufficientFundsError(s.currency);
      const start = new Date(s.current_period_end);
      tx(ctx.db, () => {
        const j = charge(ctx, s.user_id, s.currency!, s.amount_minor!, periodLabel(start));
        run(
          ctx.db,
          "UPDATE subscriptions SET status = 'active', current_period_end = ?, failed_attempts = 0, last_attempt_at = ?, last_charge_journal = ?, updated_at = ? WHERE user_id = ?",
          new Date(start.getTime() + PERIOD_DAYS * DAY).toISOString(),
          now.toISOString(),
          j.id,
          nowIso(),
          s.user_id,
        );
      });
      out.renewed++;
    } catch (err) {
      if (!(err instanceof InsufficientFundsError)) throw err;
      const graceOver = now.getTime() - Date.parse(s.current_period_end) >= GRACE_DAYS * DAY;
      run(
        ctx.db,
        "UPDATE subscriptions SET status = ?, failed_attempts = failed_attempts + 1, last_attempt_at = ?, updated_at = ? WHERE user_id = ?",
        graceOver ? "canceled" : "past_due",
        now.toISOString(),
        nowIso(),
        s.user_id,
      );
      addAlert(
        ctx,
        s.user_id,
        "account",
        graceOver
          ? "Aurex Pro has ended because the renewal couldn't be paid. You can restart it any time from the Pro page."
          : `Aurex Pro couldn't renew: add ${s.currency} ${fromMinor(s.amount_minor!, s.currency!)} to your ${s.currency} wallet. You keep Pro for ${GRACE_DAYS} more days while we retry.`,
      );
      if (graceOver) out.ended++;
      else out.failed++;
    }
  }
  return out;
}

export function startRenewals(ctx: Ctx, everyMs = 60 * 60_000) {
  if (!ctx.config.PRO_ENABLED) return () => undefined;
  const tick = () => {
    try {
      const r = processRenewals(ctx);
      if (r.renewed || r.failed || r.ended) console.log(`[pro] renewed ${r.renewed}, failed ${r.failed}, ended ${r.ended}`);
    } catch (err) {
      console.error("[pro]", err);
    }
  };
  const first = setTimeout(tick, 60_000);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
