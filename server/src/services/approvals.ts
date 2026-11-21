import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { limitsFor, setLevel } from "./kyc.js";
import { notifyAdmins } from "./monitoring.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Two-person approval for the admin changes that unlock the most money: a customer's own limits, and
 * setting an identity level by hand. One admin asks; a different admin approves (with a fresh password
 * check) before anything changes. TWO_PERSON_APPROVAL: "on" always, "off" never, "auto" (default)
 * whenever there's another admin who could approve, so a one-person team isn't locked out.
 */

export type Kind = "limits" | "kyc_level";
export interface LimitsChange { txUsd: number | null; dailyUsd: number | null }
export interface LevelChange { level: 0 | 1 | 2; note: string }

interface RequestRow {
  id: string;
  kind: Kind;
  target_user_id: string;
  payload: string;
  reason: string | null;
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/** Other active admins who could approve (with 2FA, when admins must have it). */
export function otherApprovers(ctx: Ctx, requesterId: string) {
  return one<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND closed_at IS NULL AND id <> ? AND (? = 0 OR totp_enabled = 1)",
    requesterId,
    ctx.config.REQUIRE_ADMIN_2FA ? 1 : 0,
  )!.n;
}

export function secondPersonRequired(ctx: Ctx, requesterId: string) {
  const mode = ctx.config.TWO_PERSON_APPROVAL;
  if (mode === "off") return false;
  if (mode === "on") return true;
  return otherApprovers(ctx, requesterId) > 0;
}

function describe(kind: Kind, payload: LimitsChange | LevelChange) {
  if (kind === "limits") {
    const p = payload as LimitsChange;
    return p.txUsd === null && p.dailyUsd === null
      ? "limits back to their verification level"
      : `limits to $${p.txUsd?.toLocaleString("en-US") ?? "level default"} per payment and $${p.dailyUsd?.toLocaleString("en-US") ?? "level default"} a day`;
  }
  return `identity level ${(payload as LevelChange).level}`;
}

function applyLimits(ctx: Ctx, actorId: string, target: string, p: LimitsChange, ip?: string, approval?: { requestedBy: string }) {
  run(ctx.db, "UPDATE users SET limit_tx_usd = ?, limit_daily_usd = ? WHERE id = ?", p.txUsd, p.dailyUsd, target);
  audit(ctx, actorId, "admin.limits_set", { target, ...p, ...(approval ? { requestedBy: approval.requestedBy, approvedBy: actorId } : {}) }, ip);
  const l = limitsFor(ctx, getUserRow(ctx, target));
  addAlert(ctx, target, "account", `Your limits were changed by our team: $${l.txUsd.toLocaleString("en-US")} per payment and $${l.dailyUsd.toLocaleString("en-US")} a day.`);
}

function apply(ctx: Ctx, actorId: string, kind: Kind, target: string, payload: LimitsChange | LevelChange, ip?: string, approval?: { requestedBy: string }) {
  if (kind === "limits") applyLimits(ctx, actorId, target, payload as LimitsChange, ip, approval);
  else {
    const p = payload as LevelChange;
    setLevel(ctx, actorId, target, p.level, approval ? `${p.note} (asked by another admin, approved by this one)` : p.note, ip);
  }
}

/** Applies the change now, or files it for another admin when a second person is needed. */
export function requestChange(ctx: Ctx, requesterId: string, kind: Kind, targetId: string, payload: LimitsChange | LevelChange, ip?: string) {
  const target = getUserRow(ctx, targetId);
  if (target.id === requesterId) throw new HttpError(400, "bad_request", kind === "limits" ? "You can't change your own limits" : "You can't change your own verification level");
  if (!secondPersonRequired(ctx, requesterId)) {
    apply(ctx, requesterId, kind, target.id, payload, ip);
    return { applied: true as const, request: null };
  }
  const id = newId("apr");
  tx(ctx.db, () => {
    // A newer request for the same change replaces an older one still waiting.
    run(ctx.db, "UPDATE admin_requests SET status = 'cancelled', decided_at = ? WHERE kind = ? AND target_user_id = ? AND status = 'pending'", nowIso(), kind, target.id);
    run(
      ctx.db,
      "INSERT INTO admin_requests (id, kind, target_user_id, payload, reason, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      id,
      kind,
      target.id,
      JSON.stringify(payload),
      kind === "kyc_level" ? (payload as LevelChange).note : null,
      requesterId,
      nowIso(),
    );
  });
  audit(ctx, requesterId, "admin.change_requested", { id, kind, target: target.id, ...payload }, ip);
  const who = getUserRow(ctx, requesterId);
  notifyAdmins(ctx, `@${who.handle} asks to set @${target.handle}'s ${describe(kind, payload)}. Another admin must approve it (Admin → Waiting for approval).`, requesterId);
  return { applied: false as const, request: view(ctx, one<RequestRow>(ctx.db, "SELECT * FROM admin_requests WHERE id = ?", id)!) };
}

