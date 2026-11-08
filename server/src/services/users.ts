import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import {
  decryptSecret,
  DUMMY_PASSWORD_HASH,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  randomToken,
  sha256,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "../lib/crypto.js";
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

  const passwordHash = await hashPassword(input.password);
  const id = newId("usr");
  const role = ctx.config.adminEmails.has(email) ? "admin" : "user";
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
    return one<UserRow>(ctx.db, "SELECT * FROM users WHERE email = ?", raw.toLowerCase());
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
     WHERE id <> ? AND status = 'active' AND (handle LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\' OR email = ?)
     ORDER BY handle LIMIT 8`,
    excludeId,
    like,
    like,
    q,
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

export async function authenticate(
  ctx: Ctx,
  input: { email: string; password: string; totpCode?: string },
): Promise<UserRow> {
  const user = one<UserRow>(ctx.db, "SELECT * FROM users WHERE email = ?", input.email.trim().toLowerCase());
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok) throw unauthorized("Email or password is incorrect");
  if (user.status !== "active") throw new HttpError(403, "account_frozen", "This account is frozen. Contact support.");
  if (user.totp_enabled) {
    if (!input.totpCode) throw new HttpError(401, "totp_required", "Enter the 6-digit code from your authenticator app");
    const secret = decryptSecret(user.totp_secret_enc!, ctx.config.masterKey);
    if (!verifyTotp(secret, input.totpCode)) throw new HttpError(401, "totp_invalid", "That code is not valid");
  }
  return user;
}

export function createSession(ctx: Ctx, userId: string, meta: { ip?: string; userAgent?: string }): LoginResult {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  run(
    ctx.db,
    "INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    sha256(token),
    userId,
    nowIso(),
    expiresAt.toISOString(),
    meta.ip ?? null,
    meta.userAgent?.slice(0, 300) ?? null,
  );
  return { user: getUserRow(ctx, userId), token, expiresAt };
}

export function userForSessionToken(ctx: Ctx, token: string): { user: UserRow; sessionId: string } | undefined {
  const sessionId = sha256(token);
  const row = one<UserRow & { expires_at: string }>(
    ctx.db,
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return undefined;
  if (row.expires_at <= nowIso()) {
    run(ctx.db, "DELETE FROM sessions WHERE id = ?", sessionId);
    return undefined;
  }
  return { user: row, sessionId };
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

export async function changePassword(ctx: Ctx, userId: string, current: string, next: string, sessionId: string) {
  const user = getUserRow(ctx, userId);
  if (!(await verifyPassword(current, user.password_hash))) throw badRequest("Current password is incorrect");
  run(ctx.db, "UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(next), userId);
  destroyOtherSessions(ctx, userId, sessionId);
}

export function beginTotpSetup(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  if (user.totp_enabled) throw conflict("Two-factor authentication is already on");
  const secret = generateTotpSecret();
  run(ctx.db, "UPDATE users SET totp_secret_enc = ? WHERE id = ?", encryptSecret(secret, ctx.config.masterKey), userId);
  return { secret, otpauthUri: totpUri(secret, user.email) };
}

export function confirmTotpSetup(ctx: Ctx, userId: string, code: string) {
  const user = getUserRow(ctx, userId);
  if (!user.totp_secret_enc) throw badRequest("Start two-factor setup first");
  const secret = decryptSecret(user.totp_secret_enc, ctx.config.masterKey);
  if (!verifyTotp(secret, code)) throw badRequest("That code is not valid. Check your device clock and try again.");
  run(ctx.db, "UPDATE users SET totp_enabled = 1 WHERE id = ?", userId);
}

export async function disableTotp(ctx: Ctx, userId: string, password: string, code: string) {
  const user = getUserRow(ctx, userId);
  if (!user.totp_enabled) return;
  if (!(await verifyPassword(password, user.password_hash))) throw badRequest("Password is incorrect");
  const secret = decryptSecret(user.totp_secret_enc!, ctx.config.masterKey);
  if (!verifyTotp(secret, code)) throw badRequest("That code is not valid");
  run(ctx.db, "UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?", userId);
}
