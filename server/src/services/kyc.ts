import { createHash } from "node:crypto";
import { refreshOpen, refreshStatus } from "./kycRefresh.js";
import { pepBlocksAutoApproval, screenPep } from "./pep.js";
import { recordSmileResult, smileConfigured, startEnhancedKyc, type IdentityDetails, type SmileWebhook, isSelfieResult, recordSelfieResult, startSelfieCompare, startBiometricKyc } from "./smileid.js";
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
  selfie_job_id?: string | null;
  selfie_status?: string | null;
  selfie_result?: string | null;
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
/** A level's limits: the country's own, where one is set for it, within the overall caps. */
export function levelLimits(ctx: Ctx, level: number, country?: string | null) {
  if (country) {
    const own = one<{ tx_usd: number; daily_usd: number }>(ctx.db, "SELECT tx_usd, daily_usd FROM country_limits WHERE country = ? AND level = ?", country, Math.min(Math.max(level, 0), 2));
    if (own) return { txUsd: Math.min(own.tx_usd, ctx.config.MAX_TX_USD), dailyUsd: Math.min(own.daily_usd, ctx.config.DAILY_LIMIT_USD) };
  }
  if (level >= 2) return { txUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD };
  if (level === 1) return { txUsd: Math.min(ctx.config.TIER1_TX_USD, ctx.config.MAX_TX_USD), dailyUsd: Math.min(ctx.config.TIER1_DAILY_USD, ctx.config.DAILY_LIMIT_USD) };
  return { txUsd: Math.min(ctx.config.TIER0_TX_USD, ctx.config.MAX_TX_USD), dailyUsd: Math.min(ctx.config.TIER0_DAILY_USD, ctx.config.DAILY_LIMIT_USD) };
}

/**
 * The country a customer's limits follow: the one in their verified address (set when their identity
 * is approved; worked out once for customers verified before limits by country).
 */
export function residenceCountry(ctx: Ctx, user: Pick<UserRow, "id" | "kyc_level">): string | null {
  const row = one<{ residence_country: string | null }>(ctx.db, "SELECT residence_country FROM users WHERE id = ?", user.id);
  if (row?.residence_country) return row.residence_country;
  if (user.kyc_level < 1) return null;
  const sub = one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE user_id = ? AND level = 1 AND status = 'approved' ORDER BY reviewed_at DESC, rowid DESC LIMIT 1", user.id);
  let country: string | null = null;
  try {
    country = decryptData<Level1Data>(ctx, sub)?.address?.country ?? null;
  } catch {
    return null;
  }
  if (country) run(ctx.db, "UPDATE users SET residence_country = ? WHERE id = ?", country, user.id);
  return country;
}

/** The limits that apply to a user: their level's (in their country), unless an admin set an override. Staff accounts aren't tiered. */
export function limitsFor(ctx: Ctx, user: Pick<UserRow, "id" | "kyc_level" | "role" | "limit_tx_usd" | "limit_daily_usd">) {
  const tiered = ctx.config.KYC_LIMITS && user.role !== "admin";
  const country = tiered ? residenceCountry(ctx, user) : null;
  const base = tiered ? levelLimits(ctx, user.kyc_level, country) : { txUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD };
  return {
    level: user.kyc_level,
    country,
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
  const refresh = refreshStatus(ctx, userId);
  const docs = freshDocs(ctx, userId, refresh);
  const country = residenceCountry(ctx, user);
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
      limits: levelLimits(ctx, lvl, country),
    };
  };
  return {
    currentLevel: user.kyc_level,
    levels: LEVELS.map((l) => ({ ...l, limits: levelLimits(ctx, l.level, country) })),
    limits: limitsFor(ctx, user),
    identity: level(1, l1, l1Data),
    enhanced: level(2, l2, decryptData<Level2Data>(ctx, l2)),
    autoApprove: ctx.config.KYC_AUTO_APPROVE,
    liveness: livenessRequired(ctx) ? { required: true, capturedAt: liveCapture(ctx, userId)?.created_at ?? null } : { required: false, capturedAt: null },
    refresh,
  };
}

/**
 * The documents that count: the latest of each kind, and when a verified customer is refreshing their
 * details, only photos taken since their last approval (an old ID photo doesn't prove a new ID).
 */
function freshDocs(ctx: Ctx, userId: string, refresh = refreshStatus(ctx, userId)) {
  const docs = latestDocs(ctx, userId);
  if (!refreshOpen(refresh) && refresh.state !== "in_review") return docs;
  const since = refresh.lastVerifiedAt ?? "";
  for (const [k, d] of docs) if (d.created_at <= since) docs.delete(k);
  return docs;
}

// ---------------------------------------------------------------------------
// Live selfie (Smile ID camera component): a selfie plus liveness frames, sent with Biometric KYC
// ---------------------------------------------------------------------------
export const livenessRequired = (ctx: Ctx) => ctx.config.SMILEID_LIVENESS && smileConfigured(ctx);

