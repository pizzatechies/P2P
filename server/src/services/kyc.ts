import { createHash } from "node:crypto";
import { recordSmileResult, smileConfigured, startEnhancedKyc, type IdentityDetails, type SmileWebhook } from "./smileid.js";
import { screenForCustomer, underSanctionsReview } from "./sanctions.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { badRequest, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { addAlert } from "./security.js";
import { audit, getUserRow, type UserRow } from "./users.js";

/**
 * Identity verification (KYC) and the limits it unlocks.
 *  Level 0  Basic: email sign-up. Low limits.
 *  Level 1  Identity: legal name, date of birth, address, phone, an ID document and a selfie.
 *  Level 2  Enhanced: level 1 plus proof of address, occupation and source of funds.
 * Personal details and documents are encrypted with MASTER_KEY. An admin approves each level
 * (or KYC_AUTO_APPROVE in development). Records are kept after an account closes, as AML rules require.
 */
export const LEVELS = [
  { level: 0, name: "Basic", summary: "Email sign-up" },
  { level: 1, name: "Verified identity", summary: "ID document, selfie and address" },
  { level: 2, name: "Enhanced", summary: "Proof of address and source of funds" },
] as const;

export type DocKind = "id_front" | "id_back" | "selfie" | "proof_of_address";
export const DOC_LABEL: Record<DocKind, string> = {
  id_front: "ID document (front)",
  id_back: "ID document (back)",
  selfie: "Selfie holding your ID",
  proof_of_address: "Proof of address",
};
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_DOCS_PER_USER = 30;

const iso2 = z.string().trim().length(2).transform((c) => c.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/, "Use a 2-letter country code"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(d)), "Check the date");
const ageOn = (dob: string, now = new Date()) => {
  const d = new Date(dob);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
};

export const Level1Schema = z.object({
  legalName: z.string().trim().min(2).max(100).regex(/^[\p{L}\p{M}' .-]+$/u, "Use your name exactly as on your ID"),
  dateOfBirth: isoDate.refine((d) => ageOn(d) >= 18, "You must be 18 or older").refine((d) => ageOn(d) <= 120, "Check your date of birth"),
  nationality: iso2,
  phone: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,19}$/, "Use an international number, e.g. +254 712 345 678"),
  address: z.object({
    line1: z.string().trim().min(2).max(120),
    line2: z.string().trim().max(120).optional().default(""),
    city: z.string().trim().min(1).max(60),
    region: z.string().trim().max(60).optional().default(""),
    postalCode: z.string().trim().max(20).optional().default(""),
    country: iso2,
  }),
  idType: z.enum(["passport", "national_id", "drivers_license"]),
  idNumber: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9 -]+$/, "Letters, numbers, spaces and dashes only"),
  idCountry: iso2,
  idExpiry: isoDate.refine((d) => Date.parse(d) > Date.now(), "This ID has expired"),
});
export type Level1Data = z.infer<typeof Level1Schema>;

export const Level2Schema = z
  .object({
    occupation: z.string().trim().min(2).max(80),
    employer: z.string().trim().max(100).optional().default(""),
    sourceOfFunds: z.enum(["salary", "business", "savings", "investments", "inheritance", "gift", "other"]),
    sourceDetails: z.string().trim().min(5).max(500),
    expectedMonthlyUsd: z.enum(["under_1k", "1k_5k", "5k_25k", "over_25k"]),
    pep: z.boolean(),
    pepDetails: z.string().trim().max(300).optional().default(""),
    proofOfAddressDate: isoDate.refine((d) => Date.now() - Date.parse(d) <= 92 * 86_400_000 && Date.parse(d) <= Date.now() + 86_400_000, "The document must be from the last 3 months"),
  })
  .refine((d) => !d.pep || d.pepDetails.length >= 5, { message: "Tell us about the public role", path: ["pepDetails"] });
export type Level2Data = z.infer<typeof Level2Schema>;

interface SubmissionRow {
  id: string;
  user_id: string;
  level: 1 | 2;
  status: "draft" | "submitted" | "approved" | "rejected";
  data_enc: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  provider?: string | null;
  provider_job_id?: string | null;
  provider_status?: string | null;
  provider_result?: string | null;
}

