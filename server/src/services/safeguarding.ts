import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { badRequest, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency, fromMinor, toMinor } from "../lib/money.js";
import { postJournal, systemAccount } from "./ledger.js";
import { notifyAdmins } from "./monitoring.js";
import { railFetch } from "./rails/http.js";
import { audit } from "./users.js";

/**
 * Safeguarding: customers' money must be kept apart from the business's own and be there in full.
 * Admins register where it actually sits (safeguarding bank accounts, mobile-money and provider
 * balances), record those balances from statements or fetch them from the provider, and a
 * reconciliation compares them, currency by currency, with what the ledger says Aurex owes:
 * every customer wallet plus withdrawals still in flight. A shortfall alerts every admin.
 */

export type Kind = "bank" | "mobile_money" | "payment_provider" | "custodian" | "other";
export type Source = "manual" | "stripe" | "wise" | "flutterwave" | "airtel";

interface AccountRow {
  id: string;
  name: string;
  kind: Kind;
  institution: string;
  currency: string;
  purpose: "safeguarding" | "operating";
  source: Source;
  details_enc: string | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface LatestBalance {
  balance_minor: number;
  as_of: string;
  source: "manual" | "api";
  note: string | null;
}

const latestBalance = (ctx: Ctx, accountId: string) =>
  one<LatestBalance>(ctx.db, "SELECT balance_minor, as_of, source, note FROM safeguarding_balances WHERE account_id = ? ORDER BY as_of DESC, id DESC LIMIT 1", accountId);

const staleMs = (ctx: Ctx) => ctx.config.SAFEGUARDING_STALE_HOURS * 3600_000;

function accountView(ctx: Ctx, a: AccountRow) {
  const bal = latestBalance(ctx, a.id);
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    institution: a.institution,
    currency: a.currency,
    purpose: a.purpose,
    source: a.source,
    active: a.active === 1,
    hasDetails: Boolean(a.details_enc),
    balance: bal ? fromMinor(bal.balance_minor, a.currency) : null,
    balanceAsOf: bal?.as_of ?? null,
    balanceSource: bal?.source ?? null,
    stale: !bal || Date.now() - Date.parse(bal.as_of) > staleMs(ctx),
    createdAt: a.created_at,
  };
}

export interface AccountInput {
  name: string;
  kind: Kind;
  institution: string;
  currency: string;
  purpose?: "safeguarding" | "operating";
  source?: Source;
  /** Account number, IBAN, paybill or wallet ID: stored encrypted. */
  details?: string;
}

export function createAccount(ctx: Ctx, adminId: string, input: AccountInput, ip?: string) {
  const currency = assertCurrency(input.currency).code;
  const id = newId("sfg");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO safeguarding_accounts (id, name, kind, institution, currency, purpose, source, details_enc, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    input.institution.trim(),
    currency,
    input.purpose ?? "safeguarding",
    input.source ?? "manual",
    input.details?.trim() ? encryptSecret(input.details.trim(), ctx.config.masterKey) : null,
    adminId,
    now,
    now,
  );
  audit(ctx, adminId, "safeguarding.account_added", { id, currency, purpose: input.purpose ?? "safeguarding", source: input.source ?? "manual" }, ip);
  return accountView(ctx, loadAccount(ctx, id));
}

function loadAccount(ctx: Ctx, id: string) {
  const a = one<AccountRow>(ctx.db, "SELECT * FROM safeguarding_accounts WHERE id = ?", id);
  if (!a) throw notFound("No such account");
  return a;
}

export function updateAccount(ctx: Ctx, adminId: string, id: string, patch: { name?: string; active?: boolean; details?: string | null; purpose?: "safeguarding" | "operating" }, ip?: string) {
  const a = loadAccount(ctx, id);
  run(
    ctx.db,
    "UPDATE safeguarding_accounts SET name = ?, active = ?, purpose = ?, details_enc = ?, updated_at = ? WHERE id = ?",
    patch.name?.trim() || a.name,
    patch.active === undefined ? a.active : patch.active ? 1 : 0,
    patch.purpose ?? a.purpose,
    patch.details === undefined ? a.details_enc : patch.details?.trim() ? encryptSecret(patch.details.trim(), ctx.config.masterKey) : null,
    nowIso(),
    id,
  );
  audit(ctx, adminId, "safeguarding.account_changed", { id, fields: Object.keys(patch) }, ip);
  return accountView(ctx, loadAccount(ctx, id));
}

