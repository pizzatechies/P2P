import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { decryptSecret, generateRecoveryCodes, looksLikeRecoveryCode, matchTotp, recoveryCodeHash, safeEqual } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { emailAlert } from "./email.js";
import type { UserRow } from "./users.js";

/** Alerts important enough to also email (to verified addresses). */
const EMAILED = new Set(["new_device", "account_locked", "password_changed", "2fa_enabled", "2fa_disabled", "recovery_code_used", "recovery_codes", "admin", "security_hold"]);

// ---------------------------------------------------------------------------
// Security alerts: shown in the app (dashboard banner, Settings → Security).
// ---------------------------------------------------------------------------
export function addAlert(ctx: Ctx, userId: string, kind: string, message: string, ip?: string | null) {
  run(ctx.db, "INSERT INTO security_alerts (user_id, kind, message, ip, created_at) VALUES (?, ?, ?, ?, ?)", userId, kind, message, ip ?? null, nowIso());
  if (EMAILED.has(kind)) void emailAlert(ctx, userId, message).catch(() => undefined);
}

export function listAlerts(ctx: Ctx, userId: string, limit = 20) {
  return all<{ id: number; kind: string; message: string; ip: string | null; created_at: string; read_at: string | null }>(
    ctx.db,
    "SELECT * FROM security_alerts WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    userId,
    limit,
  ).map((a) => ({ id: a.id, kind: a.kind, message: a.message, ip: a.ip, createdAt: a.created_at, read: a.read_at !== null }));
}

export function markAlertsRead(ctx: Ctx, userId: string) {
  run(ctx.db, "UPDATE security_alerts SET read_at = ? WHERE user_id = ? AND read_at IS NULL", nowIso(), userId);
}

// ---------------------------------------------------------------------------
// Account lockout after repeated failed sign-ins (password or 2FA), with escalating lock times.
// ---------------------------------------------------------------------------
export function assertNotLocked(user: UserRow) {
  if (user.locked_until && user.locked_until > nowIso()) {
    const minutes = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60_000));
    throw new HttpError(429, "account_locked", `Too many failed attempts. For your safety this account is locked for ${minutes} more minute${minutes === 1 ? "" : "s"}.`);
  }
}

export function recordFailedAttempt(ctx: Ctx, user: UserRow, ip?: string) {
  const failures = user.failed_logins + 1;
  if (failures < ctx.config.LOGIN_MAX_ATTEMPTS) {
    run(ctx.db, "UPDATE users SET failed_logins = ? WHERE id = ?", failures, user.id);
    return;
  }
  const lockouts = user.lockouts + 1;
  const minutes = Math.min(24 * 60, ctx.config.LOGIN_LOCK_MINUTES * 2 ** (lockouts - 1));
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  run(ctx.db, "UPDATE users SET failed_logins = 0, lockouts = ?, locked_until = ? WHERE id = ?", lockouts, until, user.id);
  addAlert(ctx, user.id, "account_locked", `Your account was locked for ${minutes} minutes after ${failures} failed sign-in attempts.`, ip);
  run(
    ctx.db,
    "INSERT INTO audit_events (user_id, action, ip, details, created_at) VALUES (?, 'security.account_locked', ?, ?, ?)",
    user.id,
    ip ?? null,
    JSON.stringify({ minutes }),
    nowIso(),
  );
}

export function recordSuccessfulAttempt(ctx: Ctx, userId: string) {
  run(ctx.db, "UPDATE users SET failed_logins = 0, lockouts = 0, locked_until = NULL WHERE id = ?", userId);
}

// ---------------------------------------------------------------------------
// Second factor: TOTP codes (never accepted twice) or one-time recovery codes.
// ---------------------------------------------------------------------------
export type SecondFactor = "totp" | "recovery";

/** Returns which factor was used, or null when the code is wrong. Consumes recovery codes. */
export function checkSecondFactor(ctx: Ctx, user: UserRow, code: string): SecondFactor | null {
  if (!user.totp_enabled || !user.totp_secret_enc) return null;
  const trimmed = code.trim();
  if (looksLikeRecoveryCode(trimmed)) {
    const hash = recoveryCodeHash(trimmed);
    const used = tx(ctx.db, () => {
      const row = one<{ code_hash: string }>(ctx.db, "SELECT code_hash FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL", user.id, hash);
      if (!row || !safeEqual(row.code_hash, hash)) return false;
      run(ctx.db, "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?", nowIso(), user.id, hash);
      return true;
    });
    return used ? "recovery" : null;
  }
  const step = matchTotp(decryptSecret(user.totp_secret_enc, ctx.config.masterKey), trimmed);
  if (step === null || step <= user.totp_last_step) return null; // wrong, or already used
  run(ctx.db, "UPDATE users SET totp_last_step = ? WHERE id = ?", step, user.id);
  return "totp";
}

