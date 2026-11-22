import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { fromMinor } from "../lib/money.js";
import { toUsdMinor } from "./fx.js";
import { limitsFor } from "./kyc.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Transaction monitoring. Each money movement is checked against a few well-known patterns
 * (large amounts, money passing straight through, splitting payments to stay under limits, many
 * counterparties at once, cashing out a brand-new account). A match opens a compliance alert for an
 * admin to clear or escalate. Alerts are internal: telling a customer they're being looked at
 * ("tipping off") is itself prohibited in most AML regimes, so nothing here reaches the customer.
 */

export type Severity = "low" | "medium" | "high";
export type Rule = "large_amount" | "rapid_in_out" | "structuring" | "fan_out" | "fan_in" | "new_account_payout" | "sanctions_match" | "pep_match";

export const RULES: Record<Rule, { label: string; severity: Severity }> = {
  large_amount: { label: "Large payment", severity: "medium" },
  rapid_in_out: { label: "Money in and straight out", severity: "high" },
  structuring: { label: "Payments just under the limit", severity: "medium" },
  fan_out: { label: "Paying many people", severity: "medium" },
  fan_in: { label: "Paid by many people", severity: "medium" },
  new_account_payout: { label: "Withdrawal from a new account", severity: "medium" },
  sanctions_match: { label: "Possible sanctions list match", severity: "high" },
  pep_match: { label: "Possible politically exposed person", severity: "medium" },
};

const DAY = 24 * 3600_000;
const since = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Opens an alert (once per rule and reference: re-checks never duplicate one, cleared ones stay cleared). */
export function openAlert(ctx: Ctx, userId: string, rule: Rule, ref: string, summary: string, details: Record<string, unknown>) {
  return open(ctx, userId, rule, ref, summary, details);
}

function open(ctx: Ctx, userId: string, rule: Rule, ref: string, summary: string, details: Record<string, unknown>) {
  const res = run(
    ctx.db,
    "INSERT OR IGNORE INTO compliance_alerts (id, user_id, rule, severity, summary, details, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId("cmp"),
    userId,
    rule,
    RULES[rule].severity,
    summary,
    JSON.stringify(details),
    ref,
    nowIso(),
  );
  return res.changes > 0;
}

export type Movement =
  | { kind: "deposit"; userId: string; ref: string; currency: string; amountMinor: number }
  | { kind: "withdrawal"; userId: string; ref: string; currency: string; amountMinor: number }
  | { kind: "transfer"; userId: string; recipientId: string; ref: string; currency: string; amountMinor: number };

/**
 * Checks one movement and opens alerts for any pattern it completes. Never throws: monitoring must
 * not stop a payment that has already been checked against limits. Returns the rules that matched.
 */
export async function monitor(ctx: Ctx, m: Movement): Promise<Rule[]> {
  try {
    return await evaluate(ctx, m);
  } catch (err) {
    console.error(`[monitoring] ${m.kind} ${m.ref}: ${(err as Error).message}`);
    return [];
  }
}