/** The account's number or IBAN, decrypted for an admin. Each view is audited. */
export function accountDetails(ctx: Ctx, adminId: string, id: string, ip?: string) {
  const a = loadAccount(ctx, id);
  audit(ctx, adminId, "safeguarding.details_viewed", { id }, ip);
  return a.details_enc ? decryptSecret(a.details_enc, ctx.config.masterKey) : null;
}

/** Records a balance read from a statement (manual) or fetched from the provider (api). */
export function recordBalance(ctx: Ctx, by: string | null, accountId: string, balance: string, asOf: string, source: "manual" | "api", note?: string) {
  const a = loadAccount(ctx, accountId);
  const at = Date.parse(asOf);
  if (Number.isNaN(at)) throw badRequest("Give the date and time of the balance");
  if (at > Date.now() + 5 * 60_000) throw badRequest("The balance date is in the future");
  const minor = toMinor(balance, a.currency);
  run(
    ctx.db,
    "INSERT INTO safeguarding_balances (account_id, balance_minor, as_of, source, recorded_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    a.id,
    minor,
    new Date(at).toISOString(),
    source,
    by,
    note?.trim().slice(0, 300) || null,
    nowIso(),
  );
  if (by) audit(ctx, by, "safeguarding.balance_recorded", { id: a.id, currency: a.currency, balance: fromMinor(minor, a.currency) });
  return accountView(ctx, a);
}

export function balanceHistory(ctx: Ctx, accountId: string) {
  const a = loadAccount(ctx, accountId);
  return all<{ id: number; balance_minor: number; as_of: string; source: string; note: string | null; handle: string | null; created_at: string }>(
    ctx.db,
    `SELECT b.*, u.handle FROM safeguarding_balances b LEFT JOIN users u ON u.id = b.recorded_by WHERE b.account_id = ? ORDER BY b.as_of DESC, b.id DESC LIMIT 100`,
    a.id,
  ).map((b) => ({ id: b.id, balance: fromMinor(b.balance_minor, a.currency), asOf: b.as_of, source: b.source, note: b.note, recordedBy: b.handle, recordedAt: b.created_at }));
}

