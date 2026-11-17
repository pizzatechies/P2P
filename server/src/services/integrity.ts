import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";

/**
 * Tamper evidence for the books and the audit log. Every journal (with its entries) and every audit
 * event carries a seal: an HMAC over the row and the previous row's seal, keyed from MASTER_KEY.
 *
 * - Changing, deleting or inserting a row directly in the database breaks the chain from that row on.
 * - Without MASTER_KEY nobody can compute valid seals, so the chain can't be quietly rebuilt.
 * - Database triggers also refuse updates and deletes. The seal is the second line of defence, for
 *   someone who can bypass them by editing the file or dropping the triggers.
 */

const GENESIS = "genesis";
const sealKey = (master: Buffer) => createHmac("sha256", master).update("aurex/integrity/v1").digest();

function seal(key: Buffer, prev: string, canonical: string) {
  return createHmac("sha256", key).update(prev).update("\n").update(canonical).digest("base64url");
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------
export interface JournalFields {
  id: string;
  kind: string;
  memo: string | null;
  initiator_id: string | null;
  idempotency_key: string | null;
  metadata: string;
  created_at: string;
}
export interface EntryFields {
  account_id: string;
  amount: number;
  currency: string;
}

const journalCanonical = (j: JournalFields, entries: EntryFields[]) =>
  JSON.stringify([j.id, j.kind, j.memo, j.initiator_id, j.idempotency_key, j.metadata, j.created_at, entries.map((e) => [e.account_id, e.amount, e.currency])]);

const lastJournalSeal = (ctx: Ctx) => one<{ seal: string | null }>(ctx.db, "SELECT seal FROM journals ORDER BY rowid DESC LIMIT 1")?.seal ?? GENESIS;

/** The seal for a journal about to be inserted (call inside the posting transaction). */
export function sealJournal(ctx: Ctx, j: JournalFields, entries: EntryFields[]) {
  return seal(sealKey(ctx.config.masterKey), lastJournalSeal(ctx), journalCanonical(j, entries));
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
interface AuditFields {
  user_id: string | null;
  action: string;
  ip: string | null;
  details: string;
  created_at: string;
}
const auditCanonical = (a: AuditFields) => JSON.stringify([a.user_id, a.action, a.ip, a.details, a.created_at]);

/** Appends a sealed event to the audit log. */
export function appendAudit(ctx: Ctx, userId: string | null, action: string, details: Record<string, unknown> = {}, ip?: string | null) {
  const row: AuditFields = { user_id: userId, action, ip: ip ?? null, details: JSON.stringify(details), created_at: nowIso() };
  tx(ctx.db, () => {
    const prev = one<{ seal: string | null }>(ctx.db, "SELECT seal FROM audit_events ORDER BY id DESC LIMIT 1")?.seal ?? GENESIS;
    run(
      ctx.db,
      "INSERT INTO audit_events (user_id, action, ip, details, created_at, seal) VALUES (?, ?, ?, ?, ?, ?)",
      row.user_id,
      row.action,
      row.ip,
      row.details,
      row.created_at,
      seal(sealKey(ctx.config.masterKey), prev, auditCanonical(row)),
    );
  });
}

// ---------------------------------------------------------------------------
// Verification, first sealing and resealing
// ---------------------------------------------------------------------------
type Chain = "journals" | "audit";

interface ChainRow {
  ref: string;
  seal: string | null;
  canonical: string;
}

/** Walks a chain from the start, in insertion order, without loading it all at once. */
function* rows(ctx: Ctx, chain: Chain): Generator<ChainRow> {
  const page = 2000;
  let after = 0;
  for (;;) {
    if (chain === "journals") {
      const js = all<JournalFields & { rid: number; seal: string | null }>(ctx.db, "SELECT rowid AS rid, * FROM journals WHERE rowid > ? ORDER BY rowid LIMIT ?", after, page);
      if (!js.length) return;
      for (const j of js) {
        const entries = all<EntryFields>(ctx.db, "SELECT account_id, amount, currency FROM entries WHERE journal_id = ? ORDER BY id", j.id);
        yield { ref: j.id, seal: j.seal, canonical: journalCanonical(j, entries) };
        after = j.rid;
      }
    } else {
      const as = all<AuditFields & { id: number; seal: string | null }>(ctx.db, "SELECT * FROM audit_events WHERE id > ? ORDER BY id LIMIT ?", after, page);
      if (!as.length) return;
      for (const a of as) {
        yield { ref: String(a.id), seal: a.seal, canonical: auditCanonical(a) };
        after = a.id;
      }
    }
  }
}

export interface ChainResult {
  ok: boolean;
  checked: number;
  /** Rows written before sealing existed (sealed at the next start). */
  unsealed: number;
  /** The first row whose seal doesn't match: everything from here on is suspect. */
  brokenAt: string | null;
}

function verifyWith(ctx: Ctx, chain: Chain, key: Buffer): ChainResult {
  let prev = GENESIS;
  let checked = 0;
  let unsealed = 0;
  for (const r of rows(ctx, chain)) {
    if (!r.seal) {
      // Only rows from before sealing began may lack a seal; one after a sealed row was slipped in.
      if (checked > 0) return { ok: false, checked, unsealed, brokenAt: r.ref };
      unsealed++;
      continue;
    }
    const expected = seal(key, prev, r.canonical);
    if (!same(expected, r.seal)) return { ok: false, checked, unsealed, brokenAt: r.ref };
    prev = r.seal;
    checked++;
  }
  return { ok: true, checked, unsealed, brokenAt: null };
}

export function verifyChain(ctx: Ctx, chain: Chain): ChainResult {
  return verifyWith(ctx, chain, sealKey(ctx.config.masterKey));
}

/** Both chains: the books and the audit log. */
export function verifyIntegrity(ctx: Ctx) {
  const journals = verifyChain(ctx, "journals");
  const audit = verifyChain(ctx, "audit");
  return { ok: journals.ok && audit.ok, journals, audit, checkedAt: nowIso() };
}

function rewrite(ctx: Ctx, chain: Chain, key: Buffer) {
  let prev = GENESIS;
  const updates: [string, string][] = [];
  for (const r of rows(ctx, chain)) {
    prev = seal(key, prev, r.canonical);
    updates.push([r.ref, prev]);
  }
  tx(ctx.db, () => {
    for (const [ref, s] of updates) {
      if (chain === "journals") run(ctx.db, "UPDATE journals SET seal = ? WHERE id = ?", s, ref);
      else run(ctx.db, "UPDATE audit_events SET seal = ? WHERE id = ?", s, Number(ref));
    }
  });
  return updates.length;
}

/**
 * At startup:
 * - Rows written before sealing existed get sealed, so the chain covers everything from now on.
 * - After a MASTER_KEY rotation, a chain that verifies under a previous key is resealed with the
 *   current key.
 * - A chain that verifies under no key is left untouched and reported: resealing it would hide tampering.
 */
export function sealAtStartup(ctx: Ctx) {
  const current = sealKey(ctx.config.masterKey);
  const out: Record<Chain, "ok" | "sealed" | "resealed" | "broken"> = { journals: "ok", audit: "ok" };
  for (const chain of ["journals", "audit"] as const) {
    const now = verifyWith(ctx, chain, current);
    if (now.ok && now.unsealed === 0) continue;
    if (now.ok) {
      // Unsealed rows exist. Seal from the start only if no row was ever sealed (a fresh upgrade);
      // otherwise unsealed rows after sealed ones are suspicious and are reported instead.
      const sealed = one<{ n: number }>(ctx.db, chain === "journals" ? "SELECT COUNT(*) AS n FROM journals WHERE seal IS NOT NULL" : "SELECT COUNT(*) AS n FROM audit_events WHERE seal IS NOT NULL")!.n;
      if (sealed === 0) {
        rewrite(ctx, chain, current);
        out[chain] = "sealed";
      } else {
        out[chain] = "broken";
      }
      continue;
    }
    const previous = ctx.config.previousMasterKeys.find((k) => verifyWith(ctx, chain, sealKey(k)).ok);
    if (previous) {
      rewrite(ctx, chain, current);
      out[chain] = "resealed";
    } else {
      out[chain] = "broken";
    }
  }
  return out;
}

/** Verifies both chains every 6 hours and alerts every admin if either is broken. Started from index.ts. */
export function startIntegrityChecks(ctx: Ctx, notify: (message: string) => void, everyMs = 6 * 3600_000) {
  let lastAlert = 0;
  const tick = () => {
    try {
      const r = verifyIntegrity(ctx);
      if (!r.ok && Date.now() - lastAlert > 24 * 3600_000) {
        lastAlert = Date.now();
        const where = [!r.journals.ok && `the ledger at journal ${r.journals.brokenAt}`, !r.audit.ok && `the audit log at event ${r.audit.brokenAt}`].filter(Boolean).join(" and ");
        console.error(`[integrity] TAMPERING DETECTED in ${where}`);
        notify(`Integrity check failed: ${where} no longer matches its seal. Records may have been changed outside Aurex. Investigate before moving any money.`);
      }
    } catch (err) {
      console.error("[integrity]", err);
    }
  };
  const first = setTimeout(tick, 30_000);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

const cache = new WeakMap<object, { at: number; result: ReturnType<typeof verifyIntegrity> }>();
/** verifyIntegrity, reusing a result up to a few minutes old (the admin overview calls this often). */
export function recentIntegrity(ctx: Ctx, maxAgeMs = 5 * 60_000) {
  const hit = cache.get(ctx.db);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.result;
  const result = verifyIntegrity(ctx);
  cache.set(ctx.db, { at: Date.now(), result });
  return result;
}