function view(ctx: Ctx, r: RequestRow) {
  const handle = (id: string | null) => (id ? (one<{ handle: string }>(ctx.db, "SELECT handle FROM users WHERE id = ?", id)?.handle ?? null) : null);
  const payload = JSON.parse(r.payload) as LimitsChange | LevelChange;
  return {
    id: r.id,
    kind: r.kind,
    summary: describe(r.kind, payload),
    payload,
    target: { id: r.target_user_id, handle: handle(r.target_user_id) },
    requestedBy: { id: r.requested_by, handle: handle(r.requested_by) },
    status: r.status,
    decidedBy: r.decided_by ? { id: r.decided_by, handle: handle(r.decided_by) } : null,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}

export function listRequests(ctx: Ctx, status: "pending" | "all" = "pending") {
  return all<RequestRow>(ctx.db, "SELECT * FROM admin_requests WHERE (? = 'all' OR status = 'pending') ORDER BY created_at DESC LIMIT 200", status).map((r) => view(ctx, r));
}

function loadPending(ctx: Ctx, id: string) {
  const r = one<RequestRow>(ctx.db, "SELECT * FROM admin_requests WHERE id = ?", id);
  if (!r) throw notFound("Request not found");
  if (r.status !== "pending") throw unprocessable("not_pending", `This request was already ${r.status}`);
  return r;
}

export function decideRequest(ctx: Ctx, approverId: string, id: string, decision: "approve" | "reject", note: string | undefined, ip?: string) {
  const r = loadPending(ctx, id);
  if (r.requested_by === approverId) throw forbidden("A different admin must approve your request");
  if (r.target_user_id === approverId) throw forbidden("You can't approve a change to your own account");
  if (decision === "reject" && !note?.trim()) throw badRequest("Say why, so the admin who asked knows");
  tx(ctx.db, () => {
    const changed = run(ctx.db, "UPDATE admin_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'", decision === "approve" ? "approved" : "rejected", approverId, nowIso(), note?.trim() || null, id);
    if (Number(changed.changes) !== 1) throw unprocessable("not_pending", "This request was just decided by someone else");
    if (decision === "approve") apply(ctx, approverId, r.kind, r.target_user_id, JSON.parse(r.payload) as LimitsChange | LevelChange, ip, { requestedBy: r.requested_by });
  });
  audit(ctx, approverId, decision === "approve" ? "admin.change_approved" : "admin.change_rejected", { id, kind: r.kind, target: r.target_user_id, requestedBy: r.requested_by }, ip);
  const approver = getUserRow(ctx, approverId);
  const summary = describe(r.kind, JSON.parse(r.payload) as LimitsChange | LevelChange);
  addAlert(ctx, r.requested_by, "account", decision === "approve" ? `@${approver.handle} approved your request (${summary}); it's now in effect.` : `@${approver.handle} turned down your request (${summary}): ${note?.trim()}`);
  return view(ctx, one<RequestRow>(ctx.db, "SELECT * FROM admin_requests WHERE id = ?", id)!);
}

export function cancelRequest(ctx: Ctx, requesterId: string, id: string, ip?: string) {
  const r = loadPending(ctx, id);
  if (r.requested_by !== requesterId) throw forbidden("Only the admin who asked can withdraw a request");
  run(ctx.db, "UPDATE admin_requests SET status = 'cancelled', decided_at = ? WHERE id = ?", nowIso(), id);
  audit(ctx, requesterId, "admin.change_cancelled", { id }, ip);
}
