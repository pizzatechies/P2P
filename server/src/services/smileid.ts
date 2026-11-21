import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ctx } from "../context.js";
import { nowIso, one, run } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { safeEqual } from "../lib/crypto.js";
import { nameScore, nameTokens } from "./sanctions.js";

/**
 * Smile ID Enhanced KYC: checks a customer's ID number against the issuing government's records
 * (for example Kenya's IPRS or Nigeria's NIMC), then Aurex compares the names and date of birth on
 * record with what the customer typed in. Built to Smile ID's published v3 API:
 * - POST /v3/token with the smileid-partner-id and smileid-api-key headers gives a short-lived JWT;
 * - POST /v3/enhanced_kyc (multipart/form-data, SmileID-Partner-ID + SmileID-Token) starts the job and
 *   answers 202;
 * - the result arrives at /api/webhooks/smileid, signed in Response-Signature as
 *   base64(HMAC-SHA256(api_key, Response-Timestamp + partner_id + "sid_request")).
 * The ID types offered for each country come from GET /v3/services/supported_id_types, so Aurex never
 * sends a type the country doesn't support, and each ID number is checked against Smile ID's format first.
 * Off unless SMILEID_PARTNER_ID and SMILEID_API_KEY are set. Confirm the flow in Smile ID's sandbox
 * before going live: the request encoding follows their spec, not a test against their servers.
 */

export const smileConfigured = (ctx: Ctx) => Boolean(ctx.config.SMILEID_PARTNER_ID && ctx.config.SMILEID_API_KEY);
const base = (ctx: Ctx) =>
  ctx.config.SMILEID_BASE_URL ?? (ctx.config.SMILEID_ENV === "production" ? "https://api.smileidentity.com" : "https://testapi.smileidentity.com");

async function call<T>(ctx: Ctx, path: string, init: { method?: string; headers?: Record<string, string>; form?: FormData }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base(ctx)}${path}`, { method: init.method ?? "GET", headers: { Accept: "application/json", ...init.headers }, body: init.form, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new HttpError(502, "smileid_unreachable", `Couldn't reach Smile ID: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new HttpError(502, "smileid_error", `Smile ID answered ${res.status}: ${(body as { message?: string }).message ?? "error"}`);
  return body as T;
}

async function token(ctx: Ctx, userId: string) {
  const form = new FormData();
  form.append("user_id", userId);
  const r = await call<{ token?: string }>(ctx, "/v3/token", {
    method: "POST",
    headers: { "smileid-partner-id": ctx.config.SMILEID_PARTNER_ID!, "smileid-api-key": ctx.config.SMILEID_API_KEY! },
    form,
  });
  if (!r.token) throw new HttpError(502, "smileid_error", "Smile ID didn't return a token");
  return r.token;
}

interface IdTypeInfo {
  country: string;
  type: string;
  label?: string;
  regex?: string;
}
const typeCache = new Map<string, { at: number; types: IdTypeInfo[] }>();

async function supportedTypes(ctx: Ctx, userId: string, country: string): Promise<IdTypeInfo[]> {
  const hit = typeCache.get(`${base(ctx)}:${country}`);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.types;
  const r = await call<{ id_types?: IdTypeInfo[] }>(ctx, `/v3/services/supported_id_types?country=${encodeURIComponent(country)}`, {
    headers: { "SmileID-Partner-ID": ctx.config.SMILEID_PARTNER_ID!, "SmileID-Token": await token(ctx, userId) },
  });
  const types = (r.id_types ?? []).filter((t) => t.country?.toUpperCase() === country);
  typeCache.set(`${base(ctx)}:${country}`, { at: Date.now(), types });
  return types;
}

/** The Smile ID id_type for one of Aurex's ID kinds in a country, from what Smile ID says it supports. */
export function pickIdType(types: IdTypeInfo[], kind: "passport" | "national_id" | "drivers_license"): IdTypeInfo | null {
  const by = (pred: (t: string) => boolean) => types.find((t) => pred(t.type.toUpperCase())) ?? null;
  if (kind === "passport") return by((t) => t.includes("PASSPORT"));
  if (kind === "drivers_license") return by((t) => t.includes("DRIVER"));
  for (const preferred of ["NATIONAL_ID", "NIN_V2", "NIN", "GHANA_CARD", "NATIONAL_ID_NO_PHOTO"]) {
    const t = by((x) => x === preferred);
    if (t) return t;
  }
  return by((t) => t.includes("NATIONAL") || t.startsWith("NIN"));
}