async function evaluate(ctx: Ctx, m: Movement): Promise<Rule[]> {
  const hits: Rule[] = [];
  const usd = await toUsdMinor(ctx, m.currency, m.amountMinor);
  const amount = `${m.currency} ${fromMinor(m.amountMinor, m.currency)}`;
  const largeUsd = Math.round(ctx.config.MONITOR_LARGE_USD * 100);

  if (usd >= largeUsd && open(ctx, m.userId, "large_amount", m.ref, `${m.kind === "transfer" ? "Sent" : m.kind === "deposit" ? "Deposited" : "Withdrew"} ${amount}`, { usd: usd / 100, kind: m.kind })) {
    hits.push("large_amount");
  }

  // Splitting money into several payments each just under the per-payment limit.
  if (m.kind !== "withdrawal") {
    const user = getUserRow(ctx, m.userId);
    const limit = Math.round(limitsFor(ctx, user).txUsd * 100);
    if (usd >= limit * 0.9) {
      const rows = all<{ currency: string; amount: number }>(
        ctx.db,
        m.kind === "deposit"
          ? "SELECT currency, amount FROM external_transfers WHERE user_id = ? AND direction = 'deposit' AND status IN ('pending','completed') AND created_at >= ?"
          : `SELECT e.currency, -e.amount AS amount FROM entries e JOIN accounts a ON a.id = e.account_id JOIN journals j ON j.id = e.journal_id
             WHERE a.owner_type = 'user' AND a.user_id = ? AND j.kind = 'transfer' AND e.amount < 0 AND e.created_at >= ?`,
        m.userId,
        since(DAY),
      );
      let near = 0;
      for (const r of rows) {
        const u = await toUsdMinor(ctx, r.currency, r.amount);
        if (u >= limit * 0.9 && u <= limit) near++;
      }
      if (near >= 3 && open(ctx, m.userId, "structuring", `${m.userId}:${new Date().toISOString().slice(0, 10)}:${m.kind}`, `${near} ${m.kind === "deposit" ? "deposits" : "payments"} just under the $${limit / 100} limit in 24 hours`, { count: near, limitUsd: limit / 100 })) {
        hits.push("structuring");
      }
    }
  }

  if (m.kind === "transfer") {
    const day = new Date().toISOString().slice(0, 10);
    const counterparties = (dir: "out" | "in", userId: string) =>
      one<{ n: number }>(
        ctx.db,
        `SELECT COUNT(DISTINCT other.user_id) AS n FROM entries mine
         JOIN accounts ma ON ma.id = mine.account_id
         JOIN journals j ON j.id = mine.journal_id AND j.kind = 'transfer'
         JOIN entries oe ON oe.journal_id = mine.journal_id AND oe.id <> mine.id
         JOIN accounts other ON other.id = oe.account_id AND other.owner_type = 'user' AND other.user_id <> ma.user_id
         WHERE ma.owner_type = 'user' AND ma.user_id = ? AND mine.amount ${dir === "out" ? "<" : ">"} 0 AND mine.created_at >= ?`,
        userId,
        since(DAY),
      )!.n;
    const out = counterparties("out", m.userId);
    if (out >= 10 && open(ctx, m.userId, "fan_out", `${m.userId}:${day}:out`, `Paid ${out} different people in 24 hours`, { people: out })) hits.push("fan_out");
    const inn = counterparties("in", m.recipientId);
    if (inn >= 10 && open(ctx, m.recipientId, "fan_in", `${m.recipientId}:${day}:in`, `Paid by ${inn} different people in 24 hours`, { people: inn })) hits.push("fan_in");
  }

  if (m.kind === "withdrawal") {
    // Money that arrived in the last day and is leaving again straight away.
    const deposits = all<{ currency: string; amount: number }>(
      ctx.db,
      "SELECT currency, amount FROM external_transfers WHERE user_id = ? AND direction = 'deposit' AND status = 'completed' AND updated_at >= ?",
      m.userId,
      since(DAY),
    );
    const incoming = all<{ currency: string; amount: number }>(
      ctx.db,
      `SELECT e.currency, e.amount FROM entries e JOIN accounts a ON a.id = e.account_id JOIN journals j ON j.id = e.journal_id
       WHERE a.owner_type = 'user' AND a.user_id = ? AND j.kind = 'transfer' AND e.amount > 0 AND e.created_at >= ?`,
      m.userId,
      since(DAY),
    );
    let inUsd = 0;
    for (const d of [...deposits, ...incoming]) inUsd += await toUsdMinor(ctx, d.currency, d.amount);
    if (inUsd > 0 && inUsd >= usd * 0.8 && usd >= 5000 && open(ctx, m.userId, "rapid_in_out", m.ref, `Withdrawing ${amount} within a day of receiving $${(inUsd / 100).toFixed(2)}`, { receivedUsd: inUsd / 100, withdrawingUsd: usd / 100 })) {
      hits.push("rapid_in_out");
    }
    const user = getUserRow(ctx, m.userId);
    if (Date.now() - Date.parse(user.created_at) < 3 * DAY && open(ctx, m.userId, "new_account_payout", m.ref, `Withdrawing ${amount} from an account opened ${Math.max(0, Math.floor((Date.now() - Date.parse(user.created_at)) / 3600_000))} hours ago`, {})) {
      hits.push("new_account_payout");
    }
  }
  return hits;
}

/** Open alerts serious enough that the customer's money shouldn't leave without a review. */
export function hasOpenSeriousAlert(ctx: Ctx, userId: string) {
  return Boolean(one(ctx.db, "SELECT 1 FROM compliance_alerts WHERE user_id = ? AND status IN ('open','escalated') AND severity IN ('medium','high') LIMIT 1", userId));
}

interface AlertRow {
  id: string;
  user_id: string;
  rule: Rule;
  severity: Severity;
  summary: string;
  details: string;
  ref: string;
  status: "open" | "cleared" | "escalated";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  report_decision: "report" | "no_report" | null;
  report_reason: string | null;
  report_ref: string | null;
  reported_on: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  handle?: string;
  email?: string;
  account_number?: string | null;
  notes?: number;
}