interface DocRow {
  id: string;
  user_id: string;
  kind: DocKind;
  mime: string;
  size: number;
  sha256: string;
  data_enc: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export function levelLimits(ctx: Ctx, level: number) {
  if (level >= 2) return { txUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD };
  if (level === 1) return { txUsd: Math.min(ctx.config.TIER1_TX_USD, ctx.config.MAX_TX_USD), dailyUsd: Math.min(ctx.config.TIER1_DAILY_USD, ctx.config.DAILY_LIMIT_USD) };
  return { txUsd: Math.min(ctx.config.TIER0_TX_USD, ctx.config.MAX_TX_USD), dailyUsd: Math.min(ctx.config.TIER0_DAILY_USD, ctx.config.DAILY_LIMIT_USD) };
}

/** The limits that apply to a user: their level's, unless an admin set an override. Staff accounts aren't tiered. */
export function limitsFor(ctx: Ctx, user: Pick<UserRow, "kyc_level" | "role" | "limit_tx_usd" | "limit_daily_usd">) {
  const tiered = ctx.config.KYC_LIMITS && user.role !== "admin";
  const base = tiered ? levelLimits(ctx, user.kyc_level) : { txUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD };
  return {
    level: user.kyc_level,
    tiered,
    txUsd: user.limit_tx_usd ?? base.txUsd,
    dailyUsd: user.limit_daily_usd ?? base.dailyUsd,
    overridden: user.limit_tx_usd !== null || user.limit_daily_usd !== null,
  };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------
function latest(ctx: Ctx, userId: string, level: 1 | 2) {
  return one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE user_id = ? AND level = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", userId, level);
}

const decryptData = <T>(ctx: Ctx, row: SubmissionRow | undefined) => (row?.data_enc ? (JSON.parse(decryptSecret(row.data_enc, ctx.config.masterKey)) as T) : null);

function latestDocs(ctx: Ctx, userId: string) {
  const rows = all<Omit<DocRow, "data_enc">>(ctx.db, "SELECT id, user_id, kind, mime, size, sha256, created_at FROM kyc_documents WHERE user_id = ? ORDER BY created_at DESC, rowid DESC", userId);
  const byKind = new Map<DocKind, Omit<DocRow, "data_enc">>();
  for (const r of rows) if (!byKind.has(r.kind)) byKind.set(r.kind, r);
  return byKind;
}

export function requiredDocs(level: 1 | 2, data: Level1Data | null): DocKind[] {
  if (level === 2) return ["proof_of_address"];
  const docs: DocKind[] = ["id_front", "selfie"];
  if (data && data.idType !== "passport") docs.splice(1, 0, "id_back");
  return docs;
}

const submissionView = (row: SubmissionRow | undefined) =>
  row
    ? { id: row.id, status: row.status, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, reviewNote: row.status === "rejected" ? row.review_note : null }
    : null;

/** Everything the Account page shows about verification. */
export function verificationOverview(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const docs = latestDocs(ctx, userId);
  const l1 = latest(ctx, userId, 1);
  const l2 = latest(ctx, userId, 2);
  const l1Data = decryptData<Level1Data>(ctx, l1);
  const level = (lvl: 1 | 2, row: SubmissionRow | undefined, data: unknown) => {
    const needed = requiredDocs(lvl, lvl === 1 ? (data as Level1Data | null) : null);
    return {
      level: lvl,
      submission: submissionView(row),
      data,
      documents: needed.map((kind) => {
        const d = docs.get(kind);
        return { kind, label: DOC_LABEL[kind], uploaded: Boolean(d), uploadedAt: d?.created_at ?? null, id: d?.id ?? null };
      }),
      limits: levelLimits(ctx, lvl),
    };
  };
  return {
    currentLevel: user.kyc_level,
    levels: LEVELS.map((l) => ({ ...l, limits: levelLimits(ctx, l.level) })),
    limits: limitsFor(ctx, user),
    identity: level(1, l1, l1Data),
    enhanced: level(2, l2, decryptData<Level2Data>(ctx, l2)),
    autoApprove: ctx.config.KYC_AUTO_APPROVE,
  };
}

/** Saves (or replaces) the details for a level while it isn't under review or approved. */
export function saveDetails(ctx: Ctx, userId: string, level: 1 | 2, raw: unknown) {
  const user = getUserRow(ctx, userId);
  if (level === 2 && user.kyc_level < 1) throw unprocessable("identity_first", "Verify your identity (level 1) before applying for enhanced verification");
  if (user.kyc_level >= level) throw unprocessable("already_verified", "You're already verified at this level");
  const parsed = level === 1 ? Level1Schema.safeParse(raw) : Level2Schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`${issue.path.join(".") || "details"}: ${issue.message}`);
  }
  const current = latest(ctx, userId, level);
  if (current?.status === "submitted") throw unprocessable("under_review", "Your details are being reviewed. You can change them if they're rejected.");
  const enc = encryptSecret(JSON.stringify(parsed.data), ctx.config.masterKey);
  const now = nowIso();
  if (current && current.status === "draft") {
    run(ctx.db, "UPDATE kyc_submissions SET data_enc = ?, updated_at = ? WHERE id = ?", enc, now, current.id);
  } else {
    run(
      ctx.db,
      "INSERT INTO kyc_submissions (id, user_id, level, status, data_enc, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)",
      newId("kyc"),
      userId,
      level,
      enc,
      now,
      now,
    );
  }
  return verificationOverview(ctx, userId);
}

