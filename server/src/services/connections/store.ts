import type { Ctx } from "../../context.js";
import { all, nowIso, one, run, tx } from "../../db/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { badRequest, HttpError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { convertMinor, getRates, midRate } from "../fx.js";
import { audit, getUserRow } from "../users.js";
import { CURRENCIES } from "../../lib/money.js";
import { getAggregator } from "./registry.js";
import { ConnectorError, type AccountSnapshot, type CompletedLink, type LinkedRow, type PendingLink } from "./types.js";

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------
const pendingView = (r: LinkedRow): PendingLink => ({ id: r.id, userId: r.user_id, provider: r.provider, meta: JSON.parse(r.meta) });

function loadOwned(ctx: Ctx, userId: string, id: string): LinkedRow {
  const r = one<LinkedRow>(ctx.db, "SELECT * FROM linked_connections WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Connection not found");
  return r;
}

function friendly(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ConnectorError) return new HttpError(502, "connector_error", err.message);
  return new HttpError(502, "connector_error", (err as Error).message ?? "The provider returned an error");
}

/** Creates a pending link and returns the provider URL to send the user to. */
export async function startLink(ctx: Ctx, userId: string, providerId: string) {
  const agg = getAggregator(providerId);
  if (!agg) throw badRequest("That provider can't be connected yet");
  if (!agg.configured(ctx)) throw new HttpError(422, "provider_not_configured", `${agg.info.name} isn't set up on this server yet`);
  const user = getUserRow(ctx, userId);

  // Abandoned attempts older than a day are cleaned up as new ones start.
  run(
    ctx.db,
    "DELETE FROM linked_connections WHERE user_id = ? AND status = 'pending' AND created_at < ?",
    userId,
    new Date(Date.now() - 86_400_000).toISOString(),
  );

  const id = newId("lnk");
  const now = nowIso();
  run(
    ctx.db,
    "INSERT INTO linked_connections (id, user_id, provider, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    id,
    userId,
    providerId,
    now,
    now,
  );
  const returnUrl = new URL("/app/connections", ctx.config.APP_URL);
  returnUrl.searchParams.set("callback", providerId);
  returnUrl.searchParams.set("link", id);
  try {
    const { redirectUrl, meta } = await agg.start(ctx, user, { id, userId, provider: providerId, meta: {} }, returnUrl.toString());
    run(ctx.db, "UPDATE linked_connections SET meta = ?, updated_at = ? WHERE id = ?", JSON.stringify(meta ?? {}), nowIso(), id);
    return { linkId: id, redirectUrl };
  } catch (err) {
    run(ctx.db, "DELETE FROM linked_connections WHERE id = ?", id);
    throw friendly(err);
  }
}

