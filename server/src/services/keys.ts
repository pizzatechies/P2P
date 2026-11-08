import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";

/**
 * Per-user secrets for third-party services (AI providers, brokers). Encrypted with AES-256-GCM
 * under the server's MASTER_KEY; only the last four characters are ever shown back to the user.
 */
export function saveUserKey(ctx: Ctx, userId: string, provider: string, secret: string, extra: Record<string, unknown> = {}) {
  const hint = secret.length > 8 ? secret.slice(-4) : "••••";
  run(
    ctx.db,
    `INSERT INTO user_api_keys (user_id, provider, key_enc, key_hint, extra, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET key_enc = excluded.key_enc, key_hint = excluded.key_hint,
       extra = excluded.extra, created_at = excluded.created_at`,
    userId,
    provider,
    encryptSecret(secret, ctx.config.masterKey),
    hint,
    JSON.stringify(extra),
    nowIso(),
  );
}

export function getUserKey(ctx: Ctx, userId: string, provider: string): { secret: string; extra: Record<string, unknown> } | null {
  const row = one<{ key_enc: string; extra: string }>(
    ctx.db,
    "SELECT key_enc, extra FROM user_api_keys WHERE user_id = ? AND provider = ?",
    userId,
    provider,
  );
  if (!row) return null;
  try {
    return { secret: decryptSecret(row.key_enc, ctx.config.masterKey), extra: JSON.parse(row.extra) };
  } catch {
    // MASTER_KEY changed: the stored key can't be recovered and must be re-entered.
    return null;
  }
}

export function deleteUserKey(ctx: Ctx, userId: string, provider: string) {
  run(ctx.db, "DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?", userId, provider);
}

export function listUserKeys(ctx: Ctx, userId: string) {
  return all<{ provider: string; key_hint: string; created_at: string }>(
    ctx.db,
    "SELECT provider, key_hint, created_at FROM user_api_keys WHERE user_id = ? ORDER BY provider",
    userId,
  ).map((r) => ({ provider: r.provider, hint: r.key_hint, createdAt: r.created_at }));
}