/** Checks a file really is a JPEG, PNG, WebP or PDF (by its first bytes, not the name the browser gave it). */
export function sniffDocument(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

export function uploadDocument(ctx: Ctx, userId: string, kind: DocKind, body: Buffer) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("Choose a file to upload");
  if (body.length > MAX_DOC_BYTES) throw badRequest("Files can be up to 5 MB");
  if (body.length < 1024) throw badRequest("That file is too small to be a readable photo or scan");
  const mime = sniffDocument(body);
  if (!mime) throw badRequest("Upload a JPEG, PNG or WebP photo, or a PDF");
  if (kind === "selfie" && mime === "application/pdf") throw badRequest("Your selfie must be a photo");
  const count = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM kyc_documents WHERE user_id = ?", userId)!.n;
  if (count >= MAX_DOCS_PER_USER) throw unprocessable("too_many_documents", "You've uploaded a lot of documents. Contact support to continue.");
  const id = newId("doc");
  run(
    ctx.db,
    "INSERT INTO kyc_documents (id, user_id, kind, mime, size, sha256, data_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    kind,
    mime,
    body.length,
    createHash("sha256").update(body).digest("hex"),
    encryptSecret(body.toString("base64"), ctx.config.masterKey),
    nowIso(),
  );
  return { id, kind, mime, size: body.length };
}

/** A document's decrypted bytes. Users may read their own; admins any (and each view is audited by the route). */
export function readDocument(ctx: Ctx, docId: string, ownerId?: string) {
  const row = one<DocRow>(ctx.db, "SELECT * FROM kyc_documents WHERE id = ?", docId);
  if (!row || (ownerId && row.user_id !== ownerId)) throw notFound("Document not found");
  return { mime: row.mime, kind: row.kind, userId: row.user_id, bytes: Buffer.from(decryptSecret(row.data_enc, ctx.config.masterKey), "base64") };
}

