import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { badRequest, notFound, unprocessable } from "../lib/errors.js";
import { audit, getUserRow } from "./users.js";

/**
 * Record retention: once an account has been closed for RECORD_RETENTION_YEARS (0 = keep everything,
 * the default), the customer's personal data is deleted: identity details and documents, company
 * documents and people, their support messages, payout destinations, security history and staff
 * notes, and the account itself is anonymised. What the law requires to stay unchanged stays: the
 * ledger, the sealed audit log, compliance cases and screening evidence (none of which can be edited).
 * An account with an open or escalated compliance case, or under a legal hold, is skipped.
 */

const REMOVED = "[Removed under the record retention policy]";

export const retentionOn = (ctx: Ctx) => ctx.config.RECORD_RETENTION_YEARS > 0;

function cutoff(ctx: Ctx, now = Date.now()) {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - ctx.config.RECORD_RETENTION_YEARS);
  return d.toISOString();
}

/** Why an account can't be purged yet, or null. */
function holdReason(ctx: Ctx, u: { id: string; legal_hold_at: string | null; legal_hold_reason: string | null }) {
  if (u.legal_hold_at) return `Legal hold: ${u.legal_hold_reason ?? "no reason given"}`;
  if (one(ctx.db, "SELECT 1 FROM compliance_alerts WHERE user_id = ? AND status IN ('open','escalated') LIMIT 1", u.id)) return "An open or escalated compliance case";
  if (one(ctx.db, "SELECT 1 FROM external_transfers WHERE user_id = ? AND status IN ('pending','processing') LIMIT 1", u.id)) return "A payment still in progress";
  return null;
}

/** Closed accounts whose retention period has ended (and those coming up within 90 days). */
export function retentionQueue(ctx: Ctx, now = Date.now()) {
  if (!retentionOn(ctx)) return [];
  const soon = new Date(now + 90 * 86_400_000);
  soon.setUTCFullYear(soon.getUTCFullYear() - ctx.config.RECORD_RETENTION_YEARS);
  return all<{ id: string; handle: string; closed_at: string; legal_hold_at: string | null; legal_hold_reason: string | null }>(
    ctx.db,
    "SELECT id, handle, closed_at, legal_hold_at, legal_hold_reason FROM users WHERE closed_at IS NOT NULL AND purged_at IS NULL AND closed_at < ? ORDER BY closed_at LIMIT 500",
    soon.toISOString(),
  ).map((u) => {
    const purgeAfter = new Date(u.closed_at);
    purgeAfter.setUTCFullYear(purgeAfter.getUTCFullYear() + ctx.config.RECORD_RETENTION_YEARS);
    return { id: u.id, handle: u.handle, closedAt: u.closed_at, purgeAfter: purgeAfter.toISOString(), due: u.closed_at < cutoff(ctx, now), hold: holdReason(ctx, u) };
  });
}

