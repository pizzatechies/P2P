import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import {
  decryptSecret,
  DUMMY_PASSWORD_HASH,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  matchTotp,
  randomToken,
  sha256,
  totpUri,
  verifyPassword,
} from "../lib/crypto.js";
import { assertStrongPassword } from "../lib/password.js";
import { assertEmailVerified } from "./email.js";
import {
  addAlert,
  assertNotLocked,
  checkSecondFactor,
  issueRecoveryCodes,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  startSecurityHold,
} from "./security.js";
import { badRequest, conflict, HttpError, notFound, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertCurrency } from "../lib/money.js";

export interface UserRow {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  password_hash: string;
  role: "user" | "admin";
  kyc_level: number;
  default_currency: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  status: "active" | "frozen";
  created_at: string;
  failed_logins: number;
  lockouts: number;
  locked_until: string | null;
  totp_last_step: number;
  security_hold_until: string | null;
  password_changed_at: string | null;
  email_verified_at: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  role: "user" | "admin";
  kycLevel: number;
  defaultCurrency: string;
  totpEnabled: boolean;
  emailVerified: boolean;
  status: "active" | "frozen";
  createdAt: string;
}

export function toAuthUser(u: UserRow): AuthUser {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    displayName: u.display_name,
    role: u.role,
    kycLevel: u.kyc_level,
    defaultCurrency: u.default_currency,
    totpEnabled: u.totp_enabled === 1,
    emailVerified: Boolean(u.email_verified_at),
    status: u.status,
    createdAt: u.created_at,
  };
}

/** What other users may see about someone (e.g. when picking a recipient). */
export function publicProfile(u: Pick<UserRow, "id" | "handle" | "display_name">) {
  return { id: u.id, handle: u.handle, displayName: u.display_name };
}

export function audit(ctx: Ctx, userId: string | null, action: string, details: Record<string, unknown> = {}, ip?: string) {
  run(
    ctx.db,
    "INSERT INTO audit_events (user_id, action, ip, details, created_at) VALUES (?, ?, ?, ?, ?)",
    userId,
    action,
    ip ?? null,
    JSON.stringify(details),
    nowIso(),
  );
}

export async function registerUser(
  ctx: Ctx,
  input: { email: string; handle: string; displayName: string; password: string; defaultCurrency?: string },
): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
  const currency = assertCurrency(input.defaultCurrency ?? "USD").code;

  if (one(ctx.db, "SELECT 1 FROM users WHERE email = ?", email)) throw conflict("An account with that email already exists");
  if (one(ctx.db, "SELECT 1 FROM users WHERE handle = ?", handle)) throw conflict("That handle is taken");
  await assertStrongPassword(ctx.config, input.password, { email, handle, displayName: input.displayName });

  const passwordHash = await hashPassword(input.password);
  const id = newId("usr");
  // Production never trusts an email address alone for admin rights (it isn't verified): see claimAdmin().
  const role = ctx.config.adminAutoPromote && ctx.config.adminEmails.has(email) ? "admin" : "user";
  return tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO users (id, email, handle, display_name, password_hash, role, default_currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      email,
      handle,
      input.displayName.trim(),
      passwordHash,
      role,
      currency,
      nowIso(),
    );
    return getUserRow(ctx, id);
  });
}

export function getUserRow(ctx: Ctx, id: string): UserRow {
  const u = one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", id);
  if (!u) throw notFound("User not found");
  return u;
}

/** Finds a user by @handle, email or id - how people address each other when sending money. */
export function findUserByIdentifier(ctx: Ctx, identifier: string): UserRow | undefined {
  const raw = identifier.trim();
  if (!raw) return undefined;
  if (raw.startsWith("usr_")) return one<UserRow>(ctx.db, "SELECT * FROM users WHERE id = ?", raw);
  if (raw.includes("@") && !raw.startsWith("@")) {
    // Paying by email only finds verified addresses, so nobody can intercept money by registering
    // someone else's email first.
    const verifiedOnly = ctx.config.requireEmailVerification ? " AND email_verified_at IS NOT NULL" : "";
    return one<UserRow>(ctx.db, `SELECT * FROM users WHERE email = ?${verifiedOnly}`, raw.toLowerCase());
  }
  return one<UserRow>(ctx.db, "SELECT * FROM users WHERE handle = ?", raw.replace(/^@/, "").toLowerCase());
}

