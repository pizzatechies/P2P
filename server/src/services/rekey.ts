import type { Ctx } from "../context.js";
import { all, run, tx } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";

/** Every column holding an AES-256-GCM secret, with the columns that identify its row. */
const ENCRYPTED: { table: string; column: string; keys: string[] }[] = [
  { table: "users", column: "totp_secret_enc", keys: ["id"] },
  { table: "user_api_keys", column: "key_enc", keys: ["user_id", "provider"] },
  { table: "linked_connections", column: "secret_enc", keys: ["id"] },
  { table: "provider_customers", column: "secret_enc", keys: ["user_id", "provider"] },
  { table: "live_applications", column: "data_enc", keys: ["user_id"] },
  { table: "kyc_submissions", column: "data_enc", keys: ["id"] },
  { table: "kyc_documents", column: "data_enc", keys: ["id"] },
  { table: "safeguarding_accounts", column: "details_enc", keys: ["id"] },
];

/**
 * MASTER_KEY rotation: secrets that only decrypt with a key listed in MASTER_KEY_PREVIOUS are
 * re-encrypted with the current MASTER_KEY. Run at startup; once it reports nothing left, the old
 * key can be removed from the environment.
 */
export function rekeySecrets(ctx: Ctx): { rekeyed: number; unreadable: number } {
  const previous = ctx.config.previousMasterKeys;
  if (previous.length === 0) return { rekeyed: 0, unreadable: 0 };
  let rekeyed = 0;
  let unreadable = 0;
  for (const { table, column, keys } of ENCRYPTED) {
    const rows = all<Record<string, string>>(ctx.db, `SELECT ${keys.join(", ")}, ${column} AS secret FROM ${table} WHERE ${column} IS NOT NULL`);
    tx(ctx.db, () => {
      for (const row of rows) {
        try {
          decryptSecret(row.secret, ctx.config.masterKey);
          continue; // already on the current key
        } catch {
          /* try the previous keys */
        }
        const key = previous.find((k) => {
          try {
            decryptSecret(row.secret, k);
            return true;
          } catch {
            return false;
          }
        });
        if (!key) {
          unreadable++;
          continue;
        }
        const fresh = encryptSecret(decryptSecret(row.secret, key), ctx.config.masterKey);
        run(ctx.db, `UPDATE ${table} SET ${column} = ? WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`, fresh, ...keys.map((k) => row[k]));
        rekeyed++;
      }
    });
  }
  return { rekeyed, unreadable };
}
