import { randomInt } from "node:crypto";
import type { Ctx } from "../context.js";
import { nowIso, one, run } from "../db/index.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { sendEmail, simpleHtml } from "../lib/mailer.js";

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;

const codeHash = (userId: string, code: string) => sha256(`aurex-email:${userId}:${code}`);

interface Who {
  id: string;
  email: string;
  email_verified_at: string | null;
}

/** Emails a fresh 6-digit code. In development the code is also returned so the app can show it. */
export async function sendVerificationCode(ctx: Ctx, user: Who) {
  if (user.email_verified_at) return { sent: false, verified: true as const };
  if (ctx.config.emailDelivery === "none") throw new HttpError(503, "email_unavailable", "Email delivery isn't set up on this server yet");
  const last = one<{ sent_at: string }>(ctx.db, "SELECT sent_at FROM email_codes WHERE user_id = ?", user.id);
  if (last && Date.now() - Date.parse(last.sent_at) < RESEND_SECONDS * 1000) {
    throw new HttpError(429, "too_soon", "A code was just sent. Wait a minute before asking for another.");
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = nowIso();
  run(
    ctx.db,
    `INSERT INTO email_codes (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
    user.id,
    codeHash(user.id, code),
    new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
    now,
  );
  const paragraphs = [`Enter this code in Aurex to confirm ${user.email} is your email address. It expires in ${CODE_MINUTES} minutes.`, "If you didn't sign up for Aurex, you can ignore this email."];
  const sent = await sendEmail(ctx.config, {
    to: user.email,
    subject: `${code} is your Aurex verification code`,
    text: `Your Aurex verification code is ${code}\n\n${paragraphs.join("\n\n")}`,
    html: simpleHtml("Confirm your email", paragraphs, code),
  });
  return {
    sent,
    verified: false as const,
    // Development convenience only: there's no inbox, so the app displays the code.
    devCode: ctx.config.emailDelivery === "console" ? code : undefined,
  };
}

export function verifyEmailCode(ctx: Ctx, userId: string, code: string) {
  const row = one<{ code_hash: string; expires_at: string; attempts: number }>(ctx.db, "SELECT code_hash, expires_at, attempts FROM email_codes WHERE user_id = ?", userId);
  if (!row) throw new HttpError(400, "no_code", "Ask for a new code first");
  if (row.expires_at < nowIso()) throw new HttpError(400, "code_expired", "That code has expired. Ask for a new one.");
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts", "Too many wrong codes. Ask for a new one.");
  if (!safeEqual(codeHash(userId, code.trim()), row.code_hash)) {
    run(ctx.db, "UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?", userId);
    throw new HttpError(400, "code_invalid", "That code isn't right");
  }
  run(ctx.db, "UPDATE users SET email_verified_at = ? WHERE id = ?", nowIso(), userId);
  run(ctx.db, "DELETE FROM email_codes WHERE user_id = ?", userId);
}

/** Throws when this server requires verified emails and the user hasn't verified theirs. */
export function assertEmailVerified(ctx: Ctx, user: { email_verified_at: string | null }, action = "do this") {
  if (ctx.config.requireEmailVerification && !user.email_verified_at) {
    throw new HttpError(403, "email_unverified", `Verify your email address to ${action}.`);
  }
}

/** Security alerts by email (verified addresses only), best effort. */
export async function emailAlert(ctx: Ctx, userId: string, message: string) {
  const user = one<Who>(ctx.db, "SELECT id, email, email_verified_at FROM users WHERE id = ?", userId);
  if (!user?.email_verified_at || ctx.config.emailDelivery === "none") return;
  const paragraphs = [message, "If this was you, there's nothing to do. If not, change your password now and sign out other devices under Settings → Security center."];
  await sendEmail(ctx.config, {
    to: user.email,
    subject: "Aurex security alert",
    text: paragraphs.join("\n\n"),
    html: simpleHtml("Security alert", paragraphs),
  });
}