export function searchUsers(ctx: Ctx, query: string, excludeId: string) {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (q.length < 2) return [];
  const like = `${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  return all<UserRow>(
    ctx.db,
    `SELECT id, handle, display_name FROM users
     WHERE id <> ? AND status = 'active' AND (handle LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\'
       OR (email = ? AND (email_verified_at IS NOT NULL OR ? = 0)))
     ORDER BY handle LIMIT 8`,
    excludeId,
    like,
    like,
    q,
    ctx.config.requireEmailVerification ? 1 : 0,
  ).map(publicProfile);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export interface LoginResult {
  user: UserRow;
  token: string;
  expiresAt: Date;
}

/** How the second factor was satisfied on this sign-in, if one was needed. */
export interface AuthResult {
  user: UserRow;
  secondFactor: "totp" | "recovery" | null;
}

export async function authenticate(
  ctx: Ctx,
  input: { email: string; password: string; totpCode?: string },
  ip?: string,
): Promise<AuthResult> {
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE email = ?", input.email.trim().toLowerCase());
  // A locked account isn't even checked, so it can't be used to test passwords.
  if (user) assertNotLocked(user);
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    if (user) recordFailedAttempt(ctx, user, ip);
    throw unauthorized("Email or password is incorrect");
  }
  if (user.status !== "active") throw new HttpError(403, "account_frozen", "This account is frozen. Contact support.");
  let secondFactor: AuthResult["secondFactor"] = null;
  if (user.totp_enabled) {
    if (!input.totpCode) throw new HttpError(401, "totp_required", "Enter the 6-digit code from your authenticator app");
    secondFactor = checkSecondFactor(ctx, user, input.totpCode);
    if (!secondFactor) {
      recordFailedAttempt(ctx, user, ip);
      throw new HttpError(401, "totp_invalid", "That code is not valid (each code works only once)");
    }
  }
  recordSuccessfulAttempt(ctx, user.id);
  if (secondFactor === "recovery") {
    startSecurityHold(ctx, user.id, "You signed in with a recovery code.", ip);
    addAlert(ctx, user.id, "recovery_code_used", "A recovery code was used to sign in. If this wasn't you, change your password now.", ip);
  }
  // ADMIN_EMAILS also applies to accounts created before the address was added to it (development only).
  if (user.role !== "admin" && ctx.config.adminAutoPromote && ctx.config.adminEmails.has(user.email.toLowerCase())) {
    run(ctx.db, "UPDATE users SET role = 'admin' WHERE id = ?", user.id);
    audit(ctx, user.id, "admin.promoted_from_config");
  }
  return { user: getUserRow(ctx, user.id), secondFactor };
}

/** Production admin access: an ADMIN_EMAILS account proves itself with ADMIN_SETUP_CODE. */
export function claimAdmin(ctx: Ctx, userId: string, code: string) {
  const user = getUserRow(ctx, userId);
  const expected = ctx.config.ADMIN_SETUP_CODE;
  if (!expected || !ctx.config.adminEmails.has(user.email.toLowerCase())) throw new HttpError(403, "forbidden", "This account can't claim admin access");
  if (!safeCompare(code.trim(), expected)) throw badRequest("That setup code is not valid");
  assertEmailVerified(ctx, user, "become an admin");
  if (ctx.config.REQUIRE_ADMIN_2FA && !user.totp_enabled) throw new HttpError(403, "admin_2fa_required", "Turn on two-factor authentication first");
  run(ctx.db, "UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  return getUserRow(ctx, user.id);
}

function safeCompare(a: string, b: string) {
  const ha = sha256(a);
  const hb = sha256(b);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function createSession(ctx: Ctx, userId: string, meta: { ip?: string; userAgent?: string }): LoginResult & { sessionId: string } {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  const now = nowIso();
  // Signing in counts as a fresh password (and 2FA) check for sensitive actions.
  run(
    ctx.db,
    "INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent, last_seen_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    sha256(token),
    userId,
    now,
    expiresAt.toISOString(),
    meta.ip ?? null,
    meta.userAgent?.slice(0, 300) ?? null,
    now,
    now,
  );
  return { user: getUserRow(ctx, userId), token, expiresAt, sessionId: sha256(token) };
}

export function userForSessionToken(ctx: Ctx, token: string): { user: UserRow; sessionId: string; reauthAt: string | null } | undefined {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  const sessionId = sha256(token);
  const row = one<UserRow & { expires_at: string; last_seen_at: string | null; reauth_at: string | null }>(
    ctx.db,
    `SELECT u.*, s.expires_at, s.last_seen_at, s.reauth_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return undefined;
  const now = Date.now();
  const idleMs = ctx.config.SESSION_IDLE_MINUTES * 60_000;
  const lastSeen = Date.parse(row.last_seen_at ?? row.expires_at);
  if (Date.parse(row.expires_at) <= now || (idleMs > 0 && row.last_seen_at && now - lastSeen > idleMs)) {
    run(ctx.db, "DELETE FROM sessions WHERE id = ?", sessionId);
    return undefined;
  }
  // Record activity at most once a minute.
  if (!row.last_seen_at || now - lastSeen > 60_000) run(ctx.db, "UPDATE sessions SET last_seen_at = ? WHERE id = ?", new Date(now).toISOString(), sessionId);
  return { user: row, sessionId, reauthAt: row.reauth_at };
}

