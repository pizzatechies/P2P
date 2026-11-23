import type { Ctx } from "../context.js";
import { rotatePushTopic } from "./push.js";
import { nowIso, one, run, tx } from "../db/index.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { sendEmail, simpleHtml } from "../lib/mailer.js";
import { assertStrongPassword } from "../lib/password.js";
import { addAlert, assertNotLocked, checkSecondFactor, recordFailedAttempt, recordSuccessfulAttempt, startSecurityHold } from "./security.js";
import { appendAudit } from "./integrity.js";
import type { UserRow } from "./users.js";

/**
 * "Forgot your password?": a single-use link, valid for 30 minutes, emailed to the account's
 * confirmed address. The answer is the same whether or not an account exists, so the form can't be
 * used to find out who has an account. Only a hash of the link's token is stored. With two-factor
 * authentication on, the link alone isn't enough: the authenticator (or a recovery code) is needed
 * too. A reset signs out every device and pauses withdrawals for SECURITY_HOLD_HOURS.
 */

const LINK_MINUTES = 30;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

const tokenHash = (token: string) => sha256(`aurex-password-reset:${token}`);

interface ResetRow {
  user_id: string;
  token_hash: string;
  expires_at: string;
  sent_at: string;
  attempts: number;
}

export function passwordResetAvailable(ctx: Ctx) {
  return ctx.config.emailDelivery !== "none";
}

export async function requestPasswordReset(ctx: Ctx, rawEmail: string, ip?: string) {
  if (!passwordResetAvailable(ctx)) throw new HttpError(503, "email_unavailable", "Password reset by email isn't set up on this server. Contact support.");
  const email = rawEmail.trim().toLowerCase();
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE email = ? AND status = 'active' AND closed_at IS NULL AND email_verified_at IS NOT NULL", email);
  if (!user) return { sent: true };
  const last = one<ResetRow>(ctx.db, "SELECT * FROM password_resets WHERE user_id = ?", user.id);
  if (last && Date.now() - Date.parse(last.sent_at) < RESEND_SECONDS * 1000) return { sent: true };

  const token = randomToken(32);
  run(
    ctx.db,
    `INSERT INTO password_resets (user_id, token_hash, expires_at, sent_at, attempts) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at, attempts = 0`,
    user.id,
    tokenHash(token),
    new Date(Date.now() + LINK_MINUTES * 60_000).toISOString(),
    nowIso(),
  );
  appendAudit(ctx, user.id, "auth.password_reset_requested", {}, ip);
  const link = new URL(`/reset-password?token=${token}`, ctx.config.APP_URL).toString();
  const paragraphs = [
    `Someone asked to reset the password for your Aurex account${ip ? ` (from IP ${ip})` : ""}. Use this link within ${LINK_MINUTES} minutes; it works once.`,
    "If it wasn't you, ignore this email: your password stays the same. Aurex will never ask you for this link.",
  ];
  // Not awaited: the reply mustn't take longer when an account exists.
  void sendEmail(ctx.config, {
    to: user.email,
    subject: "Reset your Aurex password",
    text: `Reset your Aurex password: ${link}\n\n${paragraphs.join("\n\n")}`,
    html: simpleHtml("Reset your password", paragraphs, undefined, { label: "Choose a new password", url: link }),
  });
  return { sent: true };
}

function findValid(ctx: Ctx, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = one<ResetRow>(ctx.db, "SELECT * FROM password_resets WHERE token_hash = ?", tokenHash(token));
  if (!row || row.expires_at < nowIso() || row.attempts >= MAX_ATTEMPTS) return null;
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ? AND status = 'active' AND closed_at IS NULL", row.user_id);
  return user ? { row, user } : null;
}

const expired = () => new HttpError(400, "link_invalid", "This reset link has expired or was already used. Ask for a new one.");

/** Whether a link still works, and whether the authenticator code will be needed. */
export function checkResetLink(ctx: Ctx, token: string) {
  const found = findValid(ctx, token);
  return found ? { valid: true, twoFactor: found.user.totp_enabled === 1 } : { valid: false, twoFactor: false };
}

export async function resetPassword(ctx: Ctx, token: string, password: string, code: string | undefined, ip?: string) {
  const found = findValid(ctx, token);
  if (!found) throw expired();
  const { row, user } = found;
  await assertStrongPassword(ctx.config, password, { email: user.email, handle: user.handle, displayName: user.display_name });
  if (await verifyPassword(password, user.password_hash)) throw badRequest("Choose a password you haven't used here before");
  if (user.totp_enabled) {
    // The lockout also protects the second factor from being guessed through reset links.
    assertNotLocked(user);
    if (!code) throw new HttpError(400, "totp_required", "Enter the code from your authenticator app, or a recovery code");
    if (!checkSecondFactor(ctx, user, code)) {
      run(ctx.db, "UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?", user.id);
      recordFailedAttempt(ctx, user, ip);
      throw new HttpError(400, "totp_invalid", "That code is not valid (each code works only once)");
    }
  }
  const hash = await hashPassword(password);
  tx(ctx.db, () => {
    // Single use: the row must still be the one we checked (a second request with the same link loses).
    const used = run(ctx.db, "DELETE FROM password_resets WHERE user_id = ? AND token_hash = ?", user.id, row.token_hash);
    if (Number(used.changes) !== 1) throw expired();
    run(ctx.db, "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?", hash, nowIso(), user.id);
    run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", user.id);
  });
  recordSuccessfulAttempt(ctx, user.id);
  appendAudit(ctx, user.id, "auth.password_reset", {}, ip);
  addAlert(ctx, user.id, "password_changed", "Your password was reset with a link sent to your email, and every device was signed out.", ip);
  void rotatePushTopic(ctx, user.id);
  startSecurityHold(ctx, user.id, "Your password was reset.", ip);
  return { ok: true };
}