interface LiveRow {
  user_id: string;
  selfie_doc_id: string;
  frames_enc: string;
  frame_count: number;
  created_at: string;
}
const liveCapture = (ctx: Ctx, userId: string) => one<LiveRow>(ctx.db, "SELECT * FROM kyc_liveness WHERE user_id = ?", userId);

/** Smile ID's Biometric KYC takes 6 to 8 liveness frames: keep 8 spread across the capture. */
function pickFrames(frames: Buffer[]) {
  if (frames.length <= 8) return frames;
  return Array.from({ length: 8 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 7)]);
}

export function saveLiveCapture(ctx: Ctx, userId: string, selfie: Buffer, frames: Buffer[], ip?: string) {
  if (!livenessRequired(ctx)) throw badRequest("Live selfies aren't switched on");
  const sub = latest(ctx, userId, 1);
  if (sub && sub.status !== "draft" && sub.status !== "rejected") throw unprocessable("locked", "Your identity details are being reviewed or are already approved");
  const jpeg = (b: Buffer) => sniffDocument(b) === "image/jpeg";
  if (!jpeg(selfie) || frames.some((f) => !jpeg(f))) throw badRequest("The camera didn't send JPEG photos. Please try again.");
  if (selfie.length > 3 * 1024 * 1024 || frames.some((f) => f.length > 2 * 1024 * 1024)) throw badRequest("The photos are too large. Please try again.");
  if (frames.length < 6) throw badRequest("The capture was too short to check it's really you. Please try again and follow the prompts.");
  const kept = pickFrames(frames);
  const doc = uploadDocument(ctx, userId, "selfie", selfie);
  run(
    ctx.db,
    `INSERT INTO kyc_liveness (user_id, selfie_doc_id, frames_enc, frame_count, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET selfie_doc_id = excluded.selfie_doc_id, frames_enc = excluded.frames_enc, frame_count = excluded.frame_count, created_at = excluded.created_at`,
    userId,
    doc.id,
    encryptSecret(JSON.stringify(kept.map((f) => f.toString("base64"))), ctx.config.masterKey),
    kept.length,
    nowIso(),
  );
  audit(ctx, userId, "kyc.live_selfie_captured", { frames: kept.length }, ip);
  return verificationOverview(ctx, userId);
}