const alertView = (a: AlertRow) => ({
  id: a.id,
  rule: a.rule,
  label: RULES[a.rule]?.label ?? a.rule,
  severity: a.severity,
  summary: a.summary,
  details: JSON.parse(a.details) as Record<string, unknown>,
  ref: a.ref,
  status: a.status,
  reviewedAt: a.reviewed_at,
  reviewNote: a.review_note,
  report: a.report_decision ? { decision: a.report_decision, reason: a.report_reason, reference: a.report_ref, reportedOn: a.reported_on, decidedAt: a.decided_at } : null,
  notes: a.notes ?? 0,
  createdAt: a.created_at,
  user: a.handle ? { id: a.user_id, handle: a.handle, email: a.email, accountNumber: a.account_number ?? null } : { id: a.user_id },
});

export function listAlerts(ctx: Ctx, status: "open" | "cleared" | "escalated" | "all" = "open", userId?: string) {
  return all<AlertRow>(
    ctx.db,
    `SELECT c.*, u.handle, u.email, u.account_number, (SELECT COUNT(*) FROM compliance_notes n WHERE n.alert_id = c.id) AS notes
     FROM compliance_alerts c JOIN users u ON u.id = c.user_id
     WHERE (? = 'all' OR c.status = ?) AND (? IS NULL OR c.user_id = ?)
     ORDER BY CASE c.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 200`,
    status,
    status,
    userId ?? null,
    userId ?? null,
  ).map(alertView);
}

/**
 * An admin's decision on an alert: clear it (nothing suspicious) or escalate it (keep it open for
 * further work, e.g. a suspicious activity report, and optionally freeze the account).
 */
export function reviewAlert(ctx: Ctx, adminId: string, id: string, action: "clear" | "escalate", note: string, freeze = false, ip?: string) {
  const a = one<AlertRow>(ctx.db, "SELECT * FROM compliance_alerts WHERE id = ?", id);
  if (!a) throw notFound("No such alert");
  if (a.user_id === adminId) throw new HttpError(403, "forbidden", "You can't review alerts on your own account");
  if (a.status === "cleared") throw badRequest("This alert was already cleared");
  if (note.trim().length < 3) throw badRequest("Say what you found");
  run(
    ctx.db,
    "UPDATE compliance_alerts SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
    action === "clear" ? "cleared" : "escalated",
    adminId,
    nowIso(),
    note.trim().slice(0, 1000),
    id,
  );
  // Confirming a PEP match puts the customer under enhanced due diligence (every payout reviewed).
  if (action === "escalate" && a.rule === "pep_match") {
    run(ctx.db, "UPDATE users SET pep_confirmed_at = COALESCE(pep_confirmed_at, ?) WHERE id = ?", nowIso(), a.user_id);
    audit(ctx, adminId, "compliance.pep_confirmed", { target: a.user_id, alert: id }, ip);
  }
  if (action === "escalate" && freeze) {
    run(ctx.db, "UPDATE users SET status = 'frozen' WHERE id = ? AND role <> 'admin'", a.user_id);
    run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", a.user_id);
    audit(ctx, adminId, "admin.user_status", { target: a.user_id, status: "frozen", reason: "compliance" }, ip);
  }
  audit(ctx, adminId, `compliance.${action === "clear" ? "cleared" : "escalated"}`, { alert: id, target: a.user_id, rule: a.rule, freeze }, ip);
  return alertView({ ...a, status: action === "clear" ? "cleared" : "escalated", review_note: note, reviewed_at: nowIso() });
}

// ---------------------------------------------------------------------------
// Case files: notes, and the decision on reporting to the Financial Intelligence Unit
// ---------------------------------------------------------------------------
function alertForCase(ctx: Ctx, adminId: string, id: string) {
  const a = one<AlertRow>(ctx.db, "SELECT * FROM compliance_alerts WHERE id = ?", id);
  if (!a) throw notFound("No such alert");
  if (a.user_id === adminId) throw new HttpError(403, "forbidden", "You can't work on alerts about your own account");
  return a;
}

const handleOf = (ctx: Ctx, id: string | null) => (id ? (one<{ handle: string; display_name: string }>(ctx.db, "SELECT handle, display_name FROM users WHERE id = ?", id) ?? null) : null);