// ---------------------------------------------------------------------------
// Provider balances
// ---------------------------------------------------------------------------
/** Balances per currency held at a payment provider, in minor units. */
async function providerBalances(ctx: Ctx, source: Exclude<Source, "manual">): Promise<Map<string, number>> {
  const c = ctx.config;
  const out = new Map<string, number>();
  const add = (currency: string, value: string | number) => {
    const code = currency.toUpperCase();
    try {
      assertCurrency(code);
    } catch {
      return; // a currency Aurex doesn't hold wallets in
    }
    out.set(code, (out.get(code) ?? 0) + (typeof value === "number" && Number.isInteger(value) ? value : toMinor(String(value), code)));
  };
  if (source === "stripe") {
    if (!c.STRIPE_SECRET_KEY) throw unprocessable("not_configured", "Stripe isn't configured on this server");
    const res = await railFetch<{ available?: { amount: number; currency: string }[]; pending?: { amount: number; currency: string }[] }>(
      "Stripe",
      "https://api.stripe.com/v1/balance",
      { headers: { Authorization: `Bearer ${c.STRIPE_SECRET_KEY}` } },
    );
    if (!res.ok) throw unprocessable("provider_error", `Stripe answered ${res.status}`);
    // Stripe reports minor units already.
    for (const b of [...(res.json.available ?? []), ...(res.json.pending ?? [])]) add(b.currency, Math.trunc(b.amount));
  } else if (source === "flutterwave") {
    if (!c.FLUTTERWAVE_SECRET_KEY) throw unprocessable("not_configured", "Flutterwave isn't configured on this server");
    const res = await railFetch<{ data?: { currency: string; available_balance?: number; ledger_balance?: number }[] }>("Flutterwave", `${c.FLUTTERWAVE_BASE_URL}/balances`, {
      headers: { Authorization: `Bearer ${c.FLUTTERWAVE_SECRET_KEY}` },
    });
    if (!res.ok) throw unprocessable("provider_error", `Flutterwave answered ${res.status}`);
    for (const b of res.json.data ?? []) add(b.currency, String(b.ledger_balance ?? b.available_balance ?? 0));
  } else if (source === "wise") {
    if (!c.WISE_API_TOKEN || !c.WISE_PROFILE_ID) throw unprocessable("not_configured", "Wise isn't configured on this server");
    const base = c.WISE_BASE_URL ?? (c.WISE_ENV === "production" ? "https://api.wise.com/2026Q4" : "https://api.wise-sandbox.com/2026Q4");
    const res = await railFetch<{ currency?: string; amount?: { value: number; currency: string } }[]>(
      "Wise",
      `${base}/profiles/${encodeURIComponent(c.WISE_PROFILE_ID)}/balances?types=STANDARD`,
      { headers: { Authorization: `Bearer ${c.WISE_API_TOKEN}` } },
    );
    if (!res.ok || !Array.isArray(res.json)) throw unprocessable("provider_error", `Wise answered ${res.status}`);
    for (const b of res.json) if (b.amount) add(b.amount.currency ?? b.currency ?? "", String(b.amount.value));
  } else if (source === "airtel") {
    if (!c.AIRTEL_CLIENT_ID || !c.AIRTEL_CLIENT_SECRET) throw unprocessable("not_configured", "Airtel Money isn't configured on this server");
    const { airtelBalance } = await import("./rails/airtel.js");
    const b = await airtelBalance({
      baseUrl: c.AIRTEL_BASE_URL ?? (c.AIRTEL_ENV === "production" ? "https://openapi.airtel.africa" : "https://openapiuat.airtel.africa"),
      clientId: c.AIRTEL_CLIENT_ID,
      clientSecret: c.AIRTEL_CLIENT_SECRET,
      country: c.AIRTEL_COUNTRY,
      currency: c.AIRTEL_CURRENCY.toUpperCase(),
    });
    add(b.currency, b.balance);
  }
  return out;
}

