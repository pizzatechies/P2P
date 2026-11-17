import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { toCsv } from "../lib/csv.js";
import { badRequest, notFound } from "../lib/errors.js";
import { fromMinor } from "../lib/money.js";

/**
 * Reading the books: end-of-day snapshots, a trial balance for any day, a journal explorer and CSV
 * exports for accountants. Everything is derived from the immutable ledger entries, so any figure
 * here can be recomputed and checked.
 */

/** The kinds of ledger account, as an accountant would group them. */
export const GROUPS = ["customer", "external", "clearing", "fees", "fx"] as const;
export type Group = (typeof GROUPS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: string) => `${d}T00:00:00.000Z`;
const addDays = (d: string, n: number) => new Date(Date.parse(dayStart(d)) + n * 86_400_000).toISOString().slice(0, 10);
const todayUtc = () => new Date().toISOString().slice(0, 10);

const GROUP_SQL = "CASE WHEN a.owner_type = 'user' THEN 'customer' ELSE a.code END";

type Totals = Record<Group, number>;
const emptyTotals = (): Totals => ({ customer: 0, external: 0, clearing: 0, fees: 0, fx: 0 });

function assertDay(d: string, label = "date") {
  if (!DAY_RE.test(d) || Number.isNaN(Date.parse(dayStart(d)))) throw badRequest(`Use a ${label} like 2026-11-17`);
}

/** Balances by currency and account group at a moment (exclusive), from the entries. */
function balancesAsOf(ctx: Ctx, before: string) {
  const rows = all<{ currency: string; grp: Group; total: number }>(
    ctx.db,
    `SELECT e.currency, ${GROUP_SQL} AS grp, SUM(e.amount) AS total
     FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.created_at < ? GROUP BY e.currency, grp`,
    before,
  );
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const t = out.get(r.currency) ?? emptyTotals();
    if (r.grp in t) t[r.grp] += r.total;
    out.set(r.currency, t);
  }
  return out;
}

const sumTotals = (t: Totals) => GROUPS.reduce((s, g) => s + t[g], 0);

// ---------------------------------------------------------------------------
// End-of-day snapshots
// ---------------------------------------------------------------------------
/**
 * Writes a snapshot for every finished day that doesn't have one yet (up to `maxDays` per call), each
 * built from the previous day's closing totals plus that day's entries. Returns the days written.
 */
