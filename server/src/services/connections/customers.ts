import type { Ctx } from "../../context.js";
import { nowIso, one, run } from "../../db/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";

// ---------------------------------------------------------------------------
// Per-user identities at aggregators (Salt Edge customer, SnapTrade user)
// ---------------------------------------------------------------------------
export function getProviderCustomer(ctx: Ctx, userId: string, provider: string) {
  const r = one<{ external_id: string; secret_enc: string | null }>(
    ctx.db,
    "SELECT external_id, secret_enc FROM provider_customers WHERE user_id = ? AND provider = ?",
    userId,
    provider,
  );
  if (!r) return null;
  return { externalId: r.external_id, secret: r.secret_enc ? decryptSecret(r.secret_enc, ctx.config.masterKey) : null };
}

export function saveProviderCustomer(ctx: Ctx, userId: string, provider: string, externalId: string, secret?: string) {
  run(
    ctx.db,
    `INSERT INTO provider_customers (user_id, provider, external_id, secret_enc, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET external_id = excluded.external_id, secret_enc = excluded.secret_enc`,
    userId,
    provider,
    externalId,
    secret ? encryptSecret(secret, ctx.config.masterKey) : null,
    nowIso(),
  );
}

export function deleteProviderCustomer(ctx: Ctx, userId: string, provider: string) {
  run(ctx.db, "DELETE FROM provider_customers WHERE user_id = ? AND provider = ?", userId, provider);
}

