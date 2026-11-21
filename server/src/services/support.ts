import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { sendEmail, simpleHtml } from "../lib/mailer.js";
import { notifyAdmins } from "./monitoring.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Help and complaints. A customer opens a case and gets a reference number; staff reply (or leave
 * internal notes the customer never sees) and resolve it. A complaint is a case with deadlines from the
 * complaints policy: acknowledged straight away, a final answer within COMPLAINT_RESPONSE_DAYS business
 * days, and an outcome recorded (upheld, partly upheld, not upheld, withdrawn) for the complaints
 * report regulators ask for.
 */

export const CATEGORIES = ["question", "payment", "account", "security", "complaint", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const OUTCOMES = ["upheld", "partly_upheld", "not_upheld", "withdrawn"] as const;
export type Outcome = (typeof OUTCOMES)[number];
type Status = "open" | "waiting_customer" | "resolved";

const CATEGORY_LABEL: Record<Category, string> = {
  question: "Question",
  payment: "A payment",
  account: "My account",
  security: "Security or fraud",
  complaint: "Complaint",
  other: "Something else",
};

interface CaseRow {
  id: string;
  reference: string;
  user_id: string;
  category: Category;
  is_complaint: number;
  priority: "normal" | "high";
  subject: string;
  status: Status;
  assigned_to: string | null;
  resolution: string | null;
  outcome: Outcome | null;
  due_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  case_id: string;
  author_type: "customer" | "staff" | "system";
  author_id: string | null;
  internal: number;
  body: string;
  created_at: string;
}

/** Adds business days (Monday to Friday; public holidays aren't counted out). */
export function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

const caseView = (c: CaseRow, now = nowIso()) => ({
  id: c.id,
  reference: c.reference,
  category: c.category,
  categoryLabel: CATEGORY_LABEL[c.category],
  complaint: c.is_complaint === 1,
  priority: c.priority,
  subject: c.subject,
  status: c.status,
  resolution: c.resolution,
  outcome: c.outcome,
  dueAt: c.due_at,
  overdue: c.status !== "resolved" && !!c.due_at && c.due_at < now,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  resolvedAt: c.resolved_at,
});

const messageView = (m: MessageRow, staffNames: Map<string, string>) => ({
  id: m.id,
  from: m.author_type,
  // Customers see "Aurex support", never which staff member wrote.
  author: m.author_type === "staff" ? (staffNames.get(m.author_id ?? "") ?? "Aurex support") : m.author_type === "system" ? "Aurex" : "You",
  internal: m.internal === 1,
  body: m.body,
  createdAt: m.created_at,
});

function loadCase(ctx: Ctx, id: string) {
  const c = one<CaseRow>(ctx.db, "SELECT * FROM support_cases WHERE id = ?", id);
  if (!c) throw notFound("Case not found");
  return c;
}

function ownCase(ctx: Ctx, userId: string, id: string) {
  const c = loadCase(ctx, id);
  if (c.user_id !== userId) throw notFound("Case not found");
  return c;
}

function addMessage(ctx: Ctx, caseId: string, author: MessageRow["author_type"], authorId: string | null, body: string, internal = false) {
  run(
    ctx.db,
    "INSERT INTO support_messages (case_id, author_type, author_id, internal, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    caseId,
    author,
    authorId,
    internal ? 1 : 0,
    body,
    nowIso(),
  );
}

function complaintAck(ctx: Ctx, reference: string, due: string) {
  return `We've received your complaint. Your reference is ${reference}. Someone who wasn't involved in the original issue will look into it, and we'll give you our answer in writing by ${due.slice(0, 10)} (${ctx.config.COMPLAINT_RESPONSE_DAYS} business days) at the latest. If you're not satisfied with our answer, the Complaints page explains where you can take it.`;
}

function nextReference(ctx: Ctx) {
  const now = new Date();
  const prefix = `AX-${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
  const n = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM support_cases WHERE reference LIKE ?", `${prefix}%`)!.n;
  return `${prefix}${String(n + 1).padStart(4, "0")}`;
}

/** Emails the customer that there's news on a case. The message itself stays in the app. */
async function emailCustomer(ctx: Ctx, userId: string, reference: string, line: string) {
  const user = getUserRow(ctx, userId);
  if (!user.email_verified_at || ctx.config.emailDelivery === "none") return;
  const paragraphs = [line, "Sign in to Aurex and open Help to read it and reply. For your security, we don't put the details in emails."];
  await sendEmail(ctx.config, {
    to: user.email,
    subject: `Aurex support: update on ${reference}`,
    text: paragraphs.join("\n\n"),
    html: simpleHtml(`Update on ${reference}`, paragraphs),
  });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export function openCase(ctx: Ctx, userId: string, input: { category: Category; subject: string; message: string }, ip?: string) {
  const complaint = input.category === "complaint";
  const priority = input.category === "security" ? "high" : "normal";
  const now = new Date();
  const due = complaint ? addBusinessDays(now, ctx.config.COMPLAINT_RESPONSE_DAYS).toISOString() : null;
  const id = newId("case");
  const reference = tx(ctx.db, () => {
    const ref = nextReference(ctx);
    run(
      ctx.db,
      `INSERT INTO support_cases (id, reference, user_id, category, is_complaint, priority, subject, status, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      ref,
      userId,
      input.category,
      complaint ? 1 : 0,
      priority,
      input.subject.trim(),
      due,
      now.toISOString(),
      now.toISOString(),
    );
    addMessage(ctx, id, "customer", userId, input.message.trim());
    addMessage(
      ctx,
      id,
      "system",
      null,
      complaint
        ? complaintAck(ctx, ref, due!)
        : priority === "high"
          ? `Thanks, your reference is ${ref}. We treat security reports first. If you think someone else is in your account, change your password now and sign out other devices under Settings → Security center.`
          : `Thanks, your reference is ${ref}. We usually reply within one business day.`,
    );
    return ref;
  });
  audit(ctx, userId, "support.case_opened", { reference, category: input.category }, ip);
  const user = getUserRow(ctx, userId);
  notifyAdmins(ctx, `${complaint ? "New complaint" : priority === "high" ? "Security report" : "New help request"} ${reference} from @${user.handle}: "${input.subject.trim().slice(0, 80)}" (Admin → Support).`, userId);
  return caseDetail(ctx, userId, id);
}