export function snapshotLedger(ctx: Ctx, maxDays = 400): string[] {
  const last = one<{ day: string | null }>(ctx.db, "SELECT MAX(day) AS day FROM ledger_snapshots")!.day;
  const firstEntry = one<{ at: string | null }>(ctx.db, "SELECT MIN(created_at) AS at FROM entries")!.at;
  if (!firstEntry) return [];
  let day = last ? addDays(last, 1) : firstEntry.slice(0, 10);
  const today = todayUtc();
  const written: string[] = [];
  // Opening totals: the closing totals of the day before.
  let closing = balancesAsOf(ctx, dayStart(day));
  while (day < today && written.length < maxDays) {
    const from = dayStart(day);
    const to = dayStart(addDays(day, 1));
    const moves = all<{ currency: string; grp: Group; total: number; credits: number }>(
      ctx.db,
      `SELECT e.currency, ${GROUP_SQL} AS grp, SUM(e.amount) AS total, SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END) AS credits
       FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.created_at >= ? AND e.created_at < ? GROUP BY e.currency, grp`,
      from,
      to,
    );
    const journals = all<{ currency: string; n: number }>(
      ctx.db,
      "SELECT currency, COUNT(DISTINCT journal_id) AS n FROM entries WHERE created_at >= ? AND created_at < ? GROUP BY currency",
      from,
      to,
    );
    const volume = new Map<string, number>();
    const next = new Map<string, Totals>();
    for (const [c, t] of closing) next.set(c, { ...t });
    for (const m of moves) {
      const t = next.get(m.currency) ?? emptyTotals();
      if (m.grp in t) t[m.grp] += m.total;
      next.set(m.currency, t);
      volume.set(m.currency, (volume.get(m.currency) ?? 0) + m.credits);
    }
    const journalCount = new Map(journals.map((j) => [j.currency, j.n]));
    tx(ctx.db, () => {
      for (const [currency, t] of next) {
        run(
          ctx.db,
          `INSERT OR IGNORE INTO ledger_snapshots (day, currency, customer_cents, external_cents, clearing_cents, fees_cents, fx_cents, journals, volume_cents, balanced, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          day,
          currency,
          t.customer,
          t.external,
          t.clearing,
          t.fees,
          t.fx,
          journalCount.get(currency) ?? 0,
          volume.get(currency) ?? 0,
          sumTotals(t) === 0 ? 1 : 0,
          nowIso(),
        );
      }
    });
    written.push(day);
    closing = next;
    day = addDays(day, 1);
  }
  return written;
}

/** Writes missing end-of-day snapshots now and then every hour. Started from index.ts (not in tests). */
export function startLedgerSnapshots(ctx: Ctx, everyMs = 60 * 60_000) {
  const tick = () => {
    try {
      const days = snapshotLedger(ctx);
      if (days.length) console.log(`[ledger] end-of-day snapshots written: ${days[0]}${days.length > 1 ? ` to ${days[days.length - 1]}` : ""}`);
    } catch (err) {
      console.error("[ledger] snapshot failed:", err);
    }
  };
  const first = setTimeout(tick, 5_000);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function ledgerSnapshots(ctx: Ctx, currency?: string, days = 90) {
  const rows = all<{
    day: string;
    currency: string;
    customer_cents: number;
    external_cents: number;
    clearing_cents: number;
    fees_cents: number;
    fx_cents: number;
    journals: number;
    volume_cents: number;
    balanced: number;
  }>(
    ctx.db,
    `SELECT * FROM ledger_snapshots WHERE day >= ? ${currency ? "AND currency = ?" : ""} ORDER BY day DESC, currency`,
    ...(currency ? [addDays(todayUtc(), -Math.min(days, 3660)), currency.toUpperCase()] : [addDays(todayUtc(), -Math.min(days, 3660))]),
  );
  return rows.map((r) => ({
    day: r.day,
    currency: r.currency,
    customerFunds: fromMinor(r.customer_cents, r.currency),
    external: fromMinor(r.external_cents, r.currency),
    clearing: fromMinor(r.clearing_cents, r.currency),
    fees: fromMinor(r.fees_cents, r.currency),
    fx: fromMinor(r.fx_cents, r.currency),
    journals: r.journals,
    volume: fromMinor(r.volume_cents, r.currency),
    balanced: r.balanced === 1,
  }));
}

/**
 * Recomputes stored snapshots from the entries and reports any that differ: a changed figure means
 * the ledger was altered after the day closed.
 */
export function verifySnapshots(ctx: Ctx, days = 31) {
  const stored = all<{ day: string; currency: string; customer_cents: number; external_cents: number; clearing_cents: number; fees_cents: number; fx_cents: number }>(
    ctx.db,
    "SELECT * FROM ledger_snapshots WHERE day >= ? ORDER BY day",
    addDays(todayUtc(), -days),
  );
  const byDay = new Map<string, Map<string, Totals>>();
  const mismatches: { day: string; currency: string; group: Group; stored: string; recomputed: string }[] = [];
  for (const s of stored) {
    let bal = byDay.get(s.day);
    if (!bal) {
      bal = balancesAsOf(ctx, dayStart(addDays(s.day, 1)));
      byDay.set(s.day, bal);
    }
    const t = bal.get(s.currency) ?? emptyTotals();
    const saved: Totals = { customer: s.customer_cents, external: s.external_cents, clearing: s.clearing_cents, fees: s.fees_cents, fx: s.fx_cents };
    for (const g of GROUPS) {
      if (saved[g] !== t[g]) mismatches.push({ day: s.day, currency: s.currency, group: g, stored: fromMinor(saved[g], s.currency), recomputed: fromMinor(t[g], s.currency) });
    }
  }
  return { checked: stored.length, ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------
/** Balances by currency and account group at the end of a day (or now). Every currency must sum to zero. */
export function trialBalance(ctx: Ctx, asOf?: string) {
  if (asOf) assertDay(asOf);
  const before = asOf ? dayStart(addDays(asOf, 1)) : "9999";
  const balances = balancesAsOf(ctx, before);
  const customers = all<{ currency: string; n: number }>(
    ctx.db,
    `SELECT e.currency, COUNT(*) AS n FROM (
       SELECT e.account_id, e.currency, SUM(e.amount) AS bal FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE a.owner_type = 'user' AND e.created_at < ? GROUP BY e.account_id
     ) e WHERE e.bal <> 0 GROUP BY e.currency`,
    before,
  );
  const holders = new Map(customers.map((c) => [c.currency, c.n]));
  const rows = [...balances.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      customerFunds: fromMinor(t.customer, currency),
      customersWithBalance: holders.get(currency) ?? 0,
      external: fromMinor(t.external, currency),
      clearing: fromMinor(t.clearing, currency),
      fees: fromMinor(t.fees, currency),
      fx: fromMinor(t.fx, currency),
      total: fromMinor(sumTotals(t), currency),
      balanced: sumTotals(t) === 0,
    }));
  return { asOf: asOf ?? null, generatedAt: nowIso(), balanced: rows.every((r) => r.balanced), rows };
}

export function trialBalanceCsv(tb: ReturnType<typeof trialBalance>) {
  return toCsv([
    [`Aurex trial balance ${tb.asOf ? `at end of ${tb.asOf} (UTC)` : `at ${tb.generatedAt}`}`],
    [],
    ["Currency", "Customer funds (owed to customers)", "Customers with a balance", "External (money in/out)", "Clearing (in flight)", "Fees", "FX", "Total (must be 0)"],
    ...tb.rows.map((r) => [r.currency, r.customerFunds, r.customersWithBalance, r.external, r.clearing, r.fees, r.fx, r.total]),
  ]);
}

// ---------------------------------------------------------------------------
// Journal explorer
// ---------------------------------------------------------------------------
export interface JournalQuery {
  kind?: string;
  from?: string;
  to?: string;
  userId?: string;
  currency?: string;
  /** A journal id, an external transfer id or a provider reference. */
  q?: string;
  before?: string;
  limit?: number;
}

function journalWhere(ctx: Ctx, q: JournalQuery) {
  const where: string[] = [];
  const params: string[] = [];
  if (q.kind) {
    where.push("j.kind = ?");
    params.push(q.kind);
  }
  if (q.from) {
    assertDay(q.from, "start date");
    where.push("j.created_at >= ?");
    params.push(dayStart(q.from));
  }
  if (q.to) {
    assertDay(q.to, "end date");
    where.push("j.created_at < ?");
    params.push(dayStart(addDays(q.to, 1)));
  }
  if (q.userId) {
    where.push("(j.initiator_id = ? OR EXISTS (SELECT 1 FROM entries e2 JOIN accounts a2 ON a2.id = e2.account_id WHERE e2.journal_id = j.id AND a2.user_id = ?))");
    params.push(q.userId, q.userId);
  }
  if (q.currency) {
    where.push("EXISTS (SELECT 1 FROM entries e3 WHERE e3.journal_id = j.id AND e3.currency = ?)");
    params.push(q.currency.toUpperCase());
  }
  if (q.q) {
    const term = q.q.trim();
    const ext = one<{ journal_id: string | null }>(
      ctx.db,
      "SELECT journal_id FROM external_transfers WHERE id = ? OR provider_ref = ? OR payout_reference = ? LIMIT 1",
      term,
      term,
      term,
    );
    where.push("(j.id = ? OR j.id = ? OR j.metadata LIKE ?)");
    params.push(term, ext?.journal_id ?? "", `%"externalId":"${term.replace(/[%_"\\]/g, "")}"%`);
  }
  if (q.before) {
    where.push("j.created_at < ?");
    params.push(q.before);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

interface JournalRow {
  id: string;
  kind: string;
  memo: string | null;
  initiator_id: string | null;
  metadata: string;
  created_at: string;
}

/** Journals newest first, each with the amount moved per currency and the customers involved. */
export function listJournals(ctx: Ctx, q: JournalQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const w = journalWhere(ctx, q);
  const rows = all<JournalRow>(ctx.db, `SELECT j.* FROM journals j ${w.sql} ORDER BY j.created_at DESC, j.id DESC LIMIT ${limit + 1}`, ...w.params);
  const page = rows.slice(0, limit);
  const journals = page.map((j) => {
    const amounts = all<{ currency: string; moved: number }>(
      ctx.db,
      "SELECT currency, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS moved FROM entries WHERE journal_id = ? GROUP BY currency",
      j.id,
    );
    const parties = all<{ id: string; handle: string }>(
      ctx.db,
      "SELECT DISTINCT u.id, u.handle FROM entries e JOIN accounts a ON a.id = e.account_id JOIN users u ON u.id = a.user_id WHERE e.journal_id = ?",
      j.id,
    );
    return {
      id: j.id,
      kind: j.kind,
      memo: j.memo,
      createdAt: j.created_at,
      amounts: amounts.map((a) => ({ currency: a.currency, amount: fromMinor(a.moved, a.currency) })),
      customers: parties,
    };
  });
  const kinds = all<{ kind: string }>(ctx.db, "SELECT DISTINCT kind FROM journals ORDER BY kind").map((k) => k.kind);
  return { journals, kinds, nextBefore: rows.length > limit ? page[page.length - 1].created_at : null };
}

/** One journal with its entries (each with the account's balance after it) and what it belongs to. */
export function journalDetail(ctx: Ctx, id: string) {
  const j = one<JournalRow>(ctx.db, "SELECT * FROM journals WHERE id = ?", id);
  if (!j) throw notFound("No such journal");
  const entries = all<{
    id: number;
    account_id: string;
    amount: number;
    currency: string;
    created_at: string;
    owner_type: "user" | "system";
    code: string | null;
    user_id: string | null;
    handle: string | null;
    display_name: string | null;
    account_number: string | null;
    balance_after: number;
  }>(
    ctx.db,
    `SELECT e.id, e.account_id, e.amount, e.currency, e.created_at, a.owner_type, a.code, a.user_id, u.handle, u.display_name, u.account_number,
            (SELECT SUM(e2.amount) FROM entries e2 WHERE e2.account_id = e.account_id AND e2.id <= e.id) AS balance_after
     FROM entries e JOIN accounts a ON a.id = e.account_id LEFT JOIN users u ON u.id = a.user_id
     WHERE e.journal_id = ? ORDER BY e.id`,
    id,
  );
  const sums = new Map<string, number>();
  for (const e of entries) sums.set(e.currency, (sums.get(e.currency) ?? 0) + e.amount);
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(j.metadata);
  } catch {
    /* leave empty */
  }
  const external = one<{ id: string; direction: string; rail: string; status: string; provider_ref: string | null; user_id: string }>(
    ctx.db,
    "SELECT id, direction, rail, status, provider_ref, user_id FROM external_transfers WHERE journal_id = ? OR id = ?",
    id,
    typeof metadata.externalId === "string" ? metadata.externalId : "",
  );
  const request = one<{ id: string; status: string }>(ctx.db, "SELECT id, status FROM payment_requests WHERE journal_id = ?", id);
  const initiator = j.initiator_id ? one<{ id: string; handle: string }>(ctx.db, "SELECT id, handle FROM users WHERE id = ?", j.initiator_id) : undefined;
  return {
    id: j.id,
    kind: j.kind,
    memo: j.memo,
    createdAt: j.created_at,
    initiator: initiator ?? null,
    metadata,
    balanced: [...sums.values()].every((v) => v === 0),
    entries: entries.map((e) => ({
      id: e.id,
      account:
        e.owner_type === "user"
          ? { kind: "customer" as const, userId: e.user_id, handle: e.handle, name: e.display_name, accountNumber: e.account_number }
          : { kind: e.code as Group, userId: null, handle: null, name: null, accountNumber: null },
      currency: e.currency,
      amount: fromMinor(e.amount, e.currency),
      balanceAfter: fromMinor(e.balance_after, e.currency),
      createdAt: e.created_at,
    })),
    externalTransfer: external
      ? { id: external.id, direction: external.direction, rail: external.rail, status: external.status, providerRef: external.provider_ref, userId: external.user_id }
      : null,
    paymentRequest: request ?? null,
  };
}

/** Every ledger entry in a date range, one row per entry, for accounting software. */
export function entriesCsv(ctx: Ctx, from: string, to: string, kind?: string) {
  assertDay(from, "start date");
  assertDay(to, "end date");
  if (to < from) throw badRequest("The end date is before the start date");
  if (Date.parse(dayStart(to)) - Date.parse(dayStart(from)) > 366 * 86_400_000) throw badRequest("Export at most a year at a time");
  const rows = all<{
    created_at: string;
    journal_id: string;
    kind: string;
    memo: string | null;
    entry_id: number;
    owner_type: string;
    code: string | null;
    handle: string | null;
    account_number: string | null;
    currency: string;
    amount: number;
  }>(
    ctx.db,
    `SELECT e.created_at, e.journal_id, j.kind, j.memo, e.id AS entry_id, a.owner_type, a.code, u.handle, u.account_number, e.currency, e.amount
     FROM entries e JOIN journals j ON j.id = e.journal_id JOIN accounts a ON a.id = e.account_id LEFT JOIN users u ON u.id = a.user_id
     WHERE e.created_at >= ? AND e.created_at < ? ${kind ? "AND j.kind = ?" : ""} ORDER BY e.id LIMIT 200000`,
    ...(kind ? [dayStart(from), dayStart(addDays(to, 1)), kind] : [dayStart(from), dayStart(addDays(to, 1))]),
  );
  return toCsv([
    ["Date (UTC)", "Journal", "Kind", "Memo", "Entry", "Account", "Customer handle", "Account number", "Currency", "Debit", "Credit"],
    ...rows.map((r) => [
      r.created_at.replace("T", " ").slice(0, 19),
      r.journal_id,
      r.kind,
      r.memo ?? "",
      r.entry_id,
      r.owner_type === "user" ? "customer" : r.code,
      r.handle ?? "",
      r.account_number ?? "",
      r.currency,
      r.amount < 0 ? fromMinor(-r.amount, r.currency) : "",
      r.amount > 0 ? fromMinor(r.amount, r.currency) : "",
    ]),
  ]);
}
