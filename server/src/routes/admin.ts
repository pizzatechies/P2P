import { Router } from "express";
import { listBusinessApplications, readBusinessDocument, reviewBusiness } from "../services/business.js";
import { cancelRequest, decideRequest, listRequests, requestChange } from "../services/approvals.js";
import { assignCase, complaintsReport, listCases, OUTCOMES, openSupportCount, resolveCase, staffCaseDetail, staffReply } from "../services/support.js";
import { toCsv } from "../lib/csv.js";
import { comp as compPro } from "../services/pro.js";
import { createInvite, inviteFromWaitlist, listInvites, listWaitlist, revokeInvite, signupStatus } from "../services/beta.js";
import { listStatus, refreshSanctionsLists, screenName } from "../services/sanctions.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all, one, run } from "../db/index.js";
import { HttpError, notFound } from "../lib/errors.js";
import { fromMinor } from "../lib/money.js";
import { parse } from "../lib/validate.js";
import { requireAdmin, requireRecentAuth } from "../middleware/auth.js";
import { listApplications, reviewApplication } from "../services/upgrade.js";
import { reopenAccount } from "../services/account.js";
import { documentHeaders, limitsFor, listSubmissions, readDocument, reviewSubmission, setLevel } from "../services/kyc.js";
import { getUserRow } from "../services/users.js";
import { verifyLedger } from "../services/ledger.js";
import { recentIntegrity, verifyIntegrity } from "../services/integrity.js";
import { securityPosture } from "../services/posture.js";
import { addAlert } from "../services/security.js";
import {
  entriesCsv,
  journalDetail,
  ledgerSnapshots,
  listJournals,
  snapshotLedger,
  trialBalance,
  trialBalanceCsv,
  verifySnapshots,
} from "../services/ledgerData.js";
import { rateLimit } from "../lib/rateLimit.js";
import { listAlerts, reviewAlert } from "../services/monitoring.js";
import { approvePayout, listPayoutReviews, rejectPayout } from "../services/payments.js";
import {
  accountDetails,
  balanceHistory,
  createAccount,
  customerAssets,
  listAccounts,
  listReconciliations,
  recordBalance,
  refreshProviderBalances,
  runReconciliation,
  safeguardingPosition,
  sweepIncome,
  unsweptIncome,
  updateAccount,
} from "../services/safeguarding.js";
import { tradeHistory, tradingActivity, verifyTradingRecords } from "../services/trading/records.js";
import { audit } from "../services/users.js";

