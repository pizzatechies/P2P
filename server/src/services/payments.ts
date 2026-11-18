import type { Ctx } from "../context.js";
import { assertNotUnderSanctionsReview, screenForCustomer, underSanctionsReview } from "./sanctions.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency, bps, fromMinor } from "../lib/money.js";
import { quote, toUsdMinor } from "./fx.js";
import {
  findJournalByIdempotencyKey,
  postJournal,
  systemAccount,
  userAccount,
  type JournalRow,
} from "./ledger.js";
import { getRail, getRails } from "./rails/index.js";
import type { PayoutDestination } from "./rails/types.js";
import { limitsFor } from "./kyc.js";
import { hasOpenSeriousAlert, monitor, notifyAdmins } from "./monitoring.js";
import { addAlert } from "./security.js";
import { findUserByIdentifier, getUserRow, publicProfile, type UserRow } from "./users.js";

// ---------------------------------------------------------------------------
// Risk limits
// ---------------------------------------------------------------------------
const verifyHint = (level: number, tiered: boolean) =>
  tiered && level < 2 ? ` Verify your ${level === 0 ? "identity" : "address and source of funds"} under Account to raise it.` : "";

/** Money sent or withdrawn in the last 24 hours, in US cents. */
export async function dailyOutflowUsdMinor(ctx: Ctx, userId: string) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const outflows = all<{ currency: string; total: number }>(
    ctx.db,
    `SELECT e.currency, -SUM(e.amount) AS total
     FROM entries e
     JOIN accounts a ON a.id = e.account_id
     JOIN journals j ON j.id = e.journal_id
     WHERE a.owner_type = 'user' AND a.user_id = ? AND e.amount < 0
       AND j.kind IN ('transfer', 'withdrawal') AND e.created_at >= ?
     GROUP BY e.currency`,
    userId,
    since,
  );
  let usedUsd = 0;
  for (const o of outflows) usedUsd += await toUsdMinor(ctx, o.currency, o.total);
  return usedUsd;
}

/** Per-payment and 24-hour limits, which depend on the user's verification level (or an admin override). */
async function checkLimits(ctx: Ctx, userId: string, currency: string, amountMinor: number) {
  const limits = limitsFor(ctx, getUserRow(ctx, userId));
  const usd = await toUsdMinor(ctx, currency, amountMinor);
  if (usd > Math.round(limits.txUsd * 100)) {
    throw unprocessable(
      "limit_exceeded",
      `Single payments are limited to $${limits.txUsd.toLocaleString("en-US")} (USD equivalent) on your account.${verifyHint(limits.level, limits.tiered)}`,
    );
  }
  const usedUsd = await dailyOutflowUsdMinor(ctx, userId);
  const daily = Math.round(limits.dailyUsd * 100);
  if (usedUsd + usd > daily) {
    const left = Math.max(0, daily - usedUsd);
    throw unprocessable(
      "limit_exceeded",
      `This would exceed your 24-hour limit of $${limits.dailyUsd.toLocaleString("en-US")}. You can send about $${fromMinor(left, "USD")} more today.${verifyHint(limits.level, limits.tiered)}`,
    );
  }
}

function assertActive(user: UserRow, who: "sender" | "recipient") {
  if (user.status !== "active") {
    throw unprocessable("account_frozen", who === "sender" ? "Your account is frozen" : "That account can't receive money right now");
  }
}

// ---------------------------------------------------------------------------
// P2P transfers
// ---------------------------------------------------------------------------
export interface TransferView {
  id: string;
  currency: string;
  amount: string;
  amountMinor: number;
  fee: string;
  feeMinor: number;
  memo: string | null;
  from: ReturnType<typeof publicProfile>;
  to: ReturnType<typeof publicProfile>;
  createdAt: string;
}

function transferView(ctx: Ctx, j: JournalRow): TransferView {
  const meta = JSON.parse(j.metadata) as { from: string; to: string; amount: number; fee: number; currency: string };
  return {
    id: j.id,
    currency: meta.currency,
    amount: fromMinor(meta.amount, meta.currency),
    amountMinor: meta.amount,
    fee: fromMinor(meta.fee, meta.currency),
    feeMinor: meta.fee,
    memo: j.memo,
    from: publicProfile(getUserRow(ctx, meta.from)),
    to: publicProfile(getUserRow(ctx, meta.to)),
    createdAt: j.created_at,
  };
}