export interface IdentityDetails {
  legalName: string;
  dateOfBirth: string;
  phone: string;
  idType: "passport" | "national_id" | "drivers_license";
  idNumber: string;
  idCountry: string;
}

/**
 * Starts a government-record check for an identity submission. Returns why it was skipped when the
 * country or ID type isn't covered (the submission then just goes to a person, as before).
 */
export async function startEnhancedKyc(ctx: Ctx, userId: string, submissionId: string, d: IdentityDetails, email: string): Promise<{ started: true; jobId: string } | { started: false; reason: string }> {
  if (!smileConfigured(ctx)) return { started: false, reason: "not configured" };
  const country = d.idCountry.toUpperCase();
  const type = pickIdType(await supportedTypes(ctx, userId, country), d.idType);
  if (!type) return { started: false, reason: `Smile ID doesn't cover this ID type in ${country}` };
  const idNumber = d.idNumber.replace(/\s+/g, "");
  if (type.regex) {
    try {
      if (!new RegExp(type.regex).test(idNumber)) return { started: false, reason: `The ID number doesn't look like a ${type.label ?? type.type}` };
    } catch {
      /* a pattern JavaScript can't read: let Smile ID decide */
    }
  }
  const tokens = d.legalName.trim().split(/\s+/);
  const lastName = tokens.length > 1 ? tokens.pop()! : tokens[0];
  const phone = d.phone.replace(/[\s()-]/g, "");
  const form = new FormData();
  form.append("country", country);
  form.append("id_type", type.type);
  form.append("id_number", idNumber);
  form.append("user_id", userId);
  form.append("callback_url", new URL("/api/webhooks/smileid", ctx.config.APP_URL).toString());
  // Objects are sent as JSON-encoded parts, the default for multipart in Smile ID's OpenAPI spec.
  form.append("user_details", JSON.stringify({ given_names: tokens.join(" ") || lastName, last_name: lastName, email, ...(/^\+[1-9]\d{6,14}$/.test(phone) ? { phone_number: phone } : {}) }));
  form.append(
    "consent",
    JSON.stringify({ granted: true, granted_at: nowIso(), notice_language: "EN", notice_privacy_policy_url: ctx.config.SMILEID_PRIVACY_URL ?? new URL("/privacy", ctx.config.APP_URL).toString() }),
  );
  // Smile ID echoes partner_params in its callback. Its signature covers only the timestamp, not the
  // body, so aurex_check (a keyed hash only Aurex can make) ties the result to the check we started.
  form.append("partner_params", JSON.stringify({ aurex_submission: submissionId, aurex_user: userId, aurex_check: callbackCheck(ctx, submissionId) }));
  const r = await call<{ job_id?: string; status?: string }>(ctx, "/v3/enhanced_kyc", {
    method: "POST",
    headers: { "SmileID-Partner-ID": ctx.config.SMILEID_PARTNER_ID!, "SmileID-Token": await token(ctx, userId) },
    form,
  });
  run(
    ctx.db,
    "UPDATE kyc_submissions SET provider = 'smileid', provider_job_id = ?, provider_status = 'pending', provider_result = NULL, updated_at = ? WHERE id = ?",
    r.job_id ?? null,
    nowIso(),
    submissionId,
  );
  return { started: true, jobId: r.job_id ?? "" };
}

/**
 * Compares the customer's selfie with the photo on the front of their ID document (SmartSelfie
 * Compare). Smile ID needs JPEG photos; without a liveness capture, Smile ID skips its active
 * liveness check, so this confirms the same face, not that a live person took the selfie.
 */