export function listOwnCases(ctx: Ctx, userId: string) {
  return all<CaseRow>(ctx.db, "SELECT * FROM support_cases WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100", userId).map((c) => caseView(c));
}

export function caseDetail(ctx: Ctx, userId: string, id: string) {
  const c = ownCase(ctx, userId, id);
  const messages = all<MessageRow>(ctx.db, "SELECT * FROM support_messages WHERE case_id = ? AND internal = 0 ORDER BY id", c.id);
  return { case: caseView(c), messages: messages.map((m) => messageView(m, new Map())) };
}

export function customerReply(ctx: Ctx, userId: string, id: string, body: string, ip?: string) {
  const c = ownCase(ctx, userId, id);
  if (c.status === "resolved" && c.resolved_at && Date.now() - Date.parse(c.resolved_at) > 30 * 86_400_000) {
    throw unprocessable("case_closed", "This case was resolved more than 30 days ago. Please open a new one.");
  }
  tx(ctx.db, () => {
    addMessage(ctx, c.id, "customer", userId, body.trim());
    run(ctx.db, "UPDATE support_cases SET status = 'open', resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END, updated_at = ? WHERE id = ?", nowIso(), c.id);
  });
  audit(ctx, userId, "support.customer_replied", { reference: c.reference }, ip);
  if (c.status === "resolved") notifyAdmins(ctx, `${c.reference} was reopened by the customer (Admin → Support).`, userId);
  return caseDetail(ctx, userId, id);
}