/** Deletes a closed account's personal data and anonymises it. Returns what was removed. */
export function purgeAccount(ctx: Ctx, userId: string, actorId: string | null, ip?: string) {
  const u = one<{ id: string; closed_at: string | null; purged_at: string | null; legal_hold_at: string | null; legal_hold_reason: string | null }>(
    ctx.db,
    "SELECT id, closed_at, purged_at, legal_hold_at, legal_hold_reason FROM users WHERE id = ?",
    userId,
  );
  if (!u) throw notFound("No such account");
  if (!u.closed_at) throw unprocessable("not_closed", "Only closed accounts are deleted under the retention policy");
  if (u.purged_at) throw unprocessable("already_purged", "This account's personal data was already deleted");
  const hold = holdReason(ctx, u);
  if (hold) throw unprocessable("on_hold", `Kept: ${hold}`);
  const n = (sql: string, ...args: (string | null)[]) => Number(run(ctx.db, sql, ...args).changes);
  const removed = tx(ctx.db, () => {
    const out = {
      identityDocuments: n("DELETE FROM kyc_documents WHERE user_id = ?", userId),
      identityDetails: n("UPDATE kyc_submissions SET data_enc = NULL, provider_result = NULL, selfie_result = NULL WHERE user_id = ? AND (data_enc IS NOT NULL OR provider_result IS NOT NULL OR selfie_result IS NOT NULL)", userId),
      liveSelfies: n("DELETE FROM kyc_liveness WHERE user_id = ?", userId),
      accountApplications: n("UPDATE live_applications SET data_enc = NULL WHERE user_id = ? AND data_enc IS NOT NULL", userId),
      businessDocuments: n("DELETE FROM business_documents WHERE user_id = ?", userId),
      businessPeople: n("UPDATE business_profiles SET people_enc = NULL, website = NULL WHERE user_id = ? AND (people_enc IS NOT NULL OR website IS NOT NULL)", userId),
      personPhotos: n("DELETE FROM business_person_documents WHERE check_id IN (SELECT id FROM business_person_checks WHERE business_user_id = ?)", userId),
      personChecks: n("UPDATE business_person_checks SET email_enc = NULL, data_enc = NULL, provider_result = NULL, token_hash = NULL WHERE business_user_id = ?", userId),
      payoutDestinations: n("UPDATE external_transfers SET destination = NULL WHERE user_id = ? AND destination IS NOT NULL", userId),
      paymentNotes: n("UPDATE payment_requests SET memo = NULL WHERE (requester_id = ? OR payer_id = ?) AND memo IS NOT NULL", userId, userId),
      supportMessages: n(`UPDATE support_messages SET body = ? WHERE case_id IN (SELECT id FROM support_cases WHERE user_id = ?) AND body <> ?`, REMOVED, userId, REMOVED),
      supportCases: n("UPDATE support_cases SET subject = ?, resolution = NULL WHERE user_id = ? AND subject <> ?", REMOVED, userId, REMOVED),
      staffNotes: n("DELETE FROM account_notes WHERE user_id = ?", userId),
      securityHistory:
        n("DELETE FROM security_alerts WHERE user_id = ?", userId) +
        n("DELETE FROM sessions WHERE user_id = ?", userId) +
        n("DELETE FROM recovery_codes WHERE user_id = ?", userId) +
        n("DELETE FROM email_codes WHERE user_id = ?", userId) +
        n("DELETE FROM password_resets WHERE user_id = ?", userId),
      providerLinks: n("DELETE FROM provider_customers WHERE user_id = ?", userId) + n("DELETE FROM linked_accounts WHERE user_id = ?", userId),
    };
    const tag = randomBytes(4).toString("hex");
    run(
      ctx.db,
      `UPDATE users SET email = ?, handle = ?, display_name = 'Deleted customer', password_hash = '!', totp_secret_enc = NULL, totp_enabled = 0, push_topic_enc = NULL, push_enabled_at = NULL, purged_at = ? WHERE id = ?`,
      `deleted-${userId}@deleted.invalid`,
      `deleted_${tag}`,
      nowIso(),
      userId,
    );
    return out;
  });
  audit(ctx, actorId, "retention.purged", { target: userId, closedAt: u.closed_at, removed }, ip);
  return removed;
}

/** Purges every account whose retention period has ended (skipping those on hold). */
export function runRetention(ctx: Ctx, actorId: string | null = null, ip?: string) {
  if (!retentionOn(ctx)) return { purged: 0, kept: 0 };
  let purged = 0;
  let kept = 0;
  for (const r of retentionQueue(ctx).filter((x) => x.due)) {
    if (r.hold) {
      kept++;
      continue;
    }
    purgeAccount(ctx, r.id, actorId, ip);
    purged++;
  }
  return { purged, kept };
}

/** Keeps a customer's records past the retention period (an investigation, a court order, a dispute). */
export function setLegalHold(ctx: Ctx, adminId: string, userId: string, hold: boolean, reason: string | undefined, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (hold && (!reason || reason.trim().length < 3)) throw badRequest("Say why the records must be kept");
  run(ctx.db, "UPDATE users SET legal_hold_at = ?, legal_hold_reason = ? WHERE id = ?", hold ? nowIso() : null, hold ? reason!.trim().slice(0, 300) : null, user.id);
  audit(ctx, adminId, hold ? "retention.hold_set" : "retention.hold_lifted", { target: user.id, reason: hold ? reason!.trim() : null }, ip);
}

/** Daily. Started from index.ts. */
export function startRetentionJob(ctx: Ctx, everyMs = 24 * 3600_000) {
  if (!retentionOn(ctx)) return () => undefined;
  const tick = () => {
    try {
      const r = runRetention(ctx);
      if (r.purged || r.kept) console.log(`[retention] ${r.purged} closed accounts' personal data deleted; ${r.kept} kept on hold`);
    } catch (err) {
      console.error("[retention]", err);
    }
  };
  const first = setTimeout(tick, 5 * 60_000);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