export async function startSelfieCompare(
  ctx: Ctx,
  userId: string,
  submissionId: string,
  selfie: { bytes: Buffer; mime: string },
  idFront: { bytes: Buffer; mime: string },
  d: IdentityDetails,
  email: string,
): Promise<{ started: true; jobId: string } | { started: false; reason: string }> {
  if (selfie.mime !== "image/jpeg" || idFront.mime !== "image/jpeg") {
    return { started: false, reason: "The selfie and the front of the ID need to be JPEG photos for the automatic comparison; check them by eye" };
  }
  const tokens = d.legalName.trim().split(/\s+/);
  const lastName = tokens.length > 1 ? tokens.pop()! : tokens[0];
  const phone = d.phone.replace(/[\s()-]/g, "");
  const form = new FormData();
  form.append("selfie_image", new Blob([new Uint8Array(selfie.bytes)], { type: "image/jpeg" }), "selfie.jpg");
  form.append("comparison_image", new Blob([new Uint8Array(idFront.bytes)], { type: "image/jpeg" }), "id-front.jpg");
  form.append("comparison_image_type", "DOCUMENT");
  form.append("user_id", userId);
  form.append("callback_url", new URL("/api/webhooks/smileid", ctx.config.APP_URL).toString());
  form.append("user_details", JSON.stringify({ given_names: tokens.join(" ") || lastName, last_name: lastName, email, ...(/^\+[1-9]\d{6,14}$/.test(phone) ? { phone_number: phone } : {}) }));
  form.append(
    "consent",
    JSON.stringify({ granted: true, granted_at: nowIso(), notice_language: "EN", notice_privacy_policy_url: ctx.config.SMILEID_PRIVACY_URL ?? new URL("/privacy", ctx.config.APP_URL).toString() }),
  );
  form.append("partner_params", JSON.stringify({ aurex_submission: submissionId, aurex_user: userId, aurex_kind: "selfie", aurex_check: callbackCheck(ctx, `selfie:${submissionId}`) }));
  const r = await call<{ job_id?: string }>(ctx, "/v3/compare", {
    method: "POST",
    headers: { "SmileID-Partner-ID": ctx.config.SMILEID_PARTNER_ID!, "SmileID-Token": await token(ctx, userId) },
    form,
  });
  run(ctx.db, "UPDATE kyc_submissions SET selfie_job_id = ?, selfie_status = 'pending', selfie_result = NULL, updated_at = ? WHERE id = ?", r.job_id ?? null, nowIso(), submissionId);
  return { started: true, jobId: r.job_id ?? "" };
}

/** True for a SmartSelfie Compare result (as opposed to a government record check). */
export const isSelfieResult = (p: SmileWebhook) => p.product === "smart_selfie_compare" || p.partner_params?.aurex_kind === "selfie";

/** Records a selfie comparison result for the check Aurex started (same binding rules as the government check). */
export function recordSelfieResult(ctx: Ctx, payload: SmileWebhook) {
  const p = payload.partner_params ?? {};
  type Row = { id: string; user_id: string; selfie_job_id: string | null; selfie_status: string | null };
  const cols = "id, user_id, selfie_job_id, selfie_status";
  const byJob = p.job_id ? one<Row>(ctx.db, `SELECT ${cols} FROM kyc_submissions WHERE selfie_job_id = ?`, String(p.job_id)) : undefined;
  const bySub = p.aurex_submission ? one<Row>(ctx.db, `SELECT ${cols} FROM kyc_submissions WHERE id = ?`, String(p.aurex_submission)) : undefined;
  const sub = byJob ?? bySub;
  if (!sub) return null;
  if (!safeEqual(String(p.aurex_check ?? ""), callbackCheck(ctx, `selfie:${sub.id}`))) return null;
  if (sub.selfie_job_id && p.job_id && String(p.job_id) !== sub.selfie_job_id) return null;
  if (sub.selfie_status !== "pending") return null;
  const status = payload.status ?? "error";
  const result = {
    status,
    // clear: same face; block with face_verification_failed: a different face; error: couldn't compare.
    matched: status === "clear" || status === "attention" ? true : payload.reason === "face_verification_failed" ? false : null,
    reason: payload.reason ?? null,
    message: payload.message ?? null,
    checkedAt: nowIso(),
  };
  run(ctx.db, "UPDATE kyc_submissions SET selfie_status = ?, selfie_result = ?, updated_at = ? WHERE id = ?", status, JSON.stringify(result), nowIso(), sub.id);
  return { submissionId: sub.id, userId: sub.user_id, result };
}