export async function submitLevel(ctx: Ctx, userId: string, level: 1 | 2, ip?: string) {
  const sub = latest(ctx, userId, level);
  if (!sub || sub.status !== "draft" || !sub.data_enc) throw unprocessable("details_missing", "Fill in and save your details first");
  const data = decryptData<Level1Data>(ctx, sub);
  const docs = latestDocs(ctx, userId);
  const missing = requiredDocs(level, level === 1 ? data : null).filter((k) => !docs.has(k));
  if (missing.length) throw unprocessable("documents_missing", `Upload: ${missing.map((k) => DOC_LABEL[k]).join(", ")}`);
  run(ctx.db, "UPDATE kyc_submissions SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), sub.id);
  audit(ctx, userId, "kyc.submitted", { level, submissionId: sub.id }, ip);
  const flagged = level === 1 && data?.legalName ? screenForCustomer(ctx, userId, data.legalName, "legal_name", Number(data.dateOfBirth?.slice(0, 4)) || null).length > 0 : false;
  // With Smile ID, the ID number is checked against government records; approval waits for that result.
  let checking = false;
  if (level === 1 && data && smileConfigured(ctx)) {
    const user = getUserRow(ctx, userId);
    const started = await startEnhancedKyc(ctx, userId, sub.id, data as unknown as IdentityDetails, user.email).catch((err: Error) => ({ started: false as const, reason: err.message }));
    checking = started.started;
    if (!started.started) {
      run(ctx.db, "UPDATE kyc_submissions SET provider = 'smileid', provider_status = 'skipped', provider_result = ? WHERE id = ?", JSON.stringify({ status: "skipped", reason: started.reason }), sub.id);
    }
  }
  if (ctx.config.KYC_AUTO_APPROVE && !checking && !flagged && !underSanctionsReview(ctx, userId)) applyReview(ctx, null, sub.id, "approve", "Approved automatically (KYC_AUTO_APPROVE)", ip);
  return verificationOverview(ctx, userId);
}

function applyReview(ctx: Ctx, reviewerId: string | null, submissionId: string, decision: "approve" | "reject", note: string | undefined, ip?: string) {
  const sub = one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE id = ?", submissionId);
  if (!sub) throw notFound("Submission not found");
  if (sub.status !== "submitted") throw unprocessable("not_pending", `This submission is ${sub.status}`);
  if (reviewerId && reviewerId === sub.user_id) throw forbidden("You can't review your own verification");
  if (decision === "reject" && !note?.trim()) throw badRequest("Say why, so the customer can fix it");
  tx(ctx.db, () => {
    run(
      ctx.db,
      "UPDATE kyc_submissions SET status = ?, reviewed_at = ?, reviewer_id = ?, review_note = ?, updated_at = ? WHERE id = ?",
      decision === "approve" ? "approved" : "rejected",
      nowIso(),
      reviewerId,
      note?.trim() || null,
      nowIso(),
      sub.id,
    );
    if (decision === "approve") run(ctx.db, "UPDATE users SET kyc_level = MAX(kyc_level, ?) WHERE id = ?", sub.level, sub.user_id);
  });
  audit(ctx, reviewerId, `kyc.${decision === "approve" ? "approved" : "rejected"}`, { userId: sub.user_id, level: sub.level, submissionId: sub.id }, ip);
  addAlert(
    ctx,
    sub.user_id,
    "account",
    decision === "approve"
      ? `Your ${sub.level === 1 ? "identity" : "enhanced"} verification was approved. Your limits have gone up.`
      : `Your ${sub.level === 1 ? "identity" : "enhanced"} verification needs another look: ${note?.trim()}`,
    ip,
  );
}

export function reviewSubmission(ctx: Ctx, reviewerId: string, submissionId: string, decision: "approve" | "reject", note?: string, ip?: string) {
  applyReview(ctx, reviewerId, submissionId, decision, note, ip);
}

/** Admin review queue: submissions with their details and document list. */
export function listSubmissions(ctx: Ctx, status: "submitted" | "all" = "submitted") {
  const rows = all<SubmissionRow & { email: string; handle: string; display_name: string; kyc_level: number }>(
    ctx.db,
    `SELECT k.*, u.email, u.handle, u.display_name, u.kyc_level FROM kyc_submissions k JOIN users u ON u.id = k.user_id
     WHERE k.status <> 'draft' AND (? = 'all' OR k.status = 'submitted')
     ORDER BY k.submitted_at DESC LIMIT 100`,
    status,
  );
  return rows.map((r) => {
    const docs = latestDocs(ctx, r.user_id);
    const data = decryptData<Record<string, unknown>>(ctx, r);
    return {
      id: r.id,
      level: r.level,
      status: r.status,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      user: { id: r.user_id, email: r.email, handle: r.handle, displayName: r.display_name, kycLevel: r.kyc_level },
      data,
      check: r.provider ? { provider: r.provider, status: r.provider_status, result: r.provider_result ? (JSON.parse(r.provider_result) as Record<string, unknown>) : null } : null,
      documents: requiredDocs(r.level, r.level === 1 ? (data as Level1Data | null) : null).map((kind) => {
        const d = docs.get(kind);
        return { kind, label: DOC_LABEL[kind], id: d?.id ?? null, mime: d?.mime ?? null, size: d?.size ?? null, uploadedAt: d?.created_at ?? null };
      }),
    };
  });
}

/** An admin sets a level directly (e.g. verified in person). Audited and shown to the user. */
export function setLevel(ctx: Ctx, adminId: string, userId: string, level: 0 | 1 | 2, note: string, ip?: string) {
  if (adminId === userId) throw forbidden("You can't change your own verification level");
  getUserRow(ctx, userId);
  run(ctx.db, "UPDATE users SET kyc_level = ? WHERE id = ?", level, userId);
  audit(ctx, adminId, "kyc.level_set", { userId, level, note }, ip);
  addAlert(ctx, userId, "account", `Your verification level is now ${LEVELS[level].name}.`, ip);
}

/** The user's own verification records, for their data export (documents listed, not embedded). */
export function exportVerification(ctx: Ctx, userId: string) {
  const subs = all<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE user_id = ? ORDER BY created_at", userId);
  return {
    level: getUserRow(ctx, userId).kyc_level,
    submissions: subs.map((s) => ({ level: s.level, status: s.status, submittedAt: s.submitted_at, reviewedAt: s.reviewed_at, reviewNote: s.review_note, details: decryptData(ctx, s) })),
    documents: all<{ id: string; kind: string; mime: string; size: number; created_at: string }>(
      ctx.db,
      "SELECT id, kind, mime, size, created_at FROM kyc_documents WHERE user_id = ? ORDER BY created_at",
      userId,
    ).map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, size: d.size, uploadedAt: d.created_at, download: `/api/account/documents/${d.id}` })),
  };
}