/** "I'm not happy with how this is being handled": the case becomes a formal complaint with its deadline. */
export function makeComplaint(ctx: Ctx, userId: string, id: string, ip?: string) {
  const c = ownCase(ctx, userId, id);
  if (c.is_complaint) throw unprocessable("already_complaint", "This is already a formal complaint");
  const due = addBusinessDays(new Date(), ctx.config.COMPLAINT_RESPONSE_DAYS).toISOString();
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE support_cases SET is_complaint = 1, due_at = ?, status = 'open', resolved_at = NULL, outcome = NULL, updated_at = ? WHERE id = ?", due, nowIso(), c.id);
    addMessage(ctx, c.id, "system", null, complaintAck(ctx, c.reference, due));
  });
  audit(ctx, userId, "support.complaint_raised", { reference: c.reference }, ip);
  notifyAdmins(ctx, `${c.reference} is now a formal complaint, due ${due.slice(0, 10)} (Admin → Support).`, userId);
  return caseDetail(ctx, userId, id);
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
export function listCases(ctx: Ctx, filter: { status?: Status | "all" | "active"; complaints?: boolean }) {
  const status = filter.status ?? "active";
  const now = nowIso();
  return all<CaseRow & { handle: string; display_name: string }>(
    ctx.db,
    `SELECT c.*, u.handle, u.display_name FROM support_cases c JOIN users u ON u.id = c.user_id
     WHERE (? = 'all' OR (? = 'active' AND c.status <> 'resolved') OR c.status = ?) AND (? = 0 OR c.is_complaint = 1)
     ORDER BY CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END, CASE c.priority WHEN 'high' THEN 0 ELSE 1 END, COALESCE(c.due_at, '9999'), c.updated_at DESC LIMIT 300`,
    status,
    status,
    status,
    filter.complaints ? 1 : 0,
  ).map((c) => ({ ...caseView(c, now), customer: { id: c.user_id, handle: c.handle, name: c.display_name }, assignedTo: c.assigned_to }));
}

export function staffCaseDetail(ctx: Ctx, id: string) {
  const c = loadCase(ctx, id);
  const messages = all<MessageRow>(ctx.db, "SELECT * FROM support_messages WHERE case_id = ? ORDER BY id", c.id);
  const staff = new Map(
    all<{ id: string; handle: string }>(ctx.db, "SELECT id, handle FROM users WHERE id IN (SELECT DISTINCT author_id FROM support_messages WHERE case_id = ? AND author_type = 'staff')", c.id).map(
      (s) => [s.id, `@${s.handle}`],
    ),
  );
  const u = getUserRow(ctx, c.user_id);
  return {
    case: { ...caseView(c), assignedTo: c.assigned_to },
    customer: { id: u.id, handle: u.handle, name: u.display_name, email: u.email, kycLevel: u.kyc_level, status: u.closed_at ? "closed" : u.status },
    messages: messages.map((m) => messageView(m, staff)),
  };
}

export async function staffReply(ctx: Ctx, adminId: string, id: string, body: string, internal: boolean, ip?: string) {
  const c = loadCase(ctx, id);
  if (c.user_id === adminId) throw forbidden("Another admin must handle your own case");
  tx(ctx.db, () => {
    addMessage(ctx, c.id, "staff", adminId, body.trim(), internal);
    if (!internal) {
      run(
        ctx.db,
        "UPDATE support_cases SET status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'waiting_customer' END, first_response_at = COALESCE(first_response_at, ?), assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?",
        nowIso(),
        adminId,
        nowIso(),
        c.id,
      );
    }
  });
  audit(ctx, adminId, internal ? "support.note_added" : "support.staff_replied", { reference: c.reference, target: c.user_id }, ip);
  if (!internal) {
    addAlert(ctx, c.user_id, "support", `Aurex support replied about ${c.reference}. Open Help to read it.`);
    await emailCustomer(ctx, c.user_id, c.reference, `Aurex support replied about your case ${c.reference}.`).catch(() => undefined);
  }
  return staffCaseDetail(ctx, id);
}