/** The value Smile ID must echo back for a result to count for this submission. */
export function callbackCheck(ctx: Ctx, submissionId: string) {
  return createHmac("sha256", ctx.config.masterKey).update(`aurex:smileid-callback:${submissionId}`).digest("hex").slice(0, 40);
}

/** True when a webhook really came from Smile ID (signed with this account's API key). */
export function verifySmileSignature(ctx: Ctx, signature: string | undefined, timestamp: string | undefined) {
  if (!smileConfigured(ctx) || !signature || !timestamp) return false;
  const expected = createHmac("sha256", ctx.config.SMILEID_API_KEY!).update(timestamp + ctx.config.SMILEID_PARTNER_ID + "sid_request").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Old timestamps (replays) are refused; Smile ID retries within minutes.
  const at = /^\d+$/.test(timestamp) ? Number(timestamp) * (timestamp.length <= 10 ? 1000 : 1) : Date.parse(timestamp);
  return Number.isFinite(at) && Math.abs(Date.now() - at) < 24 * 3600_000;
}

export interface SmileWebhook {
  status?: "clear" | "attention" | "block" | "error";
  reason?: string | null;
  message?: string;
  product?: string;
  partner_params?: Record<string, string | number>;
  id_fields?: { first_name?: string; other_names?: string; last_name?: string; full_name?: string; date_of_birth?: string; id_number?: string } | null;
}

/**
 * Records a result against its submission and compares the government record with what the customer
 * entered. Returns the submission and the outcome, or null when it doesn't match a job.
 */
export function recordSmileResult(ctx: Ctx, payload: SmileWebhook, submitted: (submissionId: string) => IdentityDetails | null) {
  const p = payload.partner_params ?? {};
  type Row = { id: string; user_id: string; provider_job_id: string | null; provider_status: string | null };
  const cols = "id, user_id, provider_job_id, provider_status";
  const byJob = p.job_id ? one<Row>(ctx.db, `SELECT ${cols} FROM kyc_submissions WHERE provider_job_id = ? AND provider = 'smileid'`, String(p.job_id)) : undefined;
  const bySub = p.aurex_submission ? one<Row>(ctx.db, `SELECT ${cols} FROM kyc_submissions WHERE id = ? AND provider = 'smileid'`, String(p.aurex_submission)) : undefined;
  const sub = byJob ?? bySub;
  if (!sub) return null;
  // Only the check Aurex started (the keyed value it sent), with the job id Smile ID gave it, and
  // only once: a replayed or edited callback can't change a result or approve someone else.
  if (!safeEqual(String(p.aurex_check ?? ""), callbackCheck(ctx, sub.id))) return null;
  if (sub.provider_job_id && p.job_id && String(p.job_id) !== sub.provider_job_id) return null;
  if (sub.provider_status !== "pending") return null;
  const mine = submitted(sub.id);
  const f = payload.id_fields ?? null;
  const recordName = f ? f.full_name || [f.first_name, f.other_names, f.last_name].filter(Boolean).join(" ") : "";
  const nameMatch = mine && recordName ? nameScore(nameTokens(mine.legalName), nameTokens(recordName)) : null;
  const dobMatch = mine && f?.date_of_birth ? f.date_of_birth.slice(0, 10) === mine.dateOfBirth : null;
  const status = payload.status ?? "error";
  const result = {
    status,
    reason: payload.reason ?? null,
    message: payload.message ?? null,
    nameMatch: nameMatch === null ? null : Math.round(nameMatch * 100) / 100,
    dobMatch,
    recordName: recordName || null,
    recordDob: f?.date_of_birth ?? null,
    checkedAt: nowIso(),
  };
  run(
    ctx.db,
    "UPDATE kyc_submissions SET provider_status = ?, provider_result = ?, updated_at = ? WHERE id = ?",
    status,
    JSON.stringify(result),
    nowIso(),
    sub.id,
  );
  // Verified only when the ID is valid on record AND it's this person: names close, same birth date.
  const verified = status === "clear" && (nameMatch ?? 0) >= 0.85 && dobMatch !== false;
  return { submissionId: sub.id, userId: sub.user_id, result, verified };
}
