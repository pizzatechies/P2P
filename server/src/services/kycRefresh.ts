import type { Ctx } from "../context.js";
import { all, one, run } from "../db/index.js";
import { decryptSecret } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { emailNotice } from "./email.js";
import { addAlert } from "./security.js";

/**
 * Keeping customers' identity details current (ongoing due diligence). A verified customer is asked
 * to update their details when their ID expires, or when KYC_REFRESH_YEARS have passed since they
 * were approved (KYC_REFRESH_HIGH_RISK_YEARS for confirmed politically exposed persons and customers
 * with an escalated case), whichever comes first. They're reminded 30 days before, on the day, and
 * when the grace period (KYC_REFRESH_GRACE_DAYS) ends; after that, sending and withdrawing pause until
 * they've re-verified with fresh photos. Receiving money keeps working.
 */

const DAY = 86_400_000;
const REMIND_DAYS = 30;

export type RefreshState = "ok" | "soon" | "due" | "restricted" | "in_review";
export type RefreshReason = "id_expired" | "periodic";

export interface RefreshStatus {
  state: RefreshState;
  reason: RefreshReason | null;
  dueAt: string | null;
  restrictAt: string | null;
  highRisk: boolean;
  /** When the last approval's documents were sent: photos must be newer than this for a refresh. */
  lastVerifiedAt: string | null;
}

const OK: RefreshStatus = { state: "ok", reason: null, dueAt: null, restrictAt: null, highRisk: false, lastVerifiedAt: null };

export const refreshOn = (ctx: Ctx) => ctx.config.KYC_REFRESH_YEARS > 0;

function isHighRisk(ctx: Ctx, userId: string) {
  const u = one<{ pep_confirmed_at: string | null }>(ctx.db, "SELECT pep_confirmed_at FROM users WHERE id = ?", userId);
  if (u?.pep_confirmed_at) return true;
  return Boolean(one(ctx.db, "SELECT 1 FROM compliance_alerts WHERE user_id = ? AND status = 'escalated' LIMIT 1", userId));
}

/** Where a customer stands on keeping their identity details current. */
export function refreshStatus(ctx: Ctx, userId: string, now = Date.now()): RefreshStatus {
  if (!refreshOn(ctx)) return OK;
  const user = one<{ kyc_level: number; role: string }>(ctx.db, "SELECT kyc_level, role FROM users WHERE id = ?", userId);
  if (!user || user.kyc_level < 1 || user.role === "admin") return OK;
  const approved = one<{ data_enc: string | null; reviewed_at: string | null; submitted_at: string | null; created_at: string }>(
    ctx.db,
    "SELECT data_enc, reviewed_at, submitted_at, created_at FROM kyc_submissions WHERE user_id = ? AND level = 1 AND status = 'approved' ORDER BY reviewed_at DESC, rowid DESC LIMIT 1",
    userId,
  );
  // A level set by hand (with a second admin's approval) has no record to date from.
  if (!approved?.reviewed_at) return OK;
  let idExpiry: string | null = null;
  try {
    idExpiry = approved.data_enc ? ((JSON.parse(decryptSecret(approved.data_enc, ctx.config.masterKey)) as { idExpiry?: string }).idExpiry ?? null) : null;
  } catch {
    /* unreadable with the current key: date it from the approval */
  }
  const highRisk = isHighRisk(ctx, userId);
  const years = highRisk ? Math.min(ctx.config.KYC_REFRESH_HIGH_RISK_YEARS, ctx.config.KYC_REFRESH_YEARS) : ctx.config.KYC_REFRESH_YEARS;
  const periodic = new Date(approved.reviewed_at);
  periodic.setUTCFullYear(periodic.getUTCFullYear() + years);
  const expiry = idExpiry ? Date.parse(`${idExpiry}T00:00:00Z`) : Number.POSITIVE_INFINITY;
  const due = Math.min(periodic.getTime(), expiry);
  const reason: RefreshReason = expiry <= periodic.getTime() ? "id_expired" : "periodic";
  const restrictAt = due + ctx.config.KYC_REFRESH_GRACE_DAYS * DAY;
  const base = { reason, dueAt: new Date(due).toISOString(), restrictAt: new Date(restrictAt).toISOString(), highRisk, lastVerifiedAt: approved.submitted_at ?? approved.created_at };
  if (now < due - REMIND_DAYS * DAY) return { ...OK, highRisk, lastVerifiedAt: base.lastVerifiedAt };
  // A refresh they've already sent isn't held against them while it's being reviewed.
  const pending = one(ctx.db, "SELECT 1 FROM kyc_submissions WHERE user_id = ? AND level = 1 AND status = 'submitted' AND created_at > ? LIMIT 1", userId, approved.reviewed_at);
  if (pending) return { ...base, state: "in_review" };
  return { ...base, state: now < due ? "soon" : now < restrictAt ? "due" : "restricted" };
}

