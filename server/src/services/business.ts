import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { badRequest, forbidden, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { fromMinor } from "../lib/money.js";
import { screenForCustomer } from "./sanctions.js";
import { addAlert } from "./security.js";
import { audit, getUserRow } from "./users.js";

/**
 * Business (merchant) accounts. A verified customer applies with their business details; an admin
 * reviews the application (know-your-business) and the business name is screened against sanctions
 * lists. Once approved, payments to the account show the business name, and Aurex keeps
 * MERCHANT_FEE_BPS of each payment received, like a till number. The person paying pays nothing extra.
 */

export const CATEGORIES = ["retail", "food", "services", "transport", "education", "health", "online", "agriculture", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

interface ProfileRow {
  user_id: string;
  business_name: string;
  category: Category;
  registration_number: string | null;
  country: string;
  website: string | null;
  status: "pending" | "approved" | "rejected";
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const view = (p: ProfileRow) => ({
  businessName: p.business_name,
  category: p.category,
  registrationNumber: p.registration_number,
  country: p.country,
  website: p.website,
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
  category: Category;
  registrationNumber?: string;
  country: string;
  website?: string;
}

export function applyForBusiness(ctx: Ctx, userId: string, input: BusinessInput, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (user.kyc_level < 1) throw unprocessable("identity_first", "Verify your own identity first (Account → Identity verification): a business account is linked to you.");
  const existing = profile(ctx, userId);
  if (existing?.status === "approved") throw unprocessable("already_business", "This is already a business account");
  if (existing?.status === "pending") throw unprocessable("under_review", "Your application is being reviewed");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO business_profiles (user_id, business_name, category, registration_number, country, website, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET business_name = excluded.business_name, category = excluded.category,
       registration_number = excluded.registration_number, country = excluded.country, website = excluded.website,
       status = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = excluded.updated_at`,
    userId,
    input.businessName.trim(),
    input.category,
    input.registrationNumber?.trim() || null,
    input.country.toUpperCase(),
    input.website?.trim() || null,
    now,
    now,
  );
  // The business itself is screened too (companies are on sanctions lists as well as people).
  screenForCustomer(ctx, userId, input.businessName, "business");
  audit(ctx, userId, "business.applied", { category: input.category, country: input.country }, ip);
  return businessOverview(ctx, userId);
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
  ).map((r) => ({ ...view(r), user: { id: r.user_id, handle: r.handle, email: r.email, name: r.display_name, kycLevel: r.kyc_level } }));
}

/** The customer's business account and, once approved, what it has received. */
export function businessOverview(ctx: Ctx, userId: string) {
  const p = profile(ctx, userId);
  return {
    feeBps: ctx.config.MERCHANT_FEE_BPS,
    categories: CATEGORIES,
    profile: p ? view(p) : null,
    received: p?.status === "approved" ? receivedSummary(ctx, userId) : null,
  };
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