/**
 * Response headers for serving an identity document. Documents are customer uploads, so they are never
 * cached, images render inside a CSP sandbox (no scripts, no same-origin access), and PDFs download
 * instead of opening inside the app's origin.
 */
export function documentHeaders(doc: { kind: string; mime: string }): Record<string, string> {
  const pdf = doc.mime === "application/pdf";
  return {
    "Content-Type": doc.mime,
    "Content-Disposition": `${pdf ? "attachment" : "inline"}; filename="${doc.kind}.${pdf ? "pdf" : doc.mime.split("/")[1]}"`,
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/** The identity details of a submission (decrypted), for comparing with a government record. */
export function submissionIdentity(ctx: Ctx, submissionId: string): IdentityDetails | null {
  const row = one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE id = ?", submissionId);
  return row ? decryptData<IdentityDetails>(ctx, row) : null;
}

/**
 * A Smile ID result arrived: record it, and approve automatically when the government record confirms
 * this person (SMILEID_AUTO_APPROVE) and nothing else needs a human. Everything else waits for review,
 * with the result shown to the reviewer.
 */
export function applySmileResult(ctx: Ctx, payload: SmileWebhook) {
  const out = recordSmileResult(ctx, payload, (id) => submissionIdentity(ctx, id));
  if (!out) return null;
  audit(ctx, null, "kyc.government_check", { submissionId: out.submissionId, status: out.result.status, verified: out.verified });
  const sub = one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE id = ?", out.submissionId)!;
  if (out.verified && sub.status === "submitted" && (ctx.config.SMILEID_AUTO_APPROVE || ctx.config.KYC_AUTO_APPROVE) && !underSanctionsReview(ctx, out.userId)) {
    applyReview(ctx, null, sub.id, "approve", "Approved automatically: ID confirmed against government records (Smile ID), name and date of birth match");
  }
  return out;
}