/** Activates a link with what the provider confirmed. Shared by the redirect path and webhooks. */
export async function finalizeLink(ctx: Ctx, row: LinkedRow, done: CompletedLink) {
  const user = getUserRow(ctx, row.user_id);
  const merged = { ...JSON.parse(row.meta), ...(done.meta ?? {}) };
  const activeId = tx(ctx.db, () => {
    // Linking the same item twice (e.g. another brokerage under one SnapTrade user) refreshes the existing connection.
    const dup = one<{ id: string }>(
      ctx.db,
      "SELECT id FROM linked_connections WHERE user_id = ? AND provider = ? AND external_id = ? AND status <> 'pending' AND id <> ?",
      row.user_id,
      row.provider,
      done.externalId,
      row.id,
    );
    if (dup) {
      run(ctx.db, "DELETE FROM linked_connections WHERE id = ?", row.id);
      if (done.secret) run(ctx.db, "UPDATE linked_connections SET secret_enc = ? WHERE id = ?", encryptSecret(done.secret, ctx.config.masterKey), dup.id);
      return dup.id;
    }
    run(
      ctx.db,
      `UPDATE linked_connections SET status = 'active', external_id = ?, secret_enc = ?, institution = ?, country = ?, meta = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      done.externalId,
      done.secret ? encryptSecret(done.secret, ctx.config.masterKey) : null,
      done.institution ?? null,
      done.country ?? null,
      JSON.stringify(merged),
      nowIso(),
      row.id,
    );
    return row.id;
  });
  audit(ctx, user.id, "connections.linked", { provider: row.provider, connectionId: activeId });
  await syncConnection(ctx, user.id, activeId).catch(() => undefined);
  return activeId;
}

/** Called when the provider redirects the user back to Aurex. */
export async function completeLink(ctx: Ctx, userId: string, linkId: string, params: Record<string, string>) {
  const row = loadOwned(ctx, userId, linkId);
  if (row.status !== "pending") return { status: row.status, connectionId: row.id };
  const agg = getAggregator(row.provider)!;
  let done: CompletedLink | "pending";
  try {
    done = await agg.complete(ctx, getUserRow(ctx, userId), pendingView(row), params);
  } catch (err) {
    run(ctx.db, "DELETE FROM linked_connections WHERE id = ?", row.id);
    throw friendly(err);
  }
  if (done === "pending") return { status: "pending" as const, connectionId: row.id };
  const id = await finalizeLink(ctx, row, done);
  return { status: "active" as const, connectionId: id };
}

export function findPendingLink(ctx: Ctx, provider: string, where: (meta: Record<string, unknown>, row: LinkedRow) => boolean) {
  const rows = all<LinkedRow>(ctx.db, "SELECT * FROM linked_connections WHERE provider = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 500", provider);
  return rows.find((r) => where(JSON.parse(r.meta), r)) ?? null;
}

/** Re-checks a pending link with the provider (used by webhooks as a trigger, never trusted on its own). */
export async function retryPendingLink(ctx: Ctx, row: LinkedRow, params: Record<string, string> = {}) {
  const agg = getAggregator(row.provider);
  if (!agg) return;
  const done = await agg.complete(ctx, getUserRow(ctx, row.user_id), pendingView(row), params);
  if (done !== "pending") await finalizeLink(ctx, row, done);
}

// ---------------------------------------------------------------------------
// Sync, disconnect, overview
// ---------------------------------------------------------------------------
export async function syncConnection(ctx: Ctx, userId: string, connectionId: string) {
  const row = loadOwned(ctx, userId, connectionId);
  if (row.status === "pending") throw badRequest("This connection isn't finished yet");
  const agg = getAggregator(row.provider);
  if (!agg) throw badRequest("Unknown provider");
  const secret = row.secret_enc ? decryptSecret(row.secret_enc, ctx.config.masterKey) : null;
  let accounts: AccountSnapshot[];
  try {
    accounts = await agg.accounts(ctx, getUserRow(ctx, userId), row, secret);
  } catch (err) {
    const e = friendly(err);
    run(ctx.db, "UPDATE linked_connections SET status = 'error', error = ?, updated_at = ? WHERE id = ?", e.message.slice(0, 300), nowIso(), row.id);
    throw e;
  }
  tx(ctx.db, () => {
    const now = nowIso();
    const keep = new Set<string>();
    for (const a of accounts) {
      keep.add(a.externalId);
      run(
        ctx.db,
        `INSERT INTO linked_accounts (id, connection_id, user_id, external_id, name, kind, mask, currency, balance, available, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (connection_id, external_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, mask = excluded.mask,
           currency = excluded.currency, balance = excluded.balance, available = excluded.available, updated_at = excluded.updated_at`,
        newId("lac"),
        row.id,
        userId,
        a.externalId,
        a.name.slice(0, 120),
        a.kind,
        a.mask ?? null,
        a.currency?.toUpperCase() ?? null,
        a.balance ?? null,
        a.available ?? null,
        now,
      );
    }
    for (const r of all<{ id: string; external_id: string }>(ctx.db, "SELECT id, external_id FROM linked_accounts WHERE connection_id = ?", row.id)) {
      if (!keep.has(r.external_id)) run(ctx.db, "DELETE FROM linked_accounts WHERE id = ?", r.id);
    }
    run(ctx.db, "UPDATE linked_connections SET status = 'active', error = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?", now, now, row.id);
  });
  return accounts.length;
}

export async function disconnect(ctx: Ctx, userId: string, connectionId: string) {
  const row = loadOwned(ctx, userId, connectionId);
  const agg = getAggregator(row.provider);
  const secret = row.secret_enc ? decryptSecret(row.secret_enc, ctx.config.masterKey) : null;
  if (agg?.disconnect && row.status !== "pending") {
    // Best effort: remove access at the provider, but always forget it locally.
    await agg.disconnect(ctx, getUserRow(ctx, userId), row, secret).catch((err) => console.warn(`[connections] ${row.provider} disconnect: ${(err as Error).message}`));
  }
  run(ctx.db, "DELETE FROM linked_connections WHERE id = ?", row.id);
  audit(ctx, userId, "connections.removed", { provider: row.provider });
}

export async function overview(ctx: Ctx, userId: string) {
  const user = getUserRow(ctx, userId);
  const conns = all<LinkedRow>(ctx.db, "SELECT * FROM linked_connections WHERE user_id = ? ORDER BY created_at", userId);
  const accounts = all<{
    id: string; connection_id: string; name: string; kind: string; mask: string | null; currency: string | null;
    balance: number | null; available: number | null; updated_at: string;
  }>(ctx.db, "SELECT * FROM linked_accounts WHERE user_id = ? ORDER BY name", userId);

  // Net worth in the user's main currency, at mid-market rates (informational).
  const rates = await getRates(ctx);
  const base = user.default_currency;
  const totals = new Map<string, number>();
  let netWorth = 0;
  let unconverted = 0;
  for (const a of accounts) {
    if (a.balance === null || !a.currency) continue;
    totals.set(a.currency, (totals.get(a.currency) ?? 0) + a.balance);
    if (rates.rates[a.currency] && CURRENCIES[a.currency] && CURRENCIES[base]) {
      const dec = CURRENCIES[a.currency].decimals;
      const minor = Math.round(a.balance * 10 ** dec);
      const sign = minor < 0 ? -1 : 1;
      const converted = a.currency === base ? Math.abs(minor) : convertMinor(Math.abs(minor), a.currency, base, midRate(rates, a.currency, base));
      netWorth += (sign * converted) / 10 ** CURRENCIES[base].decimals;
    } else unconverted++;
  }

  return {
    baseCurrency: base,
    netWorth: Math.round(netWorth * 100) / 100,
    unconvertedAccounts: unconverted,
    totals: [...totals.entries()].map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 })),
    connections: conns
      .filter((c) => c.status !== "pending")
      .map((c) => ({
        id: c.id,
        provider: c.provider,
        providerName: getAggregator(c.provider)?.info.name ?? c.provider,
        status: c.status,
        institution: c.institution,
        country: c.country,
        error: c.error,
        lastSyncedAt: c.last_synced_at,
        createdAt: c.created_at,
        accounts: accounts
          .filter((a) => a.connection_id === c.id)
          .map((a) => ({ id: a.id, name: a.name, kind: a.kind, mask: a.mask, currency: a.currency, balance: a.balance, available: a.available, updatedAt: a.updated_at })),
      })),
    pending: conns.filter((c) => c.status === "pending").map((c) => ({ id: c.id, provider: c.provider, createdAt: c.created_at })),
  };
}
