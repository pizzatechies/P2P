import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { HttpError, notFound } from "../lib/errors.js";
import { LESSONS, demoTradeCount, lessonsPassed } from "./learn.js";
import { addAlert } from "./security.js";
import { getUserRow } from "./users.js";

/**
 * Upgrading from a demo account to a real one. Real trades go through the user's own licensed
 * brokerage account (Alpaca), which does its own identity checks; this is Aurex's gate before
 * letting someone connect it: a verified email, 2FA, the academy, practice in the demo account,
 * and an appropriateness questionnaire, then review (by an admin unless auto-approval is on).
 */
export interface ApplicationData {
  legalName: string;
  dateOfBirth: string; // YYYY-MM-DD
  country: string; // ISO 3166 alpha-2
  employment: "employed" | "self_employed" | "student" | "retired" | "unemployed";
  annualIncome: "under_10k" | "10k_50k" | "50k_100k" | "100k_250k" | "over_250k";
  liquidNetWorth: "under_10k" | "10k_50k" | "50k_100k" | "100k_250k" | "over_250k";
  sourceOfFunds: "salary" | "savings" | "business" | "investments" | "inheritance" | "other";
  experience: "none" | "under_1y" | "1_3y" | "over_3y";
  objective: "growth" | "income" | "speculation" | "preservation";
  riskTolerance: "low" | "medium" | "high";
  timeHorizon: "under_1y" | "1_5y" | "over_5y";
}

export interface Acknowledgements {
  riskOfLoss: boolean;
  notAdvice: boolean;
  ownAccount: boolean;
  accurate: boolean;
  understandsWarnings?: boolean;
}

type Status = "none" | "draft" | "submitted" | "approved" | "rejected";