/** True while the customer may (re)submit identity details at level 1 to refresh them. */
export const refreshOpen = (s: RefreshStatus) => s.state === "soon" || s.state === "due" || s.state === "restricted";

/** Pauses sending and withdrawing once the grace period has passed without updated details. */
export function assertIdentityCurrent(ctx: Ctx, userId: string) {
  const s = refreshStatus(ctx, userId);
  if (s.state !== "restricted") return;
  throw new HttpError(
    403,
    "identity_refresh_required",
    s.reason === "id_expired"
      ? "Your ID has expired. Update your identity details (Account → Identity verification) to send or withdraw money again."
      : "It's time to update your identity details (Account → Identity verification). Sending and withdrawing are paused until you do.",
  );
}

const MESSAGES: Record<"soon" | "due" | "restricted", (s: RefreshStatus) => string> = {
  soon: (s) =>
    `${s.reason === "id_expired" ? "Your ID expires" : "It's time to update your identity details"} on ${s.dueAt!.slice(0, 10)}. Please update them under Account → Identity verification: it takes about 5 minutes.`,
  due: (s) =>
    `${s.reason === "id_expired" ? "Your ID has expired" : "Your identity details are due for an update"}. Please update them under Account → Identity verification by ${s.restrictAt!.slice(0, 10)}, or sending and withdrawing will pause.`,
  restricted: () => "Sending and withdrawing are paused until you update your identity details under Account → Identity verification. Receiving money still works.",
};

/**
 * Reminds customers as they reach each stage (once per stage per due date), in the app and by email.
 * Returns how many reminders went out.
 */
export async function sendRefreshReminders(ctx: Ctx, now = Date.now()) {
  if (!refreshOn(ctx)) return { checked: 0, reminded: 0 };
  let checked = 0;
  let reminded = 0;
  for (const u of all<{ id: string; kyc_refresh_notice: string | null }>(ctx.db, "SELECT id, kyc_refresh_notice FROM users WHERE kyc_level >= 1 AND role <> 'admin' AND closed_at IS NULL")) {
    if (++checked % 200 === 0) await new Promise((r) => setImmediate(r));
    const s = refreshStatus(ctx, u.id, now);
    if (s.state !== "soon" && s.state !== "due" && s.state !== "restricted") continue;
    const notice = `${s.state}:${s.dueAt!.slice(0, 10)}`;
    if (u.kyc_refresh_notice === notice) continue;
    run(ctx.db, "UPDATE users SET kyc_refresh_notice = ? WHERE id = ?", notice, u.id);
    const message = MESSAGES[s.state](s);
    addAlert(ctx, u.id, "account", message);
    await emailNotice(ctx, u.id, s.state === "restricted" ? "Sending is paused: please update your identity details" : "Please update your identity details", [message], { label: "Update my details", url: new URL("/app/account#verification", ctx.config.APP_URL).toString() }).catch(() => false);
    reminded++;
  }
  return { checked, reminded };
}

/** Customers due for an update, for the Admin page. */
export function refreshQueue(ctx: Ctx, now = Date.now()) {
  if (!refreshOn(ctx)) return [];
  const out: { id: string; handle: string; name: string; status: RefreshStatus }[] = [];
  for (const u of all<{ id: string; handle: string; display_name: string }>(ctx.db, "SELECT id, handle, display_name FROM users WHERE kyc_level >= 1 AND role <> 'admin' AND closed_at IS NULL")) {
    const s = refreshStatus(ctx, u.id, now);
    if (s.state !== "ok") out.push({ id: u.id, handle: u.handle, name: u.display_name, status: s });
  }
  const order: Record<RefreshState, number> = { restricted: 0, due: 1, in_review: 2, soon: 3, ok: 4 };
  return out.sort((a, b) => order[a.status.state] - order[b.status.state] || (a.status.dueAt ?? "").localeCompare(b.status.dueAt ?? ""));
}

/** Reminders once a day. Started from index.ts. */
export function startKycRefreshJob(ctx: Ctx, everyMs = 24 * 3600_000) {
  if (!refreshOn(ctx)) return () => undefined;
  const tick = () =>
    sendRefreshReminders(ctx)
      .then((r) => r.reminded && console.log(`[kyc-refresh] ${r.reminded} reminders sent (${r.checked} verified customers checked)`))
      .catch((err) => console.error("[kyc-refresh]", err));
  const first = setTimeout(tick, 60_000);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