/** Synchronous core of a transfer; must be called inside tx(). */
function postTransfer(
  ctx: Ctx,
  sender: UserRow,
  recipient: UserRow,
  currency: string,
  amount: number,
  memo: string | null,
  idempotencyKey: string | null,
  extraMeta: Record<string, unknown> = {},
): JournalRow {
  const fee = bps(amount, ctx.config.P2P_FEE_BPS);
  return postJournal(ctx, {
    kind: "transfer",
    memo,
    initiatorId: sender.id,
    idempotencyKey,
    metadata: { from: sender.id, to: recipient.id, amount, fee, currency, ...extraMeta },
    postings: [
      { accountId: userAccount(ctx, sender.id, currency).id, amount: -(amount + fee), currency },
      { accountId: userAccount(ctx, recipient.id, currency).id, amount, currency },
      { accountId: systemAccount(ctx, "fees", currency).id, amount: fee, currency },
    ],
  });
}

export async function sendMoney(
  ctx: Ctx,
  input: { senderId: string; to: string; currency: string; amountMinor: number; memo?: string; idempotencyKey?: string },
): Promise<TransferView> {
  const currency = assertCurrency(input.currency).code;
  if (input.amountMinor <= 0) throw badRequest("Amount must be greater than zero");

  if (input.idempotencyKey) {
    const existing = findJournalByIdempotencyKey(ctx, input.senderId, input.idempotencyKey);
    if (existing) return transferView(ctx, existing);
  }

  const sender = getUserRow(ctx, input.senderId);
  const recipient = findUserByIdentifier(ctx, input.to);
  if (!recipient) throw notFound("No one found with that handle or email");
  if (recipient.id === sender.id) throw badRequest("You can't send money to yourself");
  assertActive(sender, "sender");
  assertActive(recipient, "recipient");
  assertNotUnderSanctionsReview(ctx, sender.id, "you");
  assertNotUnderSanctionsReview(ctx, recipient.id, "recipient");

  await checkLimits(ctx, sender.id, currency, input.amountMinor);

  const journal = tx(ctx.db, () => {
    // Re-check inside the transaction in case an identical request raced us.
    if (input.idempotencyKey) {
      const existing = findJournalByIdempotencyKey(ctx, sender.id, input.idempotencyKey);
      if (existing) return existing;
    }
    return postTransfer(ctx, sender, recipient, currency, input.amountMinor, input.memo?.trim() || null, input.idempotencyKey ?? null);
  });
  await monitor(ctx, { kind: "transfer", userId: sender.id, recipientId: recipient.id, ref: journal.id, currency, amountMinor: input.amountMinor });
  return transferView(ctx, journal);
}

// ---------------------------------------------------------------------------
// Payment requests ("request money")
// ---------------------------------------------------------------------------
interface RequestRow {
  id: string;
  requester_id: string;
  payer_id: string;
  currency: string;
  amount: number;
  memo: string | null;
  status: "pending" | "paid" | "declined" | "canceled";
  journal_id: string | null;
  created_at: string;
  updated_at: string;
}

function requestView(ctx: Ctx, r: RequestRow) {
  return {
    id: r.id,
    currency: r.currency,
    amount: fromMinor(r.amount, r.currency),
    amountMinor: r.amount,
    memo: r.memo,
    status: r.status,
    requester: publicProfile(getUserRow(ctx, r.requester_id)),
    payer: publicProfile(getUserRow(ctx, r.payer_id)),
    transactionId: r.journal_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createRequest(
  ctx: Ctx,
  input: { requesterId: string; from: string; currency: string; amountMinor: number; memo?: string },
) {
  const currency = assertCurrency(input.currency).code;
  if (input.amountMinor <= 0) throw badRequest("Amount must be greater than zero");
  const payer = findUserByIdentifier(ctx, input.from);
  if (!payer) throw notFound("No one found with that handle or email");
  if (payer.id === input.requesterId) throw badRequest("You can't request money from yourself");
  const pending = one<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*) AS n FROM payment_requests WHERE requester_id = ? AND status = 'pending'",
    input.requesterId,
  )!.n;
  if (pending >= 50) throw unprocessable("too_many_requests", "You have too many open requests. Cancel some first.");

  const id = newId("req");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO payment_requests (id, requester_id, payer_id, currency, amount, memo, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    input.requesterId,
    payer.id,
    currency,
    input.amountMinor,
    input.memo?.trim() || null,
    now,
    now,
  );
  return requestView(ctx, one<RequestRow>(ctx.db, "SELECT * FROM payment_requests WHERE id = ?", id)!);
}

export function listRequests(ctx: Ctx, userId: string) {
  const rows = all<RequestRow>(
    ctx.db,
    `SELECT * FROM payment_requests WHERE requester_id = ? OR payer_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`,
    userId,
    userId,
  );
  const views = rows.map((r) => requestView(ctx, r));
  return {
    incoming: views.filter((v) => v.payer.id === userId),
    outgoing: views.filter((v) => v.requester.id === userId),
  };
}

function loadRequest(ctx: Ctx, id: string): RequestRow {
  const r = one<RequestRow>(ctx.db, "SELECT * FROM payment_requests WHERE id = ?", id);
  if (!r) throw notFound("Request not found");
  return r;
}