/** Saves (or replaces) the details for a level while it isn't under review or approved. */
export function saveDetails(ctx: Ctx, userId: string, level: 1 | 2, raw: unknown) {
  const user = getUserRow(ctx, userId);
  if (level === 2 && user.kyc_level < 1) throw unprocessable("identity_first", "Verify your identity (level 1) before applying for enhanced verification");
  // A verified customer can send new identity details when they're due for a refresh.
  if (user.kyc_level >= level && !(level === 1 && refreshOpen(refreshStatus(ctx, userId)))) throw unprocessable("already_verified", "You're already verified at this level");
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
  const docs = level === 1 ? freshDocs(ctx, userId) : latestDocs(ctx, userId);
  const liveNeeded = level === 1 && livenessRequired(ctx);
  // With live selfies on, the selfie comes from the camera, not an upload.
  const missing = requiredDocs(level, level === 1 ? data : null).filter((k) => !docs.has(k) && !(liveNeeded && k === "selfie"));
  if (missing.length) throw unprocessable("documents_missing", `Upload: ${missing.map((k) => DOC_LABEL[k]).join(", ")}`);
  const live = liveNeeded ? liveCapture(ctx, userId) : undefined;
  if (liveNeeded && (!live || live.selfie_doc_id !== docs.get("selfie")?.id)) {
    throw unprocessable("live_selfie_missing", "Take your selfie with the camera first (Identity verification → Take a live selfie)");
  }
  run(ctx.db, "UPDATE kyc_submissions SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), sub.id);
  audit(ctx, userId, "kyc.submitted", { level, submissionId: sub.id }, ip);
  const sanctionsHit = level === 1 && data?.legalName ? screenForCustomer(ctx, userId, data.legalName, "legal_name", Number(data.dateOfBirth?.slice(0, 4)) || null).length > 0 : false;
  // PEP screening (when set up): a possible match, or a check that couldn't run, needs a person.
  const pep = level === 1 && data?.legalName ? await screenPep(ctx, userId, { name: data.legalName, birthDate: data.dateOfBirth, nationality: (data as { nationality?: string }).nationality }, "legal_name") : null;
  const flagged = sanctionsHit || (pep !== null && (pep.status === "match" || pep.status === "error"));
  // With Smile ID, the ID number is checked against government records; approval waits for that result.
  let checking = false;
  if (level === 1 && data && smileConfigured(ctx)) {
    const user = getUserRow(ctx, userId);
    const started = live
      ? await startBiometricKyc(
          ctx,
          userId,
          sub.id,
          data as unknown as IdentityDetails,
          user.email,
          readDocument(ctx, live.selfie_doc_id).bytes,
          (JSON.parse(decryptSecret(live.frames_enc, ctx.config.masterKey)) as string[]).map((f) => Buffer.from(f, "base64")),
        ).catch((err: Error) => ({ started: false as const, reason: err.message }))
      : await startEnhancedKyc(ctx, userId, sub.id, data as unknown as IdentityDetails, user.email).catch((err: Error) => ({ started: false as const, reason: err.message }));
    // The liveness frames have done their job (Smile ID keeps its own copy): don't keep them.
    if (live) run(ctx.db, "DELETE FROM kyc_liveness WHERE user_id = ?", userId);
    checking = started.started;
    if (!started.started) {
      run(ctx.db, "UPDATE kyc_submissions SET provider = 'smileid', provider_status = 'skipped', provider_result = ? WHERE id = ?", JSON.stringify({ status: "skipped", reason: started.reason }), sub.id);
    }
    // And, when switched on, the selfie is compared with the photo on the front of the ID.
    // (Biometric KYC already compares the live selfie with the government photo.)
    if (ctx.config.SMILEID_SELFIE_CHECK && !live) {
      const selfieDoc = docs.get("selfie");
      const frontDoc = docs.get("id_front");
      const selfie = selfieDoc ? readDocument(ctx, selfieDoc.id) : null;
      const front = frontDoc ? readDocument(ctx, frontDoc.id) : null;
      const compared = selfie && front
        ? await startSelfieCompare(ctx, userId, sub.id, selfie, front, data as unknown as IdentityDetails, user.email).catch((err: Error) => ({ started: false as const, reason: err.message }))
        : { started: false as const, reason: "The selfie or the front of the ID is missing" };
      checking = checking || compared.started;
      if (!compared.started) {
        run(ctx.db, "UPDATE kyc_submissions SET selfie_status = 'skipped', selfie_result = ? WHERE id = ?", JSON.stringify({ status: "skipped", reason: compared.reason }), sub.id);
      }
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
  const refreshing = getUserRow(ctx, sub.user_id).kyc_level >= sub.level;
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
    if (decision === "approve" && sub.level === 1) {
      const country = decryptData<Level1Data>(ctx, sub)?.address?.country;
      if (country) run(ctx.db, "UPDATE users SET residence_country = ? WHERE id = ?", country, sub.user_id);
    }
  });
  audit(ctx, reviewerId, `kyc.${decision === "approve" ? "approved" : "rejected"}`, { userId: sub.user_id, level: sub.level, submissionId: sub.id }, ip);
  addAlert(
    ctx,
    sub.user_id,
    "account",
    decision === "approve"
      ? refreshing
        ? "Your updated identity details were approved. Thank you for keeping them current."
        : `Your ${sub.level === 1 ? "identity" : "enhanced"} verification was approved. Your limits have gone up.`
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
      selfieCheck: r.selfie_status ? { status: r.selfie_status, result: r.selfie_result ? (JSON.parse(r.selfie_result) as Record<string, unknown>) : null } : null,
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
  if (isSelfieResult(payload)) {
    const selfie = recordSelfieResult(ctx, payload);
    if (!selfie) return null;
    audit(ctx, null, "kyc.selfie_check", { submissionId: selfie.submissionId, status: selfie.result.status, matched: selfie.result.matched });
    maybeAutoApprove(ctx, selfie.submissionId);
    return selfie;
  }
  const out = recordSmileResult(ctx, payload, (id) => submissionIdentity(ctx, id));
  if (!out) return null;
  audit(ctx, null, "kyc.government_check", { submissionId: out.submissionId, status: out.result.status, verified: out.verified });
  maybeAutoApprove(ctx, out.submissionId);
  return out;
}

/**
 * Approves an identity submission automatically once every check that applies has passed: the
 * government record confirms the ID, name and date of birth; the selfie matches the ID photo (when
 * SMILEID_SELFIE_CHECK is on); and there's no open sanctions or PEP question. Anything else waits
 * for a person.
 */
function maybeAutoApprove(ctx: Ctx, submissionId: string) {
  if (!(ctx.config.SMILEID_AUTO_APPROVE || ctx.config.KYC_AUTO_APPROVE)) return;
  const sub = one<SubmissionRow>(ctx.db, "SELECT * FROM kyc_submissions WHERE id = ?", submissionId);
  if (!sub || sub.status !== "submitted") return;
  const gov = sub.provider_result ? (JSON.parse(sub.provider_result) as { status?: string; nameMatch?: number | null; dobMatch?: boolean | null }) : null;
  const governmentOk = gov?.status === "clear" && (gov.nameMatch ?? 0) >= 0.85 && gov.dobMatch !== false;
  if (!governmentOk) return;
  // Biometric KYC's "clear" already means the live selfie matched the government photo.
  const biometric = (gov as { product?: string | null }).product === "biometric_kyc";
  if (ctx.config.SMILEID_SELFIE_CHECK && !biometric && sub.selfie_status !== "clear") return;
  if (underSanctionsReview(ctx, sub.user_id) || pepBlocksAutoApproval(ctx, sub.user_id)) return;
  applyReview(
    ctx,
    null,
    sub.id,
    "approve",
    ctx.config.SMILEID_SELFIE_CHECK
      ? "Approved automatically: ID confirmed against government records, name and date of birth match, and the selfie matches the ID photo (Smile ID)"
      : "Approved automatically: ID confirmed against government records (Smile ID), name and date of birth match",
  );
}