export async function resolveCase(ctx: Ctx, adminId: string, id: string, resolution: string, outcome: Outcome | undefined, ip?: string) {
  const c = loadCase(ctx, id);
  if (c.user_id === adminId) throw forbidden("Another admin must handle your own case");
  if (c.status === "resolved") throw unprocessable("already_resolved", "This case is already resolved");
  if (c.is_complaint && !outcome) throw badRequest("Record the complaint's outcome: upheld, partly upheld, not upheld or withdrawn");
  const outcomeText = outcome ? { upheld: "We've upheld your complaint.", partly_upheld: "We've partly upheld your complaint.", not_upheld: "We haven't upheld your complaint.", withdrawn: "Your complaint is closed as withdrawn." }[outcome] : "";
  tx(ctx.db, () => {
    run(
      ctx.db,
      "UPDATE support_cases SET status = 'resolved', resolution = ?, outcome = ?, resolved_at = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?",
      resolution.trim(),
      c.is_complaint ? outcome! : null,
      nowIso(),
      nowIso(),
      nowIso(),
      c.id,
    );
    addMessage(
      ctx,
      c.id,
      "system",
      null,
      c.is_complaint
        ? `Our final answer on complaint ${c.reference}: ${outcomeText} ${resolution.trim()} If you're not satisfied, you can refer your complaint to the regulator or ombudsman named on our Complaints page.`
        : `We've marked ${c.reference} as resolved: ${resolution.trim()} Reply here within 30 days if you need more help.`,
    );
  });
  audit(ctx, adminId, "support.case_resolved", { reference: c.reference, target: c.user_id, outcome: outcome ?? null }, ip);
  addAlert(ctx, c.user_id, "support", `${c.reference} has been ${c.is_complaint ? "answered" : "resolved"}. Open Help to read it.`);
  await emailCustomer(ctx, c.user_id, c.reference, `We've ${c.is_complaint ? "sent our final answer on your complaint" : "resolved your case"} ${c.reference}.`).catch(() => undefined);
  return staffCaseDetail(ctx, id);
}

export function assignCase(ctx: Ctx, adminId: string, id: string, toSelf: boolean, ip?: string) {
  const c = loadCase(ctx, id);
  run(ctx.db, "UPDATE support_cases SET assigned_to = ?, updated_at = ? WHERE id = ?", toSelf ? adminId : null, nowIso(), c.id);
  audit(ctx, adminId, "support.case_assigned", { reference: c.reference, assigned: toSelf }, ip);
  return staffCaseDetail(ctx, id);
}

/** Complaints statistics and log for a period (what regulators ask for). Days are calendar days. */
export function complaintsReport(ctx: Ctx, from: string, to: string) {
  const rows = all<CaseRow & { handle: string }>(
    ctx.db,
    `SELECT c.*, u.handle FROM support_cases c JOIN users u ON u.id = c.user_id
     WHERE c.is_complaint = 1 AND c.created_at >= ? AND c.created_at < ? ORDER BY c.created_at`,
    `${from}T00:00:00.000Z`,
    new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString(),
  );
  const now = nowIso();
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000 * 10) / 10;
  const resolved = rows.filter((r) => r.status === "resolved" && r.resolved_at);
  const durations = resolved.map((r) => days(r.created_at, r.resolved_at!)).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null;
  const count = (f: (r: CaseRow) => boolean) => rows.filter(f).length;
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  return {
    from,
    to,
    received: rows.length,
    resolved: resolved.length,
    open: rows.length - resolved.length,
    overdueOpen: count((r) => r.status !== "resolved" && !!r.due_at && r.due_at < now),
    resolvedLate: count((r) => r.status === "resolved" && !!r.due_at && !!r.resolved_at && r.resolved_at > r.due_at),
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, count((r) => r.outcome === o)])),
    medianDaysToResolve: median,
    byCategory,
    log: rows.map((r) => ({
      reference: r.reference,
      received: r.created_at,
      customer: `@${r.handle}`,
      category: r.category,
      subject: r.subject,
      status: r.status,
      outcome: r.outcome,
      due: r.due_at,
      resolved: r.resolved_at,
      daysToResolve: r.resolved_at ? days(r.created_at, r.resolved_at) : null,
      withinDeadline: r.resolved_at && r.due_at ? r.resolved_at <= r.due_at : null,
    })),
  };
}

/** A customer's cases for their data download (internal staff notes are left out). */
export function exportCases(ctx: Ctx, userId: string) {
  return all<CaseRow>(ctx.db, "SELECT * FROM support_cases WHERE user_id = ? ORDER BY created_at", userId).map((c) => ({
    ...caseView(c),
    messages: all<MessageRow>(ctx.db, "SELECT * FROM support_messages WHERE case_id = ? AND internal = 0 ORDER BY id", c.id).map((m) => ({ from: m.author_type, body: m.body, createdAt: m.created_at })),
  }));
}

export function openSupportCount(ctx: Ctx) {
  return one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM support_cases WHERE status = 'open'")!.n;
}