/** Currency and amount of a payment request addressed to the user (for step-up checks before paying). */
export function requestAmountFor(ctx: Ctx, userId: string, requestId: string) {
  const req = loadRequest(ctx, requestId);
  if (req.payer_id !== userId) throw forbidden("This request isn't addressed to you");
  return { currency: req.currency, amountMinor: req.amount };
}

export async function payRequest(ctx: Ctx, userId: string, requestId: string) {
  const req = loadRequest(ctx, requestId);
  if (req.payer_id !== userId) throw forbidden("This request isn't addressed to you");
  if (req.status !== "pending") throw unprocessable("request_closed", `This request is already ${req.status}`);
  const payer = getUserRow(ctx, userId);
  const requester = getUserRow(ctx, req.requester_id);
  assertActive(payer, "sender");
  assertActive(requester, "recipient");
  assertNotUnderSanctionsReview(ctx, payer.id, "you");
  assertNotUnderSanctionsReview(ctx, requester.id, "recipient");
  await checkLimits(ctx, userId, req.currency, req.amount);

  const journalId = tx(ctx.db, () => {
    const fresh = loadRequest(ctx, requestId);
    if (fresh.status !== "pending") throw unprocessable("request_closed", `This request is already ${fresh.status}`);
    const journal = postTransfer(ctx, payer, requester, req.currency, req.amount, req.memo, `request:${req.id}`, {
      requestId: req.id,
    });
    run(
      ctx.db,
      "UPDATE payment_requests SET status = 'paid', journal_id = ?, updated_at = ? WHERE id = ?",
      journal.id,
      nowIso(),
      req.id,
    );
    return journal.id;
  });
  await monitor(ctx, { kind: "transfer", userId: payer.id, recipientId: requester.id, ref: journalId, currency: req.currency, amountMinor: req.amount });
  return requestView(ctx, loadRequest(ctx, requestId));
}

export function closeRequest(ctx: Ctx, userId: string, requestId: string, action: "decline" | "cancel") {
  const req = loadRequest(ctx, requestId);
  if (action === "decline" && req.payer_id !== userId) throw forbidden("Only the payer can decline");
  if (action === "cancel" && req.requester_id !== userId) throw forbidden("Only the requester can cancel");
  if (req.status !== "pending") throw unprocessable("request_closed", `This request is already ${req.status}`);
  run(
    ctx.db,
    "UPDATE payment_requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    action === "decline" ? "declined" : "canceled",
    nowIso(),
    requestId,
  );
  return requestView(ctx, loadRequest(ctx, requestId));
}

// ---------------------------------------------------------------------------
// Currency conversion between a user's own wallets
// ---------------------------------------------------------------------------
export async function convert(
  ctx: Ctx,
  input: { userId: string; from: string; to: string; amountMinor: number; idempotencyKey?: string },
) {
  const from = assertCurrency(input.from).code;
  const to = assertCurrency(input.to).code;
  if (input.idempotencyKey) {
    const existing = findJournalByIdempotencyKey(ctx, input.userId, input.idempotencyKey);
    if (existing) return { id: existing.id, ...JSON.parse(existing.metadata) };
  }
  const q = await quote(ctx, from, to, input.amountMinor);
  if (q.toAmountMinor <= 0) throw badRequest("Amount is too small to convert");
  const meta = {
    from,
    to,
    fromAmount: input.amountMinor,
    toAmount: q.toAmountMinor,
    rate: q.rate,
    midRate: q.midRate,
    spreadBps: q.spreadBps,
    rateSource: q.source,
  };
  const journal = postJournal(ctx, {
    kind: "fx",
    initiatorId: input.userId,
    idempotencyKey: input.idempotencyKey ?? null,
    memo: `Converted ${from} to ${to}`,
    metadata: meta,
    postings: [
      { accountId: userAccount(ctx, input.userId, from).id, amount: -input.amountMinor, currency: from },
      { accountId: systemAccount(ctx, "fx", from).id, amount: input.amountMinor, currency: from },
      { accountId: systemAccount(ctx, "fx", to).id, amount: -q.toAmountMinor, currency: to },
      { accountId: userAccount(ctx, input.userId, to).id, amount: q.toAmountMinor, currency: to },
    ],
  });
  return { id: journal.id, ...meta };
}