/** Fetches the balance of every active account linked to a provider and records it. */
export async function refreshProviderBalances(ctx: Ctx) {
  const accounts = all<AccountRow>(ctx.db, "SELECT * FROM safeguarding_accounts WHERE active = 1 AND source <> 'manual'");
  const bySource = new Map<Exclude<Source, "manual">, AccountRow[]>();
  for (const a of accounts) bySource.set(a.source as Exclude<Source, "manual">, [...(bySource.get(a.source as Exclude<Source, "manual">) ?? []), a]);
  const results: { account: string; ok: boolean; message: string }[] = [];
  for (const [source, list] of bySource) {
    try {
      const balances = await providerBalances(ctx, source);
      for (const a of list) {
        const minor = balances.get(a.currency) ?? 0;
        recordBalance(ctx, null, a.id, fromMinor(minor, a.currency), nowIso(), "api", `Fetched from ${source}`);
        results.push({ account: a.name, ok: true, message: `${a.currency} ${fromMinor(minor, a.currency)}` });
      }
    } catch (err) {
      for (const a of list) results.push({ account: a.name, ok: false, message: (err as Error).message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Position and reconciliation
// ---------------------------------------------------------------------------
/** What Aurex owes customers per currency: wallet balances plus withdrawals not yet paid out. */
function owedByCurrency(ctx: Ctx) {
  const rows = all<{ currency: string; wallets: number; clearing: number }>(
    ctx.db,
    `SELECT currency,
            SUM(CASE WHEN owner_type = 'user' THEN balance ELSE 0 END) AS wallets,
            SUM(CASE WHEN owner_type = 'system' AND code = 'clearing' THEN balance ELSE 0 END) AS clearing
     FROM accounts GROUP BY currency`,
  );
  return new Map(rows.map((r) => [r.currency, { wallets: r.wallets, clearing: r.clearing }]));
}

/** Per currency: owed to customers, held in safeguarding, the difference and whether it's verified. */
export function safeguardingPosition(ctx: Ctx) {
  const owed = owedByCurrency(ctx);
  const accounts = all<AccountRow>(ctx.db, "SELECT * FROM safeguarding_accounts WHERE active = 1 AND purpose = 'safeguarding'");
  const currencies = new Set<string>([...[...owed.entries()].filter(([, o]) => o.wallets + o.clearing !== 0).map(([c]) => c), ...accounts.map((a) => a.currency)]);
  return [...currencies].sort().map((currency) => {
    const o = owed.get(currency) ?? { wallets: 0, clearing: 0 };
    const owedMinor = o.wallets + o.clearing;
    let held = 0;
    let stale = 0;
    let counted = 0;
    for (const a of accounts.filter((x) => x.currency === currency)) {
      const bal = latestBalance(ctx, a.id);
      if (!bal) {
        stale++;
        continue;
      }
      held += bal.balance_minor;
      counted++;
      if (Date.now() - Date.parse(bal.as_of) > staleMs(ctx)) stale++;
    }
    const difference = held - owedMinor;
    const status: "covered" | "shortfall" | "unverified" = counted === 0 || stale > 0 ? (difference < 0 && counted > 0 ? "shortfall" : "unverified") : difference < 0 ? "shortfall" : "covered";
    return {
      currency,
      owedMinor,
      heldMinor: held,
      differenceMinor: difference,
      owed: fromMinor(owedMinor, currency),
      wallets: fromMinor(o.wallets, currency),
      inFlight: fromMinor(o.clearing, currency),
      held: fromMinor(held, currency),
      difference: fromMinor(difference, currency),
      accounts: accounts.filter((x) => x.currency === currency).length,
      staleAccounts: stale,
      status,
    };
  });
}

/** Compares owed with held for every currency and stores the result; alerts admins to a shortfall. */
export function runReconciliation(ctx: Ctx, by: string | null) {
  const position = safeguardingPosition(ctx);
  const runAt = nowIso();
  for (const p of position) {
    run(
      ctx.db,
      `INSERT INTO reconciliations (id, run_at, run_by, currency, owed_minor, held_minor, difference_minor, status, stale_accounts, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("rec"),
      runAt,
      by,
      p.currency,
      p.owedMinor,
      p.heldMinor,
      p.differenceMinor,
      p.status,
      p.staleAccounts,
      JSON.stringify({ wallets: p.wallets, inFlight: p.inFlight, accounts: p.accounts }),
    );
  }
  const short = position.filter((p) => p.status === "shortfall");
  if (short.length) {
    notifyAdmins(
      ctx,
      `Safeguarding shortfall: ${short.map((p) => `${p.currency} ${fromMinor(-p.differenceMinor, p.currency)} short`).join(", ")}. Customers' money isn't fully covered; check Admin → Ledger & records → Safeguarding.`,
    );
  }
  if (by) audit(ctx, by, "safeguarding.reconciled", { currencies: position.length, shortfalls: short.length });
  return { runAt, position };
}

export function listReconciliations(ctx: Ctx, limit = 60) {
  return all<{ id: string; run_at: string; run_by: string | null; handle: string | null; currency: string; owed_minor: number; held_minor: number; difference_minor: number; status: string; stale_accounts: number }>(
    ctx.db,
    "SELECT r.*, u.handle FROM reconciliations r LEFT JOIN users u ON u.id = r.run_by ORDER BY r.run_at DESC, r.currency LIMIT ?",
    limit,
  ).map((r) => ({
    id: r.id,
    runAt: r.run_at,
    runBy: r.handle ?? "scheduled",
    currency: r.currency,
    owed: fromMinor(r.owed_minor, r.currency),
    held: fromMinor(r.held_minor, r.currency),
    difference: fromMinor(r.difference_minor, r.currency),
    status: r.status,
    staleAccounts: r.stale_accounts,
  }));
}

export function listAccounts(ctx: Ctx) {
  return all<AccountRow>(ctx.db, "SELECT * FROM safeguarding_accounts ORDER BY active DESC, currency, name").map((a) => accountView(ctx, a));
}

// ---------------------------------------------------------------------------
// Income and assets
// ---------------------------------------------------------------------------
/**
 * Records moving earned fees (or FX income) out of the safeguarded pool into the business's own
 * account, so the books keep matching the money actually held.
 */
export function sweepIncome(ctx: Ctx, adminId: string, from: "fees" | "fx", rawCurrency: string, amount: string, note: string, ip?: string) {
  const currency = assertCurrency(rawCurrency).code;
  const minor = toMinor(amount, currency);
  if (minor <= 0) throw badRequest("Amount must be greater than zero");
  const account = systemAccount(ctx, from, currency);
  if (account.balance < minor) throw unprocessable("insufficient_income", `Only ${currency} ${fromMinor(Math.max(0, account.balance), currency)} of ${from === "fees" ? "fee" : "FX"} income is available`);
  const journal = postJournal(ctx, {
    kind: "income_sweep",
    initiatorId: adminId,
    memo: note.trim().slice(0, 140) || `${from === "fees" ? "Fee" : "FX"} income moved to the operating account`,
    metadata: { from, amount: minor, currency },
    postings: [
      { accountId: account.id, amount: -minor, currency },
      { accountId: systemAccount(ctx, "external", currency).id, amount: minor, currency },
    ],
  });
  audit(ctx, adminId, "safeguarding.income_swept", { from, currency, amount: fromMinor(minor, currency), journal: journal.id }, ip);
  return { journalId: journal.id, currency, amount: fromMinor(minor, currency) };
}

/** Income earned and not yet swept, per currency. */
export function unsweptIncome(ctx: Ctx) {
  return all<{ code: string; currency: string; balance: number }>(ctx.db, "SELECT code, currency, balance FROM accounts WHERE owner_type = 'system' AND code IN ('fees','fx') AND balance <> 0 ORDER BY currency, code").map(
    (a) => ({ from: a.code as "fees" | "fx", currency: a.currency, amount: fromMinor(a.balance, a.currency) }),
  );
}

/** Who holds which of the customers' assets: what Aurex must safeguard and what others hold. */
export function customerAssets(ctx: Ctx) {
  const wallets = all<{ currency: string; total: number; holders: number }>(
    ctx.db,
    "SELECT currency, SUM(balance) AS total, SUM(CASE WHEN balance > 0 THEN 1 ELSE 0 END) AS holders FROM accounts WHERE owner_type = 'user' GROUP BY currency HAVING total <> 0 ORDER BY currency",
  );
  const brokerage = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM trading_accounts WHERE broker = 'alpaca'")!;
  const linked = one<{ n: number; users: number }>(ctx.db, "SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM linked_connections WHERE status = 'active'")!;
  const demo = one<{ cash: number | null; accounts: number }>(ctx.db, "SELECT SUM(cash_cents) AS cash, COUNT(*) AS accounts FROM trading_accounts WHERE broker = 'paper'")!;
  return {
    wallets: wallets.map((w) => ({ currency: w.currency, total: fromMinor(w.total, w.currency), holders: w.holders, custodian: "Aurex (safeguarded)" })),
    brokerageAccounts: { connected: brokerage.n, custodian: "Alpaca Securities (the customer's own account)" },
    linkedAccounts: { connections: linked.n, customers: linked.users, custodian: "The customer's own bank, broker or wallet (read-only)" },
    demo: { accounts: demo.accounts, virtualCash: fromMinor(demo.cash ?? 0, "USD"), custodian: "None: virtual money with no value" },
  };
}

/** Refreshes provider balances and reconciles every 6 hours. Started from index.ts (not in tests). */
export function startSafeguardingJob(ctx: Ctx, everyMs = 6 * 3600_000) {
  const tick = async () => {
    try {
      await refreshProviderBalances(ctx);
      if (one(ctx.db, "SELECT 1 FROM safeguarding_accounts WHERE active = 1 LIMIT 1")) runReconciliation(ctx, null);
    } catch (err) {
      console.error("[safeguarding]", err);
    }
  };
  const first = setTimeout(() => void tick(), 2 * 60_000);
  first.unref();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