export function destroySession(ctx: Ctx, sessionId: string) {
  run(ctx.db, "DELETE FROM sessions WHERE id = ?", sessionId);
}

export function destroyOtherSessions(ctx: Ctx, userId: string, keepSessionId: string) {
  run(ctx.db, "DELETE FROM sessions WHERE user_id = ? AND id <> ?", userId, keepSessionId);
}

// ---------------------------------------------------------------------------
// Profile & security settings
// ---------------------------------------------------------------------------
export function updateProfile(ctx: Ctx, userId: string, input: { displayName?: string; defaultCurrency?: string }) {
  if (input.displayName !== undefined) {
    run(ctx.db, "UPDATE users SET display_name = ? WHERE id = ?", input.displayName.trim(), userId);
  }
  if (input.defaultCurrency !== undefined) {
    run(ctx.db, "UPDATE users SET default_currency = ? WHERE id = ?", assertCurrency(input.defaultCurrency).code, userId);
  }
  return getUserRow(ctx, userId);
}

export async function changePassword(
  ctx: Ctx,
  userId: string,
  input: { current: string; next: string; code?: string },
  sessionId: string,
  ip?: string,
) {
  const user = getUserRow(ctx, userId);
  assertNotLocked(user);
  if (!(await verifyPassword(input.current, user.password_hash))) {
    recordFailedAttempt(ctx, user, ip);
    throw badRequest("Current password is incorrect");
  }
  // Validate the new password before asking for a 2FA code, so a typo doesn't use up a code.
  if (await verifyPassword(input.next, user.password_hash)) throw badRequest("Choose a password you haven't used here before");
  await assertStrongPassword(ctx.config, input.next, { email: user.email, handle: user.handle, displayName: user.display_name });
  if (user.totp_enabled) {
    if (!input.code) throw new HttpError(400, "totp_required", "Enter the code from your authenticator app");
    if (!checkSecondFactor(ctx, user, input.code)) {
      recordFailedAttempt(ctx, user, ip);
      throw new HttpError(400, "totp_invalid", "That code is not valid (each code works only once)");
    }
  }
  run(ctx.db, "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?", await hashPassword(input.next), nowIso(), userId);
  destroyOtherSessions(ctx, userId, sessionId);
  addAlert(ctx, userId, "password_changed", "Your password was changed and every other device was signed out.", ip);
  startSecurityHold(ctx, userId, "Your password was changed.", ip);
}

export function beginTotpSetup(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  if (user.totp_enabled) throw conflict("Two-factor authentication is already on");
  const secret = generateTotpSecret();
  run(ctx.db, "UPDATE users SET totp_secret_enc = ? WHERE id = ?", encryptSecret(secret, ctx.config.masterKey), userId);
  return { secret, otpauthUri: totpUri(secret, user.email) };
}

/** Turns 2FA on and returns one-time recovery codes (shown once). */
export function confirmTotpSetup(ctx: Ctx, userId: string, code: string): string[] {
  const user = getUserRow(ctx, userId);
  if (user.totp_enabled) throw conflict("Two-factor authentication is already on");
  if (!user.totp_secret_enc) throw badRequest("Start two-factor setup first");
  const secret = decryptSecret(user.totp_secret_enc, ctx.config.masterKey);
  const step = matchTotp(secret, code);
  if (step === null) throw badRequest("That code is not valid. Check your device clock and try again.");
  run(ctx.db, "UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?", step, userId);
  addAlert(ctx, userId, "2fa_enabled", "Two-factor authentication was turned on.");
  return issueRecoveryCodes(ctx, userId);
}

export async function disableTotp(ctx: Ctx, userId: string, password: string, code: string, ip?: string) {
  const user = getUserRow(ctx, userId);
  if (!user.totp_enabled) return;
  if (user.role === "admin" && ctx.config.REQUIRE_ADMIN_2FA) throw new HttpError(403, "admin_2fa_required", "Admins must keep two-factor authentication on");
  assertNotLocked(user);
  if (!(await verifyPassword(password, user.password_hash))) {
    recordFailedAttempt(ctx, user, ip);
    throw badRequest("Password is incorrect");
  }
  if (!checkSecondFactor(ctx, user, code)) {
    recordFailedAttempt(ctx, user, ip);
    throw badRequest("That code is not valid");
  }
  run(ctx.db, "UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?", userId);
  run(ctx.db, "DELETE FROM recovery_codes WHERE user_id = ?", userId);
  addAlert(ctx, userId, "2fa_disabled", "Two-factor authentication was turned off.", ip);
  startSecurityHold(ctx, userId, "Two-factor authentication was turned off.", ip);
}