// ---------------------------------------------------------------------------
// Deposits & withdrawals through payment rails
// ---------------------------------------------------------------------------
interface ExternalRow {
  id: string;
  user_id: string;
  direction: "deposit" | "withdrawal";
  rail: string;
  currency: string;
  amount: number;
  fee: number;
  status: "pending" | "completed" | "failed" | "canceled";
  provider_ref: string | null;
  destination: string | null;
  failure_reason: string | null;
  journal_id: string | null;
  payout_reference: string | null;
  review_status: "required" | "approved" | "rejected" | null;
  review_reasons: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

function externalView(r: ExternalRow) {
  const dest = r.destination ? (JSON.parse(r.destination) as PayoutDestination) : null;
  return {
    id: r.id,
    direction: r.direction,
    rail: r.rail,
    currency: r.currency,
    amount: fromMinor(r.amount, r.currency),
    amountMinor: r.amount,
    fee: fromMinor(r.fee, r.currency),
    status: r.status,
    failureReason: r.failure_reason,
    destination: dest ? { type: dest.type, name: dest.name, accountLast4: destinationHint(dest), wallet: dest.wallet ?? null, country: dest.country ?? null } : null,
    /** What the recipient needs to collect the money (e.g. a MoneyGram reference number). Only shown to the owner. */
    payoutReference: r.payout_reference ?? null,
    /** "required" while a withdrawal waits for a second person to approve it. */
    review: r.review_status ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Identifies a payout destination regardless of the name typed for it. */
function destinationFingerprint(dest: PayoutDestination): string {
  const detail = Object.entries(dest.details ?? {})
    .filter(([k]) => /^(iban|accountnumber|email|phonenumber|bic|swift|sortcode|routingnumber)$/i.test(k))
    .map(([k, v]) => `${k.toLowerCase()}=${String(v).replace(/\s+/g, "").toLowerCase()}`)
    .sort();
  return [dest.type, dest.accountNumber, dest.bankCode, dest.email, dest.wallet, dest.country, dest.firstName, dest.lastName, ...detail]
    .map((v) => String(v ?? "").replace(/\s+/g, "").toLowerCase())
    .join("|");
}

/** The last few characters of where a payout went, safe to show in lists. */
function destinationHint(dest: PayoutDestination): string | null {
  const detail = Object.entries(dest.details ?? {}).find(([k]) => /^(iban|accountnumber|email|phonenumber)$/i.test(k))?.[1];
  const raw = dest.accountNumber ?? dest.email ?? detail ?? null;
  if (!raw) return null;
  if (raw.includes("@")) {
    const [user, domain] = raw.split("@");
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  return raw.replace(/\s+/g, "").slice(-4);
}

function loadExternal(ctx: Ctx, id: string): ExternalRow {
  const r = one<ExternalRow>(ctx.db, "SELECT * FROM external_transfers WHERE id = ?", id);
  if (!r) throw notFound("Transfer not found");
  return r;
}

export function getExternalForUser(ctx: Ctx, userId: string, id: string) {
  const r = loadExternal(ctx, id);
  if (r.user_id !== userId) throw notFound("Transfer not found");
  return externalView(r);
}

export function findExternalById(ctx: Ctx, id: string) {
  return one<ExternalRow>(ctx.db, "SELECT * FROM external_transfers WHERE id = ?", id);
}

/**
 * Asks the payment rail for the real state of a pending deposit or withdrawal and settles it.
 * Used when the user returns from a hosted checkout, by webhooks (as a trigger only), and on demand.
 */
export async function refreshExternal(ctx: Ctx, id: string, userId?: string) {
  const ext = loadExternal(ctx, id);
  if (userId && ext.user_id !== userId) throw notFound("Transfer not found");
  if (ext.status !== "pending") return externalView(ext);
  if (ext.review_status === "required") return externalView(ext); // not sent to the provider yet
  const rail = getRails(ctx).get(ext.rail);
  if (ext.direction === "deposit" && rail?.checkDeposit) {
    const state = await rail.checkDeposit({ externalId: ext.id, providerRef: ext.provider_ref, currency: ext.currency, amount: ext.amount });
    if (state === "completed") completeDeposit(ctx, ext.id);
    else if (state === "failed") failDeposit(ctx, ext.id, "The payment wasn't completed");
  } else if (ext.direction === "withdrawal" && rail?.checkPayout) {
    const state = await rail.checkPayout({ externalId: ext.id, providerRef: ext.provider_ref });
    if (state === "completed") settleWithdrawal(ctx, ext.id);
    else if (state === "failed") reverseWithdrawal(ctx, ext.id, "The payout provider rejected the transfer");
  }
  return externalView(loadExternal(ctx, id));
}

/**
 * Reconciliation: asks providers about transfers still pending after a couple of minutes, so a
 * missed webhook or a user who never came back from checkout doesn't leave money in limbo.
 */
export function startReconciler(ctx: Ctx, everyMs = 5 * 60_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = all<{ id: string }>(
        ctx.db,
        "SELECT id FROM external_transfers WHERE status = 'pending' AND (review_status IS NULL OR review_status <> 'required') AND created_at < ? AND created_at > ? ORDER BY updated_at LIMIT 50",
        new Date(Date.now() - 2 * 60_000).toISOString(),
        new Date(Date.now() - 30 * 86_400_000).toISOString(),
      );
      for (const r of rows) {
        await refreshExternal(ctx, r.id).catch((err) => console.warn(`[reconcile] ${r.id}: ${(err as Error).message}`));
        run(ctx.db, "UPDATE external_transfers SET updated_at = ? WHERE id = ? AND status = 'pending'", nowIso(), r.id);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function findExternalByProviderRef(ctx: Ctx, rail: string, ref: string) {
  return one<ExternalRow>(ctx.db, "SELECT * FROM external_transfers WHERE rail = ? AND provider_ref = ?", rail, ref);
}

export function listExternal(ctx: Ctx, userId: string) {
  return all<ExternalRow>(
    ctx.db,
    "SELECT * FROM external_transfers WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    userId,
  ).map(externalView);
}

export async function deposit(ctx: Ctx, input: { userId: string; rail: string; currency: string; amountMinor: number; phone?: string }) {
  const currency = assertCurrency(input.currency).code;
  if (input.amountMinor <= 0) throw badRequest("Amount must be greater than zero");
  const rail = getRail(ctx, input.rail, "deposit", currency);
  const user = getUserRow(ctx, input.userId);
  assertActive(user, "sender");
  const depositLimits = limitsFor(ctx, user);
  if ((await toUsdMinor(ctx, currency, input.amountMinor)) > depositLimits.txUsd * 100) {
    throw unprocessable(
      "limit_exceeded",
      `Deposits are limited to $${depositLimits.txUsd.toLocaleString("en-US")} at a time on your account.${verifyHint(depositLimits.level, depositLimits.tiered)}`,
    );
  }

  const id = newId("ext");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO external_transfers (id, user_id, direction, rail, currency, amount, status, created_at, updated_at)
     VALUES (?, ?, 'deposit', ?, ?, ?, 'pending', ?, ?)`,
    id,
    user.id,
    rail.id,
    currency,
    input.amountMinor,
    now,
    now,
  );

  let result;
  try {
    result = await rail.createDeposit!({ externalId: id, userId: user.id, email: user.email, currency, amount: input.amountMinor, phone: input.phone });
  } catch (err) {
    run(
      ctx.db,
      "UPDATE external_transfers SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
      (err as Error).message.slice(0, 300),
      nowIso(),
      id,
    );
    throw err;
  }
  if (result.providerRef) {
    run(ctx.db, "UPDATE external_transfers SET provider_ref = ?, updated_at = ? WHERE id = ?", result.providerRef, nowIso(), id);
  }
  if (result.status === "completed") completeDeposit(ctx, id);
  return { transfer: externalView(loadExternal(ctx, id)), redirectUrl: result.redirectUrl ?? null, instructions: result.instructions ?? null };
}

/** Credits the wallet for a confirmed deposit. Idempotent: safe to call again for webhook retries. */
export function completeDeposit(ctx: Ctx, externalId: string) {
  let credited: ExternalRow | null = null;
  const view = tx(ctx.db, () => {
    const ext = loadExternal(ctx, externalId);
    if (ext.direction !== "deposit") throw new Error("Not a deposit");
    if (ext.status !== "pending") return externalView(ext);
    credited = ext;
    const journal = postJournal(ctx, {
      kind: "deposit",
      initiatorId: ext.user_id,
      memo: `Added money via ${ext.rail}`,
      metadata: { externalId: ext.id, rail: ext.rail, amount: ext.amount, currency: ext.currency },
      postings: [
        { accountId: systemAccount(ctx, "external", ext.currency).id, amount: -ext.amount, currency: ext.currency },
        { accountId: userAccount(ctx, ext.user_id, ext.currency).id, amount: ext.amount, currency: ext.currency },
      ],
    });
    run(
      ctx.db,
      "UPDATE external_transfers SET status = 'completed', journal_id = ?, updated_at = ? WHERE id = ?",
      journal.id,
      nowIso(),
      ext.id,
    );
    return externalView(loadExternal(ctx, ext.id));
  });
  const c = credited as ExternalRow | null;
  if (c) void monitor(ctx, { kind: "deposit", userId: c.user_id, ref: c.id, currency: c.currency, amountMinor: c.amount });
  return view;
}

export function failDeposit(ctx: Ctx, externalId: string, reason: string) {
  run(
    ctx.db,
    "UPDATE external_transfers SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    reason,
    nowIso(),
    externalId,
  );
}

export async function withdraw(
  ctx: Ctx,
  input: {
    userId: string;
    rail: string;
    currency: string;
    amountMinor: number;
    destination: PayoutDestination;
    idempotencyKey?: string;
  },
) {
  const currency = assertCurrency(input.currency).code;
  if (input.amountMinor <= 0) throw badRequest("Amount must be greater than zero");
  if (input.idempotencyKey) {
    const existing = findJournalByIdempotencyKey(ctx, input.userId, input.idempotencyKey);
    if (existing) return externalView(loadExternal(ctx, (JSON.parse(existing.metadata) as { externalId: string }).externalId));
  }
  const rail = getRail(ctx, input.rail, "withdrawal", currency);
  const user = getUserRow(ctx, input.userId);
  assertActive(user, "sender");
  assertNotUnderSanctionsReview(ctx, user.id, "you");
  await checkLimits(ctx, user.id, currency, input.amountMinor);

  const fee = bps(input.amountMinor, ctx.config.WITHDRAWAL_FEE_BPS);
  const id = newId("ext");

  // 1) Hold the funds in clearing before talking to the rail, so they can't be spent twice.
  tx(ctx.db, () => {
    const now = nowIso();
    run(
      ctx.db,
      `INSERT INTO external_transfers (id, user_id, direction, rail, currency, amount, fee, status, destination, created_at, updated_at)
       VALUES (?, ?, 'withdrawal', ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      user.id,
      rail.id,
      currency,
      input.amountMinor,
      fee,
      JSON.stringify(input.destination),
      now,
      now,
    );
    const journal = postJournal(ctx, {
      kind: "withdrawal",
      initiatorId: user.id,
      idempotencyKey: input.idempotencyKey ?? null,
      memo: `Withdrawal to ${input.destination.name}`,
      metadata: { externalId: id, rail: rail.id, amount: input.amountMinor, fee, currency },
      postings: [
        { accountId: userAccount(ctx, user.id, currency).id, amount: -(input.amountMinor + fee), currency },
        { accountId: systemAccount(ctx, "clearing", currency).id, amount: input.amountMinor, currency },
        { accountId: systemAccount(ctx, "fees", currency).id, amount: fee, currency },
      ],
    });
    run(ctx.db, "UPDATE external_transfers SET journal_id = ? WHERE id = ?", journal.id, id);
  });

  // A payout to somewhere this customer has never sent money before: tell them (by email too), so a
  // thief who got into the account can't empty it quietly.
  const fingerprint = destinationFingerprint(input.destination);
  const known = all<{ destination: string | null }>(
    ctx.db,
    "SELECT destination FROM external_transfers WHERE user_id = ? AND direction = 'withdrawal' AND id <> ? AND status IN ('pending','completed')",
    user.id,
    id,
  ).some((r) => r.destination && destinationFingerprint(JSON.parse(r.destination) as PayoutDestination) === fingerprint);
  if (!known) {
    const hint = destinationHint(input.destination);
    addAlert(
      ctx,
      user.id,
      "new_payee",
      `A withdrawal of ${currency} ${fromMinor(input.amountMinor, currency)} to a new destination (${input.destination.name}${hint ? ` ${hint.includes("@") ? hint : `••${hint}`}` : ""}) was requested. If this wasn't you, change your password and contact support now.`,
    );
  }

  // 2) Monitoring, then either hold the payout for a second person or send it now.
  await monitor(ctx, { kind: "withdrawal", userId: user.id, ref: id, currency, amountMinor: input.amountMinor });
  const payeeName = [input.destination.firstName, input.destination.lastName].filter(Boolean).join(" ") || input.destination.name;
  const payeeHit = screenForCustomer(ctx, user.id, payeeName, "payee").length > 0;
  const reasons = await payoutReviewReasons(ctx, user.id, currency, input.amountMinor);
  if (payeeHit) reasons.unshift("Recipient's name resembles a sanctions list entry");
  if (reasons.length) {
    run(ctx.db, "UPDATE external_transfers SET review_status = 'required', review_reasons = ?, updated_at = ? WHERE id = ?", JSON.stringify(reasons), nowIso(), id);
    notifyAdmins(ctx, `A withdrawal of ${currency} ${fromMinor(input.amountMinor, currency)} by @${user.handle} is waiting for your review (Admin → Payouts).`);
    return externalView(loadExternal(ctx, id));
  }
  return sendPayout(ctx, id);
}

/** Why a withdrawal needs a second person before the money leaves (empty: it doesn't). */
async function payoutReviewReasons(ctx: Ctx, userId: string, currency: string, amountMinor: number) {
  // A possible sanctions match always waits for a person, even with payout review switched off.
  if (!ctx.config.PAYOUT_REVIEW) return underSanctionsReview(ctx, userId) ? ["Possible sanctions list match"] : [];
  const reasons: string[] = [];
  const usd = await toUsdMinor(ctx, currency, amountMinor);
  if (usd >= Math.round(ctx.config.PAYOUT_REVIEW_USD * 100)) reasons.push(`At or over $${ctx.config.PAYOUT_REVIEW_USD.toLocaleString("en-US")}`);
  if (hasOpenSeriousAlert(ctx, userId)) reasons.push("Open transaction-monitoring alert");
  return reasons;
}

/** Asks the rail to pay out a held withdrawal, then settles it or returns the money. */
async function sendPayout(ctx: Ctx, id: string) {
  const ext = loadExternal(ctx, id);
  const rail = getRail(ctx, ext.rail, "withdrawal", ext.currency);
  const destination = JSON.parse(ext.destination ?? "{}") as PayoutDestination;
  let result;
  try {
    result = await rail.createPayout!({
      externalId: id,
      userId: ext.user_id,
      currency: ext.currency,
      amount: ext.amount,
      destination,
    });
  } catch (err) {
    result = { status: "failed" as const, failureReason: (err as Error).message };
  }
  if (result.reference) {
    run(ctx.db, "UPDATE external_transfers SET payout_reference = ?, updated_at = ? WHERE id = ?", result.reference.slice(0, 64), nowIso(), id);
  }
  if (result.providerRef) {
    try {
      run(ctx.db, "UPDATE external_transfers SET provider_ref = ?, updated_at = ? WHERE id = ?", result.providerRef, nowIso(), id);
    } catch (err) {
      // Never let bookkeeping stop the settle/refund below: held funds must always resolve.
      console.error(`[payments] couldn't record provider reference for ${id}: ${(err as Error).message}`);
    }
  }
  if (result.status === "completed") settleWithdrawal(ctx, id);
  else if (result.status === "failed") reverseWithdrawal(ctx, id, result.failureReason ?? "Payout failed");

  const final = loadExternal(ctx, id);
  if (final.status === "failed") {
    throw new HttpError(422, "payout_failed", `Withdrawal failed and your money was returned: ${final.failure_reason}`, {
      transfer: externalView(final),
    });
  }
  return externalView(final);
}

/** Withdrawals waiting for a second person, oldest first. */
export function listPayoutReviews(ctx: Ctx) {
  return all<ExternalRow & { handle: string; email: string; display_name: string; kyc_level: number; account_number: string | null; user_created_at: string }>(
    ctx.db,
    `SELECT t.*, u.handle, u.email, u.display_name, u.kyc_level, u.account_number, u.created_at AS user_created_at
     FROM external_transfers t JOIN users u ON u.id = t.user_id
     WHERE t.direction = 'withdrawal' AND t.status = 'pending' AND t.review_status = 'required' ORDER BY t.created_at`,
  ).map((r) => ({
    ...externalView(r),
    reasons: JSON.parse(r.review_reasons ?? "[]") as string[],
    destinationName: r.destination ? (JSON.parse(r.destination) as PayoutDestination).name : null,
    user: { id: r.user_id, handle: r.handle, email: r.email, name: r.display_name, kycLevel: r.kyc_level, accountNumber: r.account_number, since: r.user_created_at },
  }));
}

function loadForReview(ctx: Ctx, adminId: string, id: string) {
  const ext = loadExternal(ctx, id);
  if (ext.direction !== "withdrawal" || ext.status !== "pending" || ext.review_status !== "required") {
    throw unprocessable("not_in_review", "This withdrawal isn't waiting for review");
  }
  if (ext.user_id === adminId) throw forbidden("Someone else must review your own withdrawal");
  return ext;
}

/** A second person approves a held withdrawal: it's sent to the payment provider now. */
export async function approvePayout(ctx: Ctx, adminId: string, id: string, note?: string) {
  loadForReview(ctx, adminId, id);
  const claimed = run(
    ctx.db,
    "UPDATE external_transfers SET review_status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ? AND review_status = 'required'",
    adminId,
    nowIso(),
    note?.trim().slice(0, 500) || null,
    nowIso(),
    id,
  );
  if (Number(claimed.changes) === 0) throw unprocessable("not_in_review", "Someone else already reviewed this withdrawal");
  return sendPayout(ctx, id).catch((err: unknown) => {
    if (err instanceof HttpError && err.code === "payout_failed") return externalView(loadExternal(ctx, id));
    throw err;
  });
}

/** A second person refuses a held withdrawal: the money goes back to the customer's wallet. */
export function rejectPayout(ctx: Ctx, adminId: string, id: string, note: string) {
  const ext = loadForReview(ctx, adminId, id);
  if (note.trim().length < 3) throw badRequest("Say why, for the customer");
  run(
    ctx.db,
    "UPDATE external_transfers SET review_status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?",
    adminId,
    nowIso(),
    note.trim().slice(0, 500),
    nowIso(),
    id,
  );
  reverseWithdrawal(ctx, id, `Not approved: ${note.trim().slice(0, 200)}`);
  addAlert(ctx, ext.user_id, "account", `Your withdrawal of ${ext.currency} ${fromMinor(ext.amount, ext.currency)} wasn't sent and the money is back in your wallet: ${note.trim().slice(0, 200)}`);
  return externalView(loadExternal(ctx, id));
}

export function settleWithdrawal(ctx: Ctx, externalId: string) {
  tx(ctx.db, () => {
    const ext = loadExternal(ctx, externalId);
    if (ext.direction !== "withdrawal" || ext.status !== "pending") return;
    postJournal(ctx, {
      kind: "withdrawal_settle",
      initiatorId: ext.user_id,
      metadata: { externalId: ext.id, rail: ext.rail },
      postings: [
        { accountId: systemAccount(ctx, "clearing", ext.currency).id, amount: -ext.amount, currency: ext.currency },
        { accountId: systemAccount(ctx, "external", ext.currency).id, amount: ext.amount, currency: ext.currency },
      ],
    });
    run(ctx.db, "UPDATE external_transfers SET status = 'completed', updated_at = ? WHERE id = ?", nowIso(), ext.id);
  });
}

export function reverseWithdrawal(ctx: Ctx, externalId: string, reason: string) {
  tx(ctx.db, () => {
    const ext = loadExternal(ctx, externalId);
    if (ext.direction !== "withdrawal" || ext.status !== "pending") return;
    postJournal(ctx, {
      kind: "withdrawal_reversal",
      initiatorId: ext.user_id,
      memo: "Withdrawal returned",
      metadata: { externalId: ext.id, rail: ext.rail, reason },
      postings: [
        { accountId: systemAccount(ctx, "clearing", ext.currency).id, amount: -ext.amount, currency: ext.currency },
        { accountId: systemAccount(ctx, "fees", ext.currency).id, amount: -ext.fee, currency: ext.currency },
        { accountId: userAccount(ctx, ext.user_id, ext.currency).id, amount: ext.amount + ext.fee, currency: ext.currency },
      ],
    });
    run(
      ctx.db,
      "UPDATE external_transfers SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
      reason.slice(0, 300),
      nowIso(),
      ext.id,
    );
  });
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------
export function listActivity(ctx: Ctx, userId: string, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const journals = all<JournalRow & { seq: number }>(
    ctx.db,
    `SELECT DISTINCT j.rowid AS seq, j.* FROM journals j
     JOIN entries e ON e.journal_id = j.id
     JOIN accounts a ON a.id = e.account_id
     WHERE a.owner_type = 'user' AND a.user_id = ? AND j.kind <> 'withdrawal_settle' AND (? IS NULL OR j.rowid < ?)
     ORDER BY j.rowid DESC LIMIT ?`,
    userId,
    opts.before ?? null,
    opts.before ?? null,
    limit,
  );
  if (journals.length === 0) return { items: [], nextCursor: null };

  const placeholders = journals.map(() => "?").join(",");
  const entries = ctx.db
    .prepare(
      `SELECT e.journal_id, e.amount, e.currency FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE a.owner_type = 'user' AND a.user_id = ? AND e.journal_id IN (${placeholders})`,
    )
    .all(userId, ...journals.map((j) => j.id)) as { journal_id: string; amount: number; currency: string }[];

  const profiles = new Map<string, ReturnType<typeof publicProfile>>();
  const profile = (id: string) => {
    if (!profiles.has(id)) profiles.set(id, publicProfile(getUserRow(ctx, id)));
    return profiles.get(id)!;
  };

  const items = journals.map((j) => {
    const meta = JSON.parse(j.metadata) as Record<string, unknown>;
    const mine = entries.filter((e) => e.journal_id === j.id);
    let counterparty = null;
    let direction: "in" | "out" | "internal" = "internal";
    if (j.kind === "transfer") {
      const outgoing = meta.from === userId;
      direction = outgoing ? "out" : "in";
      counterparty = profile(String(outgoing ? meta.to : meta.from));
    } else if (j.kind === "deposit" || j.kind === "withdrawal_reversal") direction = "in";
    else if (j.kind === "withdrawal") direction = "out";

    let status = "completed";
    if (typeof meta.externalId === "string" && j.kind === "withdrawal") {
      status = one<{ status: string }>(ctx.db, "SELECT status FROM external_transfers WHERE id = ?", meta.externalId)?.status ?? status;
    }
    return {
      id: j.id,
      kind: j.kind,
      memo: j.memo,
      direction,
      status,
      counterparty,
      amounts: mine.map((e) => ({ currency: e.currency, amount: fromMinor(e.amount, e.currency), amountMinor: e.amount })),
      fee: typeof meta.fee === "number" && meta.fee > 0 && typeof meta.currency === "string" ? fromMinor(meta.fee, meta.currency) : null,
      rate: typeof meta.rate === "number" ? meta.rate : null,
      createdAt: j.created_at,
    };
  });
  return { items, nextCursor: journals.length === limit ? journals[journals.length - 1].seq : null };
}