interface Row {
  user_id: string;
  status: Exclude<Status, "none">;
  data_enc: string | null;
  assessment: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export function ageOn(dateOfBirth: string, now = new Date()) {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

/** Appropriateness check: real brokers warn (rather than refuse) when answers suggest a poor fit. */
export function assess(data: ApplicationData) {
  const warnings: string[] = [];
  if (data.experience === "none" && data.objective === "speculation") warnings.push("You're aiming for short-term speculation without trading experience. Most beginners lose money doing this.");
  if (data.riskTolerance === "low" && (data.objective === "speculation" || data.objective === "growth")) warnings.push("Your goal involves more risk than your stated risk tolerance. Stock prices can fall sharply.");
  if (data.liquidNetWorth === "under_10k") warnings.push("Your savings are limited. Only invest money you won't need, and keep an emergency fund.");
  if (data.timeHorizon === "under_1y" && data.objective !== "speculation") warnings.push("Stocks can be volatile over short periods. Money needed within a year may be better kept in cash.");
  return { result: warnings.length ? ("warning" as const) : ("appropriate" as const), warnings };
}

function load(ctx: Ctx, userId: string) {
  return one<Row>(ctx.db, "SELECT * FROM live_applications WHERE user_id = ?", userId);
}

function decode(ctx: Ctx, row: Row | undefined): ApplicationData | null {
  return row?.data_enc ? (JSON.parse(decryptSecret(row.data_enc, ctx.config.masterKey)) as ApplicationData) : null;
}

export function liveApproved(ctx: Ctx, userId: string) {
  return load(ctx, userId)?.status === "approved";
}

export function assertLiveApproved(ctx: Ctx, userId: string) {
  if (!liveApproved(ctx, userId)) {
    throw new HttpError(403, "upgrade_required", "Upgrade to a real account first (Trading → Upgrade to real). It takes a few minutes and keeps real money safe.");
  }
}

function validate(ctx: Ctx, data: ApplicationData) {
  const age = ageOn(data.dateOfBirth);
  if (!Number.isFinite(age) || age < 18) throw new HttpError(422, "underage", "You must be 18 or older to open a real account");
  if (age > 120) throw new HttpError(400, "bad_request", "Check your date of birth");
  if (ctx.config.liveCountries.size && !ctx.config.liveCountries.has(data.country)) {
    throw new HttpError(422, "country_unavailable", "Real accounts aren't available in your country yet. You can keep using the demo account.");
  }
}

export function checklist(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const row = load(ctx, userId);
  const passed = lessonsPassed(ctx, userId);
  const trades = demoTradeCount(ctx, userId);
  const need = ctx.config.LIVE_MIN_PRACTICE_TRADES;
  const emailPossible = ctx.config.emailDelivery !== "none";
  return [
    {
      id: "email",
      label: "Verify your email address",
      done: Boolean(user.email_verified_at),
      hint: emailPossible ? "We'll email you a 6-digit code." : "Email delivery isn't set up on this server yet, so real accounts can't be opened.",
      link: "/app/settings#security",
    },
    { id: "two_factor", label: "Turn on two-factor authentication", done: user.totp_enabled === 1, hint: "Protects real money even if your password leaks.", link: "/app/settings#two-factor" },
    { id: "lessons", label: `Pass all ${LESSONS.length} academy quizzes`, done: passed >= LESSONS.length, hint: `${passed} of ${LESSONS.length} passed (80% needed on each).`, link: "/app/learn" },
    { id: "practice", label: `Make ${need} trades in your demo account`, done: trades >= need, hint: `${Math.min(trades, need)} of ${need} done.`, link: "/app/trading" },
    { id: "profile", label: "Complete your profile and questionnaire", done: Boolean(row?.data_enc), hint: "About 2 minutes. Your details are encrypted.", link: "/app/upgrade#application" },
  ];
}

export function upgradeOverview(ctx: Ctx, userId: string) {
  const row = load(ctx, userId);
  const data = decode(ctx, row);
  return {
    status: (row?.status ?? "none") as Status,
    checklist: checklist(ctx, userId),
    application: data,
    assessment: row?.assessment ? JSON.parse(row.assessment) : data ? assess(data) : null,
    submittedAt: row?.submitted_at ?? null,
    reviewedAt: row?.reviewed_at ?? null,
    reviewNote: row?.review_note ?? null,
    autoApprove: ctx.config.LIVE_UPGRADE_AUTO_APPROVE,
    liveTradingEnabled: ctx.config.ALLOW_LIVE_TRADING,
  };
}

export function saveApplication(ctx: Ctx, userId: string, data: ApplicationData) {
  const row = load(ctx, userId);
  if (row?.status === "submitted") throw new HttpError(409, "under_review", "Your application is being reviewed");
  if (row?.status === "approved") throw new HttpError(409, "already_approved", "Your real account is already approved");
  validate(ctx, data);
  const now = nowIso();
  const enc = encryptSecret(JSON.stringify(data), ctx.config.masterKey);
  const assessment = JSON.stringify(assess(data));
  run(
    ctx.db,
    `INSERT INTO live_applications (user_id, status, data_enc, assessment, created_at, updated_at) VALUES (?, 'draft', ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET status = 'draft', data_enc = excluded.data_enc, assessment = excluded.assessment, updated_at = excluded.updated_at`,
    userId,
    enc,
    assessment,
    now,
    now,
  );
  return upgradeOverview(ctx, userId);
}

export function submitApplication(ctx: Ctx, userId: string, ack: Acknowledgements, ip?: string) {
  const row = load(ctx, userId);
  const data = decode(ctx, row);
  if (!row || !data) throw new HttpError(400, "incomplete", "Complete the questionnaire first");
  if (row.status === "submitted" || row.status === "approved") return upgradeOverview(ctx, userId);
  const missing = checklist(ctx, userId).filter((c) => !c.done);
  if (missing.length) throw new HttpError(422, "checklist_incomplete", `Finish these first: ${missing.map((m) => m.label.toLowerCase()).join("; ")}`);
  validate(ctx, data);
  if (!ack.riskOfLoss || !ack.notAdvice || !ack.ownAccount || !ack.accurate) throw new HttpError(400, "acknowledgement_required", "Please confirm every statement");
  const assessment = assess(data);
  if (assessment.result === "warning" && !ack.understandsWarnings) throw new HttpError(400, "acknowledgement_required", "Please confirm you've read the warnings about your answers");

  const now = nowIso();
  const auto = ctx.config.LIVE_UPGRADE_AUTO_APPROVE;
  run(
    ctx.db,
    "UPDATE live_applications SET status = ?, assessment = ?, submitted_at = ?, reviewed_at = ?, review_note = ?, reviewer_id = NULL, updated_at = ? WHERE user_id = ?",
    auto ? "approved" : "submitted",
    JSON.stringify({ ...assessment, acknowledgedAt: now }),
    now,
    auto ? now : null,
    auto ? "Approved automatically" : null,
    now,
    userId,
  );
  addAlert(ctx, userId, "upgrade", auto ? "Your real account was approved." : "Your real-account application was submitted for review.", ip);
  return upgradeOverview(ctx, userId);
}

/** Admin queue: applications with the details a reviewer needs. */
export function listApplications(ctx: Ctx, status: "submitted" | "all") {
  const rows = all<Row & { email: string; handle: string; totp_enabled: number; email_verified_at: string | null }>(
    ctx.db,
    `SELECT a.*, u.email, u.handle, u.totp_enabled, u.email_verified_at FROM live_applications a JOIN users u ON u.id = a.user_id
     WHERE a.status <> 'draft' ${status === "submitted" ? "AND a.status = 'submitted'" : ""} ORDER BY a.submitted_at DESC LIMIT 200`,
  );
  return rows.map((r) => {
    const data = decode(ctx, r);
    return {
      userId: r.user_id,
      handle: r.handle,
      email: r.email,
      status: r.status,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      legalName: data?.legalName ?? null,
      age: data ? ageOn(data.dateOfBirth) : null,
      country: data?.country ?? null,
      experience: data?.experience ?? null,
      objective: data?.objective ?? null,
      riskTolerance: data?.riskTolerance ?? null,
      annualIncome: data?.annualIncome ?? null,
      liquidNetWorth: data?.liquidNetWorth ?? null,
      sourceOfFunds: data?.sourceOfFunds ?? null,
      assessment: r.assessment ? JSON.parse(r.assessment) : null,
      emailVerified: Boolean(r.email_verified_at),
      twoFactor: r.totp_enabled === 1,
      lessonsPassed: lessonsPassed(ctx, r.user_id),
      demoTrades: demoTradeCount(ctx, r.user_id),
    };
  });
}

export function reviewApplication(ctx: Ctx, reviewerId: string, userId: string, decision: "approve" | "reject", note: string | undefined, ip?: string) {
  const row = load(ctx, userId);
  if (!row || row.status === "draft") throw notFound("No application to review");
  if (userId === reviewerId) throw new HttpError(403, "forbidden", "You can't review your own application");
  const now = nowIso();
  const status = decision === "approve" ? "approved" : "rejected";
  run(ctx.db, "UPDATE live_applications SET status = ?, reviewed_at = ?, reviewer_id = ?, review_note = ?, updated_at = ? WHERE user_id = ?", status, now, reviewerId, note?.slice(0, 500) ?? null, now, userId);
  if (status === "rejected") {
    // Revoking an approval also stops any live trading straight away.
    run(ctx.db, "UPDATE trading_accounts SET broker = 'paper' WHERE user_id = ? AND broker = 'alpaca'", userId);
  }
  addAlert(
    ctx,
    userId,
    "upgrade",
    status === "approved" ? "Your real account was approved. You can now connect a live brokerage account." : `Your real-account application wasn't approved${note ? `: ${note}` : "."}`,
    ip,
  );
}