/** Everything on one alert: what happened, the notes, the review and the reporting decision, oldest first. */
export function caseFile(ctx: Ctx, adminId: string, id: string) {
  const a = alertForCase(ctx, adminId, id);
  const u = one<{ handle: string; email: string; account_number: string | null }>(ctx.db, "SELECT handle, email, account_number FROM users WHERE id = ?", a.user_id);
  const notes = all<{ id: string; author_id: string; body: string; created_at: string; handle: string | null; display_name: string | null }>(
    ctx.db,
    "SELECT n.*, u.handle, u.display_name FROM compliance_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.alert_id = ? ORDER BY n.created_at, n.rowid",
    id,
  ).map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at, author: { id: n.author_id, handle: n.handle, name: n.display_name } }));
  const reviewer = handleOf(ctx, a.reviewed_by);
  const decider = handleOf(ctx, a.decided_by);
  return {
    alert: alertView({ ...a, handle: u?.handle, email: u?.email, account_number: u?.account_number, notes: notes.length }),
    notes,
    reviewedBy: reviewer ? { handle: reviewer.handle, name: reviewer.display_name } : null,
    decidedBy: decider ? { handle: decider.handle, name: decider.display_name } : null,
    canDecide: a.status === "escalated" && !a.report_decision,
  };
}

/** A note on an alert's case file. Notes can't be changed or deleted (the database refuses). */
export function addCaseNote(ctx: Ctx, adminId: string, id: string, body: string, ip?: string) {
  const a = alertForCase(ctx, adminId, id);
  const text = body.trim();
  if (text.length < 3) throw badRequest("Write a note");
  run(ctx.db, "INSERT INTO compliance_notes (id, alert_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", newId("cnote"), id, adminId, text.slice(0, 4000), nowIso());
  audit(ctx, adminId, "compliance.note_added", { alert: id, target: a.user_id }, ip);
  return caseFile(ctx, adminId, id);
}

export interface ReportDecision {
  decision: "report" | "no_report";
  reason: string;
  reference?: string;
  reportedOn?: string;
}

/**
 * The reporting decision on an escalated case: filed with the Financial Intelligence Unit (with the
 * date and its reference), or not reported, with the reasons. It's final: anything later goes in a
 * note. Not reporting closes the case, releasing the payout hold (a frozen account stays frozen).
 */
export function decideReport(ctx: Ctx, adminId: string, id: string, d: ReportDecision, ip?: string) {
  const a = alertForCase(ctx, adminId, id);
  if (a.status !== "escalated") throw unprocessable("not_escalated", "Escalate the alert first; clearing an open alert records why it isn't suspicious");
  if (a.report_decision) throw unprocessable("already_decided", "The reporting decision has already been recorded. Add a note instead.");
  const reason = d.reason.trim();
  if (reason.length < 20) throw badRequest("Give the reasons in a sentence or two (the regulator may ask)");
  if (d.decision === "report") {
    if (!d.reference?.trim()) throw badRequest("Enter the reference the FIU gave the report");
    if (!d.reportedOn || !/^\d{4}-\d{2}-\d{2}$/.test(d.reportedOn) || Date.parse(d.reportedOn) > Date.now()) throw badRequest("Enter the date the report was filed");
  }
  const now = nowIso();
  run(
    ctx.db,
    `UPDATE compliance_alerts SET report_decision = ?, report_reason = ?, report_ref = ?, reported_on = ?, decided_by = ?, decided_at = ?,
       status = CASE WHEN ? = 'no_report' THEN 'cleared' ELSE status END WHERE id = ?`,
    d.decision,
    reason.slice(0, 2000),
    d.decision === "report" ? d.reference!.trim().slice(0, 100) : null,
    d.decision === "report" ? d.reportedOn! : null,
    adminId,
    now,
    d.decision,
    id,
  );
  audit(ctx, adminId, "compliance.report_decided", { alert: id, target: a.user_id, decision: d.decision }, ip);
  return caseFile(ctx, adminId, id);
}

/** Every reporting decision, for the reporting officer's register and the regulator. */
export function reportRegister(ctx: Ctx, from?: string, to?: string) {
  return all<AlertRow & { handle: string; account_number: string | null; reviewer: string | null; decider: string | null }>(
    ctx.db,
    `SELECT c.*, u.handle, u.account_number, r.handle AS reviewer, d.handle AS decider
     FROM compliance_alerts c JOIN users u ON u.id = c.user_id LEFT JOIN users r ON r.id = c.reviewed_by LEFT JOIN users d ON d.id = c.decided_by
     WHERE c.report_decision IS NOT NULL AND (? IS NULL OR c.decided_at >= ?) AND (? IS NULL OR c.decided_at < ?)
     ORDER BY c.decided_at`,
    from ?? null,
    from ?? null,
    to ?? null,
    to ?? null,
  );
}

/** Lets every admin know (in-app and by email) about something that needs them. */
export function notifyAdmins(ctx: Ctx, message: string, exceptUserId?: string) {
  for (const { id } of all<{ id: string }>(ctx.db, "SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?", exceptUserId ?? "")) {
    addAlert(ctx, id, "account", message);
  }
}