export function issueRecoveryCodes(ctx: Ctx, userId: string): string[] {
  const codes = generateRecoveryCodes();
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM recovery_codes WHERE user_id = ?", userId);
    const now = nowIso();
    for (const c of codes) run(ctx.db, "INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)", userId, recoveryCodeHash(c), now);
  });
  return codes;
}

export function recoveryCodesLeft(ctx: Ctx, userId: string) {
  return one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", userId)?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Security hold: after a password change, 2FA removal or recovery-code sign-in, money can't leave
// for SECURITY_HOLD_HOURS, so someone who just took over an account can't empty it.
// ---------------------------------------------------------------------------
export function startSecurityHold(ctx: Ctx, userId: string, reason: string, ip?: string) {
  const hours = ctx.config.SECURITY_HOLD_HOURS;
  if (hours <= 0) return;
  const until = new Date(Date.now() + hours * 3_600_000).toISOString();
  run(ctx.db, "UPDATE users SET security_hold_until = MAX(COALESCE(security_hold_until, ''), ?) WHERE id = ?", until, userId);
  addAlert(ctx, userId, "security_hold", `${reason} Withdrawals and large sends are paused for ${hours} hours as a precaution.`, ip);
}

export function securityHoldUntil(user: Pick<UserRow, "security_hold_until">): string | null {
  return user.security_hold_until && user.security_hold_until > nowIso() ? user.security_hold_until : null;
}

export function assertNoSecurityHold(user: Pick<UserRow, "security_hold_until">) {
  const until = securityHoldUntil(user);
  if (until) {
    throw new HttpError(
      423,
      "security_hold",
      `For your safety, withdrawals and large sends are paused until ${new Date(until).toUTCString()} after a recent security change.`,
      { until },
    );
  }
}

// ---------------------------------------------------------------------------
// Re-authentication ("step-up"): sensitive actions need a password (and 2FA) check within
// REAUTH_WINDOW_MINUTES, even inside a valid session.
// ---------------------------------------------------------------------------
export function markReauthenticated(ctx: Ctx, sessionId: string) {
  run(ctx.db, "UPDATE sessions SET reauth_at = ? WHERE id = ?", nowIso(), sessionId);
}

export function reauthValidUntil(ctx: Ctx, reauthAt: string | null | undefined): string | null {
  if (!reauthAt) return null;
  const until = Date.parse(reauthAt) + ctx.config.REAUTH_WINDOW_MINUTES * 60_000;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

export function assertRecentAuth(ctx: Ctx, reauthAt: string | null | undefined) {
  if (!reauthValidUntil(ctx, reauthAt)) {
    throw new HttpError(401, "reauth_required", "Please confirm it's you to continue.", { windowMinutes: ctx.config.REAUTH_WINDOW_MINUTES });
  }
}

// ---------------------------------------------------------------------------
// Sessions and devices
// ---------------------------------------------------------------------------
export function describeDevice(userAgent: string | null | undefined) {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua ? "Browser" : "Unknown device";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function listSessions(ctx: Ctx, userId: string, currentId: string | undefined) {
  return all<{ id: string; created_at: string; last_seen_at: string | null; ip: string | null; user_agent: string | null; expires_at: string }>(
    ctx.db,
    "SELECT id, created_at, last_seen_at, ip, user_agent, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC",
    userId,
    nowIso(),
  ).map((s) => ({
    // The row id is a hash of the cookie token; expose only a short, unguessable-enough handle to it.
    id: s.id.slice(0, 16),
    device: describeDevice(s.user_agent),
    ip: s.ip,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at ?? s.created_at,
    current: s.id === currentId,
  }));
}

export function revokeSession(ctx: Ctx, userId: string, shortId: string) {
  if (!/^[0-9a-f]{16}$/.test(shortId)) return false;
  const res = run(ctx.db, "DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", userId, shortId);
  return Number(res.changes) > 0;
}

/** True when this browser/device hasn't signed in to the account before. */
export function isNewDevice(ctx: Ctx, userId: string, userAgent: string | undefined, excludeSessionId: string) {
  const seen = one(
    ctx.db,
    "SELECT 1 FROM sessions WHERE user_id = ? AND id <> ? AND COALESCE(user_agent, '') = ? LIMIT 1",
    userId,
    excludeSessionId,
    userAgent?.slice(0, 300) ?? "",
  );
  if (seen) return false;
  const logins = all<{ details: string }>(ctx.db, "SELECT details FROM audit_events WHERE user_id = ? AND action IN ('auth.login', 'auth.register') ORDER BY id DESC LIMIT 200", userId);
  return !logins.some((l) => (JSON.parse(l.details) as { ua?: string }).ua === (userAgent?.slice(0, 300) ?? ""));
}
