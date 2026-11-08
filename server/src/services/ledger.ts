import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency } from "../lib/money.js";

/**
 * Double-entry ledger.
 *
 * Every movement of money is a journal made of signed entries. For each currency in a journal
 * the entries sum to exactly zero, so money is never created or destroyed - only moved between
 * accounts. Account balances are a cached sum of their entries, updated in the same transaction
 * and protected by a CHECK constraint so non-negative accounts can never be overdrawn.
 *
 * System accounts:
 *   external  - the outside world (cards, banks, mobile money). Goes negative as money flows in.
 *   clearing  - withdrawals in flight, held until the payment rail confirms.
 *   fees      - revenue from fees.
 *   fx        - the house side of currency conversions.
 */
export type SystemAccountCode = "external" | "clearing" | "fees" | "fx";

export interface Posting {
  accountId: string;
  /** Signed minor units: positive credits the account, negative debits it. */
  amount: number;
  currency: string;
}

export interface JournalInput {
  kind: string;
  memo?: string | null;
  initiatorId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  postings: Posting[];
}

export interface AccountRow {
  id: string;
  owner_type: "user" | "system";
  user_id: string | null;
  code: string | null;
  currency: string;
  balance: number;
  allow_negative: number;
}

export interface JournalRow {
  id: string;
  kind: string;
  memo: string | null;
  initiator_id: string | null;
  idempotency_key: string | null;
  metadata: string;
  created_at: string;
}

export class InsufficientFundsError extends HttpError {
  constructor(currency: string) {
    super(422, "insufficient_funds", `Not enough ${currency} in your wallet`);
  }
}

export function userAccount(ctx: Ctx, userId: string, currency: string): AccountRow {
  const ccy = assertCurrency(currency).code;
  const existing = one<AccountRow>(
    ctx.db,
    "SELECT * FROM accounts WHERE owner_type = 'user' AND user_id = ? AND currency = ?",
    userId,
    ccy,
  );
  if (existing) return existing;
  const id = newId("acct");
  run(
    ctx.db,
    "INSERT INTO accounts (id, owner_type, user_id, currency, allow_negative, created_at) VALUES (?, 'user', ?, ?, 0, ?)",
    id,
    userId,
    ccy,
    nowIso(),
  );
  return one<AccountRow>(ctx.db, "SELECT * FROM accounts WHERE id = ?", id)!;
}

export function systemAccount(ctx: Ctx, code: SystemAccountCode, currency: string): AccountRow {
  const ccy = assertCurrency(currency).code;
  const existing = one<AccountRow>(
    ctx.db,
    "SELECT * FROM accounts WHERE owner_type = 'system' AND code = ? AND currency = ?",
    code,
    ccy,
  );
  if (existing) return existing;
  const id = newId("acct");
  const allowNegative = code === "external" || code === "fx" ? 1 : 0;
  run(
    ctx.db,
    "INSERT INTO accounts (id, owner_type, code, currency, allow_negative, created_at) VALUES (?, 'system', ?, ?, ?, ?)",
    id,
    code,
    ccy,
    allowNegative,
    nowIso(),
  );
  return one<AccountRow>(ctx.db, "SELECT * FROM accounts WHERE id = ?", id)!;
}

export function findJournalByIdempotencyKey(ctx: Ctx, initiatorId: string, key: string) {
  return one<JournalRow>(ctx.db, "SELECT * FROM journals WHERE initiator_id = ? AND idempotency_key = ?", initiatorId, key);
}

/** Atomically posts a balanced journal. Throws InsufficientFundsError if any guarded account would go negative. */
export function postJournal(ctx: Ctx, input: JournalInput): JournalRow {
  const postings = input.postings.filter((p) => p.amount !== 0);
  if (postings.length < 2) throw new Error("A journal needs at least two non-zero postings");

  const sums = new Map<string, number>();
  for (const p of postings) {
    if (!Number.isSafeInteger(p.amount)) throw new Error(`Posting amount must be an integer, got ${p.amount}`);
    sums.set(p.currency, (sums.get(p.currency) ?? 0) + p.amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0) throw new Error(`Unbalanced journal: ${currency} entries sum to ${sum}`);
  }

  return tx(ctx.db, () => {
    const id = newId("txn");
    const createdAt = nowIso();
    run(
      ctx.db,
      `INSERT INTO journals (id, kind, memo, initiator_id, idempotency_key, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.memo ?? null,
      input.initiatorId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    );

    // Apply debits before credits so a failure surfaces on the paying account.
    const ordered = [...postings].sort((a, b) => a.amount - b.amount);
    for (const p of ordered) {
      const account = one<AccountRow>(ctx.db, "SELECT * FROM accounts WHERE id = ?", p.accountId);
      if (!account) throw new Error(`Unknown account ${p.accountId}`);
      if (account.currency !== p.currency) {
        throw new Error(`Currency mismatch: account ${account.id} is ${account.currency}, posting is ${p.currency}`);
      }
      const updated = run(
        ctx.db,
        "UPDATE accounts SET balance = balance + ? WHERE id = ? AND (allow_negative = 1 OR balance + ? >= 0)",
        p.amount,
        p.accountId,
        p.amount,
      );
      if (Number(updated.changes) !== 1) throw new InsufficientFundsError(p.currency);
      run(
        ctx.db,
        "INSERT INTO entries (journal_id, account_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        p.accountId,
        p.amount,
        p.currency,
        createdAt,
      );
    }
    return one<JournalRow>(ctx.db, "SELECT * FROM journals WHERE id = ?", id)!;
  });
}

export function getBalances(ctx: Ctx, userId: string) {
  return all<{ currency: string; balance: number }>(
    ctx.db,
    "SELECT currency, balance FROM accounts WHERE owner_type = 'user' AND user_id = ? ORDER BY currency",
    userId,
  );
}

export function getBalance(ctx: Ctx, userId: string, currency: string): number {
  return (
    one<{ balance: number }>(
      ctx.db,
      "SELECT balance FROM accounts WHERE owner_type = 'user' AND user_id = ? AND currency = ?",
      userId,
      currency,
    )?.balance ?? 0
  );
}

/**
 * Full consistency check: every journal balances per currency, and every cached balance equals
 * the sum of its entries. Exposed to admins and run in tests.
 */
export function verifyLedger(ctx: Ctx) {
  const unbalanced = all<{ journal_id: string; currency: string; total: number }>(
    ctx.db,
    "SELECT journal_id, currency, SUM(amount) AS total FROM entries GROUP BY journal_id, currency HAVING total <> 0",
  );
  const drift = all<{ id: string; balance: number; computed: number }>(
    ctx.db,
    `SELECT a.id, a.balance, COALESCE(SUM(e.amount), 0) AS computed
     FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
     GROUP BY a.id HAVING a.balance <> computed`,
  );
  const totals = all<{ currency: string; total: number }>(
    ctx.db,
    "SELECT currency, SUM(balance) AS total FROM accounts GROUP BY currency HAVING total <> 0",
  );
  return { ok: unbalanced.length === 0 && drift.length === 0 && totals.length === 0, unbalanced, drift, totals };
}
