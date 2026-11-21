import { createHash } from "node:crypto";
import { screenPep } from "./pep.js";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { fromMinor } from "../lib/money.js";
import { sniffDocument } from "./kyc.js";
import { screenForCustomer } from "./sanctions.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Business (merchant) accounts. A verified customer applies with their business details; an admin
 * reviews the application (know-your-business) and the business name is screened against sanctions
 * lists. Once approved, payments to the account show the business name, and Aurex keeps
 * MERCHANT_FEE_BPS of each payment received, like a till number. The person paying pays nothing extra.
 *
 * A registered company also lists its directors and everyone owning 25% or more (each screened
 * against sanctions lists) and uploads its registration certificate and a record of who owns it.
 * Those details and documents are encrypted at rest.
 */

export const CATEGORIES = ["retail", "food", "services", "transport", "education", "health", "online", "agriculture", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const BUSINESS_TYPES = ["sole_trader", "company"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const DOC_KINDS = ["registration", "ownership", "other"] as const;
export type BusinessDocKind = (typeof DOC_KINDS)[number];
const DOC_LABEL: Record<BusinessDocKind, string> = { registration: "Certificate of registration or incorporation", ownership: "Record of directors and shareholders", other: "Other document" };
const REQUIRED_DOCS: Record<BusinessType, BusinessDocKind[]> = { sole_trader: [], company: ["registration", "ownership"] };
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_DOCS = 20;

export interface BusinessPerson {
  name: string;
  role: "director" | "owner" | "director_owner";
  ownershipPct: number | null;
  dateOfBirth: string;
  nationality: string;
}

interface ProfileRow {
  user_id: string;
  business_name: string;
  category: Category;
  registration_number: string | null;
  country: string;
  website: string | null;
  business_type: BusinessType;
  people_enc: string | null;
  status: "pending" | "approved" | "rejected";
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocRow {
  id: string;
  user_id: string;
  kind: BusinessDocKind;
  mime: string;
  size: number;
  sha256: string;
  data_enc: string;
  created_at: string;
}

const people = (ctx: Ctx, p: ProfileRow): BusinessPerson[] => {
  if (!p.people_enc) return [];
  try {
    return JSON.parse(decryptSecret(p.people_enc, ctx.config.masterKey)) as BusinessPerson[];
  } catch {
    return [];
  }
};

const docView = (d: DocRow) => ({ id: d.id, kind: d.kind, label: DOC_LABEL[d.kind], mime: d.mime, size: d.size, uploadedAt: d.created_at });
const docs = (ctx: Ctx, userId: string) => all<DocRow>(ctx.db, "SELECT * FROM business_documents WHERE user_id = ? ORDER BY created_at DESC", userId);

const view = (ctx: Ctx, p: ProfileRow) => ({
  businessName: p.business_name,
  businessType: p.business_type,
  category: p.category,
  registrationNumber: p.registration_number,
  country: p.country,
  website: p.website,
  people: people(ctx, p),
  status: p.status,
  reviewNote: p.review_note,
  reviewedAt: p.reviewed_at,
  createdAt: p.created_at,
});

const profile = (ctx: Ctx, userId: string) => one<ProfileRow>(ctx.db, "SELECT * FROM business_profiles WHERE user_id = ?", userId);

/** True for an approved business account (payments to it carry the merchant fee). */
export function isMerchant(ctx: Ctx, userId: string) {
  return profile(ctx, userId)?.status === "approved";
}

/** The business name to show for an account, when it's an approved business. */
export function businessName(ctx: Ctx, userId: string) {
  const p = profile(ctx, userId);
  return p?.status === "approved" ? p.business_name : null;
}

export interface BusinessInput {
  businessName: string;
  businessType: BusinessType;
  category: Category;
  registrationNumber?: string;
  country: string;
  website?: string;
  people?: BusinessPerson[];
}

function assertEditable(ctx: Ctx, userId: string) {
  const existing = profile(ctx, userId);
  if (existing?.status === "approved") throw unprocessable("already_business", "This is already a business account");
  if (existing?.status === "pending") throw unprocessable("under_review", "Your application is being reviewed");
}

/** Checks a company's people: at least one director, owners' shares add up, no duplicates. */
function checkPeople(list: BusinessPerson[]) {
  if (list.length === 0) throw badRequest("List the company's directors and everyone who owns 25% or more");
  if (!list.some((p) => p.role !== "owner")) throw badRequest("List at least one director");
  for (const p of list) {
    const owns = p.role !== "director";
    if (owns && (p.ownershipPct === null || p.ownershipPct < 25)) throw badRequest(`Give ${p.name}'s ownership (25% or more), or list them as a director only`);
    if (!owns && p.ownershipPct) throw badRequest(`${p.name} is listed as a director only: leave their ownership empty, or list them as an owner too`);
  }
  const total = list.reduce((s, p) => s + (p.ownershipPct ?? 0), 0);
  if (total > 100) throw badRequest("The ownership shares add up to more than 100%");
  const names = list.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw badRequest("Each person should be listed once (use 'director and owner' for both roles)");
}

export function applyForBusiness(ctx: Ctx, userId: string, input: BusinessInput, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (user.kyc_level < 1) throw unprocessable("identity_first", "Verify your own identity first (Account → Identity verification): a business account is linked to you.");
  assertEditable(ctx, userId);
  const company = input.businessType === "company";
  const list = company ? (input.people ?? []) : [];
  if (company) {
    if (!input.registrationNumber?.trim()) throw badRequest("Enter the company's registration number");
    checkPeople(list);
    const have = new Set(docs(ctx, userId).map((d) => d.kind));
    const missing = REQUIRED_DOCS.company.filter((k) => !have.has(k));
    if (missing.length) throw unprocessable("documents_missing", `Upload: ${missing.map((k) => DOC_LABEL[k]).join(", ")}`);
  }
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO business_profiles (user_id, business_name, category, registration_number, country, website, business_type, people_enc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET business_name = excluded.business_name, category = excluded.category,
       registration_number = excluded.registration_number, country = excluded.country, website = excluded.website,
       business_type = excluded.business_type, people_enc = excluded.people_enc,
       status = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = excluded.updated_at`,
    userId,
    input.businessName.trim(),
    input.category,
    input.registrationNumber?.trim() || null,
    input.country.toUpperCase(),
    input.website?.trim() || null,
    input.businessType,
    list.length ? encryptSecret(JSON.stringify(list), ctx.config.masterKey) : null,
    now,
    now,
  );
  // The business itself is screened (companies are on sanctions lists as well as people), and so is
  // everyone who runs or owns it.
  screenForCustomer(ctx, userId, input.businessName, "business");
  for (const p of list) {
    screenForCustomer(ctx, userId, p.name, "business_person", Number(p.dateOfBirth.slice(0, 4)) || null);
    void screenPep(ctx, userId, { name: p.name, birthDate: p.dateOfBirth, nationality: p.nationality }, "business_person");
  }
  audit(ctx, userId, "business.applied", { category: input.category, country: input.country, type: input.businessType, people: list.length }, ip);
  return businessOverview(ctx, userId);
}

/** A business document (registration certificate, ownership record), checked by content and encrypted. */
export function uploadBusinessDocument(ctx: Ctx, userId: string, kind: BusinessDocKind, body: Buffer, ip?: string) {
  assertEditable(ctx, userId);
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("Choose a file to upload");
  if (body.length > MAX_DOC_BYTES) throw badRequest("Files can be up to 5 MB");
  if (body.length < 1024) throw badRequest("That file is too small to be a readable scan");
  const mime = sniffDocument(body);
  if (!mime) throw badRequest("Upload a PDF, or a JPEG, PNG or WebP photo");
  const count = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM business_documents WHERE user_id = ?", userId)!.n;
  if (count >= MAX_DOCS) throw unprocessable("too_many_documents", "You've uploaded a lot of documents. Contact support to continue.");
  const id = newId("bdoc");
  run(
    ctx.db,
    "INSERT INTO business_documents (id, user_id, kind, mime, size, sha256, data_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    kind,
    mime,
    body.length,
    createHash("sha256").update(body).digest("hex"),
    encryptSecret(body.toString("base64"), ctx.config.masterKey),
    nowIso(),
  );
  audit(ctx, userId, "business.document_uploaded", { kind, size: body.length, mime }, ip);
  return docView(one<DocRow>(ctx.db, "SELECT * FROM business_documents WHERE id = ?", id)!);
}

export function readBusinessDocument(ctx: Ctx, docId: string, ownerId?: string) {
  const d = one<DocRow>(ctx.db, "SELECT * FROM business_documents WHERE id = ?", docId);
  if (!d || (ownerId && d.user_id !== ownerId)) throw notFound("Document not found");
  return { kind: d.kind, mime: d.mime, userId: d.user_id, bytes: Buffer.from(decryptSecret(d.data_enc, ctx.config.masterKey), "base64") };
}

export function reviewBusiness(ctx: Ctx, adminId: string, userId: string, decision: "approve" | "reject", note: string | undefined, ip?: string) {
  const p = profile(ctx, userId);
  if (!p) throw notFound("No business application for this customer");
  if (p.status !== "pending") throw unprocessable("not_pending", `This application is ${p.status}`);
  if (adminId === userId) throw forbidden("You can't review your own business account");
  if (decision === "reject" && !note?.trim()) throw badRequest("Say why, so the customer can fix it");
  run(
    ctx.db,
    "UPDATE business_profiles SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE user_id = ?",
    decision === "approve" ? "approved" : "rejected",
    note?.trim() || null,
    adminId,
    nowIso(),
    nowIso(),
    userId,
  );
  audit(ctx, adminId, `business.${decision === "approve" ? "approved" : "rejected"}`, { target: userId }, ip);
  addAlert(
    ctx,
    userId,
    "account",
    decision === "approve"
      ? `${p.business_name} is now a business account. Payments to you show your business name${ctx.config.MERCHANT_FEE_BPS ? `, with a ${(ctx.config.MERCHANT_FEE_BPS / 100).toFixed(2)}% fee on each payment received` : ""}.`
      : `Your business account application needs another look: ${note?.trim()}`,
  );
}

export function listBusinessApplications(ctx: Ctx, status: "pending" | "all" = "pending") {
  return all<ProfileRow & { handle: string; email: string; display_name: string; kyc_level: number }>(
    ctx.db,
    `SELECT b.*, u.handle, u.email, u.display_name, u.kyc_level FROM business_profiles b JOIN users u ON u.id = b.user_id
     WHERE (? = 'all' OR b.status = 'pending') ORDER BY b.updated_at DESC LIMIT 200`,
    status,
  ).map((r) => ({
    ...view(ctx, r),
    documents: docs(ctx, r.user_id).map(docView),
    user: { id: r.user_id, handle: r.handle, email: r.email, name: r.display_name, kycLevel: r.kyc_level },
  }));
}

/** The customer's business account, its documents and, once approved, what it has received. */
export function businessOverview(ctx: Ctx, userId: string) {
  const p = profile(ctx, userId);
  return {
    feeBps: ctx.config.MERCHANT_FEE_BPS,
    categories: CATEGORIES,
    requiredDocuments: Object.fromEntries(BUSINESS_TYPES.map((t) => [t, REQUIRED_DOCS[t].map((k) => ({ kind: k, label: DOC_LABEL[k] }))])),
    profile: p ? view(ctx, p) : null,
    documents: docs(ctx, userId).map(docView),
    received: p?.status === "approved" ? receivedSummary(ctx, userId) : null,
  };
}

/** For the customer's data download (documents listed, not included). */
export function exportBusiness(ctx: Ctx, userId: string) {
  const p = profile(ctx, userId);
  return p ? { ...view(ctx, p), documents: docs(ctx, userId).map(docView) } : null;
}

/** Money received as a business over the last day, week and month, per currency, with the fees. */
function receivedSummary(ctx: Ctx, userId: string) {
  const windows = { day: 1, week: 7, month: 30 } as const;
  const out: Record<string, { currency: string; received: string; fees: string; payments: number }[]> = {};
  for (const [label, days] of Object.entries(windows)) {
    const rows = all<{ currency: string; received: number; fees: number; n: number }>(
      ctx.db,
      `SELECT e.currency, SUM(e.amount) AS received, SUM(COALESCE(json_extract(j.metadata, '$.merchantFee'), 0)) AS fees, COUNT(*) AS n
       FROM entries e JOIN accounts a ON a.id = e.account_id JOIN journals j ON j.id = e.journal_id
       WHERE a.owner_type = 'user' AND a.user_id = ? AND j.kind = 'transfer' AND e.amount > 0 AND e.created_at >= ?
       GROUP BY e.currency ORDER BY e.currency`,
      userId,
      new Date(Date.now() - days * 86_400_000).toISOString(),
    );
    out[label] = rows.map((r) => ({ currency: r.currency, received: fromMinor(r.received, r.currency), fees: fromMinor(r.fees, r.currency), payments: r.n }));
  }
  return out;
}

export function assertCategory(c: string): Category {
  if (!(CATEGORIES as readonly string[]).includes(c)) throw new HttpError(400, "bad_request", "Choose a business category");
  return c as Category;
}