export function adminRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAdmin(ctx));

  r.get("/overview", (_req, res) => {
    const users = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users")!.n;
    const journals = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM journals")!.n;
    const system = all<{ code: string; currency: string; balance: number }>(
      ctx.db,
      "SELECT code, currency, balance FROM accounts WHERE owner_type = 'system' ORDER BY code, currency",
    ).map((a) => ({ ...a, balance: fromMinor(a.balance, a.currency) }));
    const customerFunds = all<{ currency: string; total: number }>(
      ctx.db,
      "SELECT currency, SUM(balance) AS total FROM accounts WHERE owner_type = 'user' GROUP BY currency",
    ).map((a) => ({ currency: a.currency, total: fromMinor(a.total, a.currency) }));
    const pendingPayouts = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM external_transfers WHERE status = 'pending' AND review_status = 'required'")!.n;
    const openAlerts = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM compliance_alerts WHERE status = 'open'")!.n;
    const openSupport = openSupportCount(ctx);
    const safeguarding = safeguardingPosition(ctx).map((p) => ({ currency: p.currency, status: p.status, difference: p.difference }));
    res.json({
      users,
      journals,
      systemAccounts: system,
      customerFunds,
      ledger: verifyLedger(ctx),
      tradingRecords: verifyTradingRecords(ctx),
      integrity: recentIntegrity(ctx),
      pendingPayouts,
      openAlerts,
      openSupport,
      safeguarding,
    });
  });

  /** The security checklist: what's protected and what still needs doing. */
  r.get("/security", (_req, res) => {
    res.json(securityPosture(ctx));
  });

  /** Verifies the sealed chains (ledger and audit log) right now. */
  r.post("/integrity/verify", (req, res) => {
    const result = verifyIntegrity(ctx);
    audit(ctx, req.user!.id, "admin.integrity_verified", { ok: result.ok }, req.ip);
    res.json({ integrity: result });
  });

  // ---- The books: journals, trial balance, end-of-day snapshots, exports ----
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use dates like 2026-11-17");
  const exportLimiter = rateLimit({ name: "admin-export", windowMs: 60 * 60_000, max: ctx.config.isTest ? 10_000 : 20, key: (req) => req.user!.id });
  const JournalQuery = z.object({
    kind: z.string().trim().max(40).optional(),
    from: day.optional(),
    to: day.optional(),
    user: z.string().trim().max(64).optional(),
    currency: z.string().trim().length(3).optional(),
    q: z.string().trim().max(100).optional(),
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  r.get("/ledger/journals", (req, res) => {
    const q = parse(JournalQuery, req.query);
    res.json(listJournals(ctx, { ...q, userId: q.user }));
  });

  r.get("/ledger/journals/:id", (req, res) => {
    res.json({ journal: journalDetail(ctx, String(req.params.id)) });
  });

  r.get("/ledger/trial-balance", (req, res) => {
    const { asOf, format } = parse(z.object({ asOf: day.optional(), format: z.enum(["json", "csv"]).optional() }), req.query);
    const tb = trialBalance(ctx, asOf);
    if (format === "csv") {
      audit(ctx, req.user!.id, "admin.ledger_exported", { report: "trial_balance", asOf: asOf ?? null }, req.ip);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aurex-trial-balance-${asOf ?? new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(trialBalanceCsv(tb));
      return;
    }
    res.json({ trialBalance: tb });
  });

  r.get("/ledger/snapshots", (req, res) => {
    const { currency, days } = parse(z.object({ currency: z.string().trim().length(3).optional(), days: z.coerce.number().int().min(1).max(3660).optional() }), req.query);
    snapshotLedger(ctx); // bring it up to yesterday first
    res.json({ snapshots: ledgerSnapshots(ctx, currency, days ?? 90), verification: verifySnapshots(ctx) });
  });

  /** Every ledger entry in a date range as CSV, for accounting software. Exports are audited. */
  r.get("/ledger/export", exportLimiter, requireRecentAuth(ctx), (req, res) => {
    const { from, to, kind } = parse(z.object({ from: day, to: day, kind: z.string().trim().max(40).optional() }), req.query);
    const csv = entriesCsv(ctx, from, to, kind);
    audit(ctx, req.user!.id, "admin.ledger_exported", { report: "entries", from, to, kind: kind ?? null }, req.ip);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="aurex-ledger-${from}-to-${to}.csv"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(csv);
  });

  // ---- Withdrawals waiting for a second person ----
  r.get("/payouts", (_req, res) => {
    res.json({ payouts: listPayoutReviews(ctx) });
  });

  r.post("/payouts/:id/approve", requireRecentAuth(ctx), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    const transfer = await approvePayout(ctx, req.user!.id, String(req.params.id), note);
    audit(ctx, req.user!.id, "payout.approved", { id: req.params.id, status: transfer.status }, req.ip);
    res.json({ transfer });
  });

  r.post("/payouts/:id/reject", requireRecentAuth(ctx), (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().min(3).max(500) }), req.body);
    const transfer = rejectPayout(ctx, req.user!.id, String(req.params.id), note);
    audit(ctx, req.user!.id, "payout.rejected", { id: req.params.id }, req.ip);
    res.json({ transfer });
  });

  // ---- Help and complaints ----
  r.get("/support/cases", (req, res) => {
    const q = parse(z.object({ status: z.enum(["active", "open", "waiting_customer", "resolved", "all"]).optional(), complaints: z.enum(["1", "0"]).optional() }), req.query);
    res.json({ cases: listCases(ctx, { status: q.status, complaints: q.complaints === "1" }), open: openSupportCount(ctx) });
  });

  r.get("/support/cases/:id", (req, res) => {
    res.json(staffCaseDetail(ctx, String(req.params.id)));
  });

  r.post("/support/cases/:id/messages", async (req, res) => {
    const body = parse(z.object({ body: z.string().trim().min(2).max(5000), internal: z.boolean().optional() }), req.body);
    res.json(await staffReply(ctx, req.user!.id, String(req.params.id), body.body, body.internal ?? false, req.ip));
  });

  r.post("/support/cases/:id/assign", (req, res) => {
    const { toSelf } = parse(z.object({ toSelf: z.boolean() }), req.body);
    res.json(assignCase(ctx, req.user!.id, String(req.params.id), toSelf, req.ip));
  });

  r.post("/support/cases/:id/resolve", async (req, res) => {
    const body = parse(z.object({ resolution: z.string().trim().min(5).max(3000), outcome: z.enum(OUTCOMES).optional() }), req.body);
    res.json(await resolveCase(ctx, req.user!.id, String(req.params.id), body.resolution, body.outcome, req.ip));
  });

  /** Complaints statistics and log for a period: ?from=2026-10-01&to=2026-12-31[&format=csv]. */
  r.get("/support/report", (req, res) => {
    const q = parse(z.object({ from: day, to: day, format: z.enum(["json", "csv"]).optional() }), req.query);
    const report = complaintsReport(ctx, q.from, q.to);
    if (q.format === "csv") {
      audit(ctx, req.user!.id, "admin.complaints_exported", { from: q.from, to: q.to }, req.ip);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aurex-complaints-${q.from}-to-${q.to}.csv"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(
        toCsv([
          ["Reference", "Received", "Customer", "Category", "Subject", "Status", "Outcome", "Due", "Resolved", "Days to resolve", "Within deadline"],
          ...report.log.map((l) => [l.reference, l.received, l.customer, l.category, l.subject, l.status, l.outcome ?? "", l.due ?? "", l.resolved ?? "", l.daysToResolve ?? "", l.withinDeadline === null ? "" : l.withinDeadline ? "yes" : "no"]),
        ]),
      );
      return;
    }
    res.json({ report });
  });

  // ---- Business accounts ----
  r.get("/businesses", (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["pending", "all"]).optional() }), req.query);
    res.json({ applications: listBusinessApplications(ctx, status ?? "pending"), feeBps: ctx.config.MERCHANT_FEE_BPS });
  });

  /** A business's document, decrypted for review. Every view is audited. */
  r.get("/businesses/documents/:id", (req, res) => {
    const doc = readBusinessDocument(ctx, String(req.params.id));
    audit(ctx, req.user!.id, "admin.business_document_viewed", { documentId: req.params.id, target: doc.userId, kind: doc.kind }, req.ip);
    res.set(documentHeaders(doc));
    res.send(doc.bytes);
  });

  r.post("/businesses/:userId/review", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }), req.body);
    reviewBusiness(ctx, req.user!.id, String(req.params.userId), body.decision, body.note, req.ip);
    res.json({ ok: true });
  });

  // ---- Beta access: invites and the waitlist ----
  r.get("/beta", (_req, res) => {
    res.json({ ...signupStatus(ctx), maxUsers: ctx.config.MAX_USERS, customers: one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'")!.n, invites: listInvites(ctx), waitlist: listWaitlist(ctx) });
  });

  r.post("/beta/invites", (req, res) => {
    const body = parse(z.object({ label: z.string().trim().max(80).optional(), maxUses: z.coerce.number().int().min(1).max(1000).optional(), expiresInDays: z.coerce.number().int().min(1).max(365).optional() }), req.body ?? {});
    res.status(201).json(createInvite(ctx, req.user!.id, body, req.ip));
  });

  r.post("/beta/invites/:id/revoke", (req, res) => {
    revokeInvite(ctx, req.user!.id, String(req.params.id), req.ip);
    res.json({ ok: true });
  });

  r.post("/beta/waitlist/:id/invite", async (req, res) => {
    res.status(201).json(await inviteFromWaitlist(ctx, req.user!.id, String(req.params.id), req.ip));
  });

  // ---- Sanctions screening ----
  r.get("/sanctions", (_req, res) => {
    const open = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM compliance_alerts WHERE rule = 'sanctions_match' AND status = 'open'")!.n;
    const checks = one<{ n: number; matches: number }>(ctx.db, "SELECT COUNT(*) AS n, SUM(result = 'possible_match') AS matches FROM sanctions_checks")!;
    res.json({ enabled: ctx.config.SANCTIONS_SCREENING, lists: listStatus(ctx), openMatches: open, checks: checks.n, possibleMatches: checks.matches ?? 0 });
  });

  r.post("/sanctions/refresh", async (req, res) => {
    const out = await refreshSanctionsLists(ctx);
    audit(ctx, req.user!.id, "sanctions.refreshed", { results: out.results.map((r) => ({ list: r.list, ok: r.ok, entries: r.entries })) }, req.ip);
    res.json({ ...out, lists: listStatus(ctx) });
  });

  /** Check a name by hand, e.g. a new business partner. Each check is audited (without the name). */
  r.post("/sanctions/check", (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(200), birthYear: z.coerce.number().int().min(1900).max(2100).optional(), includeEntities: z.boolean().optional() }), req.body);
    const matches = screenName(ctx, body.name, { birthYear: body.birthYear, kinds: body.includeEntities ? ["individual", "entity"] : ["individual"], threshold: 0.8 });
    audit(ctx, req.user!.id, "sanctions.manual_check", { matches: matches.length }, req.ip);
    res.json({ matches });
  });

  // ---- Transaction monitoring ----
  r.get("/compliance", (req, res) => {
    const { status, user } = parse(z.object({ status: z.enum(["open", "cleared", "escalated", "all"]).optional(), user: z.string().max(64).optional() }), req.query);
    res.json({ alerts: listAlerts(ctx, status ?? "open", user) });
  });

  r.post("/compliance/:id", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ action: z.enum(["clear", "escalate"]), note: z.string().trim().min(3).max(1000), freeze: z.boolean().optional() }), req.body);
    res.json({ alert: reviewAlert(ctx, req.user!.id, String(req.params.id), body.action, body.note, body.freeze ?? false, req.ip) });
  });

  // ---- Safeguarding: where customers' money is held, and whether it's all there ----
  const money = z.string().trim().regex(/^-?\d+(\.\d{1,8})?$/, "Use a plain number like 1250.50");
  r.get("/safeguarding", (_req, res) => {
    res.json({
      position: safeguardingPosition(ctx).map(({ owedMinor: _o, heldMinor: _h, differenceMinor: _d, ...p }) => p),
      accounts: listAccounts(ctx),
      reconciliations: listReconciliations(ctx),
      income: unsweptIncome(ctx),
      assets: customerAssets(ctx),
      staleAfterHours: ctx.config.SAFEGUARDING_STALE_HOURS,
    });
  });

  r.post("/safeguarding/accounts", requireRecentAuth(ctx), (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        kind: z.enum(["bank", "mobile_money", "payment_provider", "custodian", "other"]),
        institution: z.string().trim().min(2).max(80),
        currency: z.string().trim().length(3),
        purpose: z.enum(["safeguarding", "operating"]).optional(),
        source: z.enum(["manual", "stripe", "wise", "flutterwave"]).optional(),
        details: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    res.status(201).json({ account: createAccount(ctx, req.user!.id, body, req.ip) });
  });

  r.patch("/safeguarding/accounts/:id", requireRecentAuth(ctx), (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        active: z.boolean().optional(),
        purpose: z.enum(["safeguarding", "operating"]).optional(),
        details: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    res.json({ account: updateAccount(ctx, req.user!.id, String(req.params.id), body, req.ip) });
  });

  r.get("/safeguarding/accounts/:id/details", requireRecentAuth(ctx), (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ details: accountDetails(ctx, req.user!.id, String(req.params.id), req.ip) });
  });

  r.get("/safeguarding/accounts/:id/balances", (req, res) => {
    res.json({ balances: balanceHistory(ctx, String(req.params.id)) });
  });

  r.post("/safeguarding/accounts/:id/balances", (req, res) => {
    const body = parse(z.object({ balance: money, asOf: z.string().min(10).max(40), note: z.string().trim().max(300).optional() }), req.body);
    res.status(201).json({ account: recordBalance(ctx, req.user!.id, String(req.params.id), body.balance, body.asOf, "manual", body.note) });
  });

  r.post("/safeguarding/refresh", async (req, res) => {
    const results = await refreshProviderBalances(ctx);
    audit(ctx, req.user!.id, "safeguarding.refreshed", { accounts: results.length }, req.ip);
    res.json({ results });
  });

  r.post("/safeguarding/reconcile", (req, res) => {
    res.json(runReconciliation(ctx, req.user!.id));
  });

  r.post("/safeguarding/sweep", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ from: z.enum(["fees", "fx"]), currency: z.string().trim().length(3), amount: money, note: z.string().trim().max(140).default("") }), req.body);
    res.status(201).json(sweepIncome(ctx, req.user!.id, body.from, body.currency, body.amount, body.note, req.ip));
  });

  // ---- Trading records across the platform ----
  r.get("/trading", (req, res) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), req.query);
    res.json(tradingActivity(ctx, days ?? 30));
  });

  /** Newest accounts, or a search by name, handle, email or account number. */
  r.get("/users", (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase().slice(0, 100);
    const cols =
      "id, email, handle, display_name AS displayName, role, status, kyc_level AS kycLevel, account_number AS accountNumber, closed_at AS closedAt, created_at AS createdAt";
    const like = `%${q.replace(/^@/, "").replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const digits = q.replace(/[\s-]/g, "");
    const users = q
      ? all(
          ctx.db,
          `SELECT ${cols} FROM users WHERE lower(email) LIKE ? ESCAPE '\\' OR lower(handle) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\' OR account_number = ?
           ORDER BY created_at DESC LIMIT 50`,
          like,
          like,
          like,
          digits,
        )
      : all(ctx.db, `SELECT ${cols} FROM users ORDER BY created_at DESC LIMIT 200`);
    res.json({ users });
  });

  /** Everything about one account, for support and compliance. Viewing it is audited. */
  r.get("/users/:id", (req, res) => {
    const user = getUserRow(ctx, String(req.params.id));
    const id = user.id;
    audit(ctx, req.user!.id, "admin.user_viewed", { target: id }, req.ip);
    const balances = all<{ currency: string; balance: number }>(ctx.db, "SELECT currency, balance FROM accounts WHERE owner_type = 'user' AND user_id = ? ORDER BY currency", id).map((a) => ({
      currency: a.currency,
      balance: fromMinor(a.balance, a.currency),
    }));
    const activity = all<{ created_at: string; amount: number; currency: string; kind: string; memo: string | null; journal_id: string }>(
      ctx.db,
      `SELECT e.created_at, e.amount, e.currency, j.kind, j.memo, e.journal_id FROM entries e JOIN accounts a ON a.id = e.account_id JOIN journals j ON j.id = e.journal_id
       WHERE a.owner_type = 'user' AND a.user_id = ? ORDER BY e.id DESC LIMIT 50`,
      id,
    ).map((e) => ({ date: e.created_at, kind: e.kind, description: e.memo, currency: e.currency, amount: fromMinor(e.amount, e.currency), reference: e.journal_id }));
    res.json({
      user: {
        id,
        email: user.email,
        emailVerified: Boolean(user.email_verified_at),
        handle: user.handle,
        displayName: user.display_name,
        role: user.role,
        status: user.closed_at ? "closed" : user.status,
        closedAt: user.closed_at,
        accountNumber: user.account_number,
        kycLevel: user.kyc_level,
        twoFactor: user.totp_enabled === 1,
        createdAt: user.created_at,
        lockedUntil: user.locked_until,
        securityHoldUntil: user.security_hold_until,
      },
      limits: { ...limitsFor(ctx, user), overrideTxUsd: user.limit_tx_usd, overrideDailyUsd: user.limit_daily_usd },
      verification: listSubmissions(ctx, "all").filter((s) => s.user.id === id),
      balances,
      activity,
      transfers: all(
        ctx.db,
        "SELECT id, direction, rail, currency, amount, status, failure_reason AS failureReason, created_at AS createdAt FROM external_transfers WHERE user_id = ? ORDER BY created_at DESC LIMIT 25",
        id,
      ),
      trading: {
        account: one(ctx.db, "SELECT broker, cash_cents / 100.0 AS cash, starting_cents / 100.0 AS startingCash FROM trading_accounts WHERE user_id = ?", id) ?? null,
        positions: all(ctx.db, "SELECT symbol, qty, avg_cost AS avgCost FROM positions WHERE user_id = ? ORDER BY symbol", id),
        orders: one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM orders WHERE user_id = ?", id)!.n,
        fills: tradeHistory(ctx, id, { limit: 25 }).fills,
        realApplication: one(ctx.db, "SELECT status, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM live_applications WHERE user_id = ?", id) ?? null,
      },
      compliance: listAlerts(ctx, "all", id),
      sessions: all(ctx.db, "SELECT created_at AS createdAt, expires_at AS expiresAt, ip, user_agent AS userAgent FROM sessions WHERE user_id = ? ORDER BY created_at DESC", id),
      events: all(ctx.db, "SELECT action, ip, details, created_at AS createdAt FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 40", id),
      notes: all(
        ctx.db,
        `SELECT n.id, n.note, n.created_at AS createdAt, u.handle AS author FROM account_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.user_id = ? ORDER BY n.id DESC`,
        id,
      ),
    });
  });

  /** Per-user limits (USD). null returns the user to their verification level's limits. */
  r.post("/users/:id/limits", requireRecentAuth(ctx), (req, res) => {
    const body = parse(
      z.object({ txUsd: z.number().positive().max(10_000_000).nullable(), dailyUsd: z.number().positive().max(100_000_000).nullable() }),
      req.body,
    );
    const result = requestChange(ctx, req.user!.id, "limits", String(req.params.id), body, req.ip);
    res.status(result.applied ? 200 : 202).json({ ok: true, ...result });
  });

  /** Give a customer Aurex Pro free for a number of days (testers, partners, goodwill). */
  r.post("/users/:id/pro", (req, res) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(366) }), req.body);
    compPro(ctx, req.user!.id, getUserRow(ctx, String(req.params.id)).id, days, req.ip);
    res.json({ ok: true });
  });

  r.post("/users/:id/notes", (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().min(1).max(2000) }), req.body);
    const target = getUserRow(ctx, String(req.params.id)).id;
    run(ctx.db, "INSERT INTO account_notes (user_id, author_id, note, created_at) VALUES (?, ?, ?, ?)", target, req.user!.id, note, new Date().toISOString());
    audit(ctx, req.user!.id, "admin.note_added", { target }, req.ip);
    res.status(201).json({ ok: true });
  });

  /** Set a verification level directly (for example, identity checked in person). */
  r.post("/users/:id/kyc-level", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2)]), note: z.string().trim().min(3).max(500) }), req.body);
    if (String(req.params.id) === req.user!.id) setLevel(ctx, req.user!.id, req.user!.id, body.level, body.note, req.ip); // refused: your own level
    const result = requestChange(ctx, req.user!.id, "kyc_level", String(req.params.id), body, req.ip);
    res.status(result.applied ? 200 : 202).json({ ok: true, ...result });
  });

  // ---- Two-person approval ----
  r.get("/approvals", (req, res) => {
    res.json({ requests: listRequests(ctx, req.query.status === "all" ? "all" : "pending"), me: req.user!.id });
  });

  r.post("/approvals/:id/approve", requireRecentAuth(ctx), (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    res.json({ request: decideRequest(ctx, req.user!.id, String(req.params.id), "approve", note, req.ip) });
  });

  r.post("/approvals/:id/reject", requireRecentAuth(ctx), (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    res.json({ request: decideRequest(ctx, req.user!.id, String(req.params.id), "reject", note, req.ip) });
  });

  r.post("/approvals/:id/cancel", (req, res) => {
    cancelRequest(ctx, req.user!.id, String(req.params.id), req.ip);
    res.json({ ok: true });
  });

  // ---- Identity verification queue ----
  r.get("/kyc", (req, res) => {
    const status = req.query.status === "all" ? "all" : "submitted";
    audit(ctx, req.user!.id, "admin.kyc_viewed", { status }, req.ip);
    res.json({ submissions: listSubmissions(ctx, status) });
  });

  r.post("/kyc/:id/review", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }), req.body);
    reviewSubmission(ctx, req.user!.id, String(req.params.id), body.decision, body.note, req.ip);
    res.json({ submissions: listSubmissions(ctx, "submitted") });
  });

  /** A customer's identity document, decrypted for review. Every view is audited. */
  r.get("/kyc/documents/:id", (req, res) => {
    const doc = readDocument(ctx, String(req.params.id));
    audit(ctx, req.user!.id, "admin.kyc_document_viewed", { documentId: req.params.id, target: doc.userId, kind: doc.kind }, req.ip);
    res.set(documentHeaders(doc));
    res.send(doc.bytes);
  });

  r.post("/users/:id/status", requireRecentAuth(ctx), (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["active", "frozen"]) }), req.body);
    const target = String(req.params.id);
    if (target === req.user!.id) throw new HttpError(400, "bad_request", "You can't change your own account's status");
    // Setting a closed account back to active reopens it.
    if (status === "active" && one(ctx.db, "SELECT 1 FROM users WHERE id = ? AND closed_at IS NOT NULL", target)) {
      reopenAccount(ctx, req.user!.id, target, req.ip);
      res.json({ ok: true });
      return;
    }
    const changed = run(ctx.db, "UPDATE users SET status = ? WHERE id = ?", status, target);
    if (Number(changed.changes) === 0) throw notFound("User not found");
    if (status === "frozen") run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", target);
    audit(ctx, req.user!.id, "admin.user_status", { target, status }, req.ip);
    addAlert(ctx, target, "account", status === "frozen" ? "Your account was frozen by our team. Contact support to find out more." : "Your account is active again.");
    res.json({ ok: true });
  });

  /** Real-account applications waiting for review (personal details are decrypted for reviewers only). */
  r.get("/upgrades", (req, res) => {
    const status = req.query.status === "all" ? "all" : "submitted";
    audit(ctx, req.user!.id, "admin.upgrades_viewed", { status }, req.ip);
    res.json({ applications: listApplications(ctx, status) });
  });

  r.post("/upgrades/:userId/review", requireRecentAuth(ctx), (req, res) => {
    const body = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() }), req.body);
    const target = String(req.params.userId);
    reviewApplication(ctx, req.user!.id, target, body.decision, body.note, req.ip);
    audit(ctx, req.user!.id, "admin.upgrade_reviewed", { target, decision: body.decision }, req.ip);
    res.json({ applications: listApplications(ctx, "submitted") });
  });

  return r;
}
