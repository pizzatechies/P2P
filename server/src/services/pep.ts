import type { Ctx } from "../context.js";
import { all, nowIso, one, run } from "../db/index.js";
import { decryptSecret } from "../lib/crypto.js";
import { openAlert } from "./monitoring.js";
import { audit } from "./users.js";

/**
 * Politically exposed person (PEP) screening through the OpenSanctions match API: people who hold or
 * held political office, and their relatives and close associates (topics role.pep and role.rca).
 * A possible match opens a compliance alert. While it's open, payouts wait and identity checks aren't
 * approved automatically. When a reviewer confirms it (escalates), the customer is marked as a PEP:
 * enhanced due diligence, so every payout waits for a second person.
 * Off until OPENSANCTIONS_API_KEY is set (OpenSanctions sells prepaid credit bundles for business use).
 */

export function pepConfigured(ctx: Ctx) {
  return Boolean(ctx.config.OPENSANCTIONS_API_KEY);
}

type Subject = "legal_name" | "business_person";
const SUBJECT_LABEL: Record<Subject, string> = { legal_name: "Legal name (identity details)", business_person: "Company director or owner" };

interface MatchResult {
  id: string;
  caption: string;
  score: number;
  match: boolean;
  datasets?: string[];
  properties?: { topics?: string[]; position?: string[]; country?: string[]; birthDate?: string[] };
}

export interface PepCheck {
  status: "clear" | "match" | "error" | "off";
  matches: { id: string; caption: string; score: number; topics: string[] }[];
}

/** Screens one person. Never throws: a failed check comes back as status "error" for the caller to act on. */
export async function screenPep(ctx: Ctx, userId: string, person: { name: string; birthDate?: string | null; nationality?: string | null }, subject: Subject): Promise<PepCheck> {
  if (!pepConfigured(ctx)) return { status: "off", matches: [] };
  const properties: Record<string, string[]> = { name: [person.name] };
  if (person.birthDate) properties.birthDate = [person.birthDate];
  if (person.nationality) properties.nationality = [person.nationality];
  const url = new URL("/match/default", ctx.config.OPENSANCTIONS_URL);
  url.searchParams.append("topics", "role.pep");
  url.searchParams.append("topics", "role.rca");
  url.searchParams.set("threshold", String(ctx.config.PEP_THRESHOLD));
  url.searchParams.set("limit", "5");
  let results: MatchResult[];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `ApiKey ${ctx.config.OPENSANCTIONS_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ queries: { q: { schema: "Person", properties } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { responses?: { q?: { results?: MatchResult[] } } };
    results = body.responses?.q?.results ?? [];
  } catch (err) {
    console.warn(`[pep] screening failed: ${(err as Error).message}`);
    audit(ctx, null, "pep.screening_failed", { userId, subject });
    return { status: "error", matches: [] };
  }
  const matches = results
    .filter((r) => r.match)
    .map((r) => ({ id: r.id, caption: r.caption, score: Math.round(r.score * 100) / 100, topics: (r.properties?.topics ?? []).filter((t) => t.startsWith("role.") || t.startsWith("gov.") || t.startsWith("pol.")) }));
  // Evidence of every check, without the names (same table as sanctions screening).
  run(ctx.db, "INSERT INTO sanctions_checks (user_id, subject, result, matches, created_at) VALUES (?, ?, ?, ?, ?)", userId, `pep_${subject}`, matches.length ? "possible_match" : "clear", JSON.stringify(matches.map((m) => ({ id: m.id, score: m.score }))), nowIso());
  for (const m of matches) {
    const relative = m.topics.includes("role.rca") && !m.topics.includes("role.pep");
    openAlert(ctx, userId, "pep_match", `${userId}:pep:${subject}:${m.id}`, `${SUBJECT_LABEL[subject]} resembles "${m.caption}", ${relative ? "a relative or close associate of a politically exposed person" : "a politically exposed person"} (${Math.round(m.score * 100)}% match)`, {
      subject,
      screenedName: person.name,
      customerBirthDate: person.birthDate ?? null,
      entity: m.id,
      listedName: m.caption,
      score: m.score,
      topics: m.topics,
      source: "OpenSanctions",
    });
  }
  return { status: matches.length ? "match" : "clear", matches };
}

/**
 * True while PEP screening should stop an automatic identity approval: screening is on and the
 * customer's legal name hasn't been screened yet (the check failed), or a possible match is open.
 */
export function pepBlocksAutoApproval(ctx: Ctx, userId: string) {
  if (!pepConfigured(ctx)) return false;
  if (!one(ctx.db, "SELECT 1 FROM sanctions_checks WHERE user_id = ? AND subject = 'pep_legal_name'", userId)) return true;
  return Boolean(one(ctx.db, "SELECT 1 FROM compliance_alerts WHERE user_id = ? AND rule = 'pep_match' AND status = 'open'", userId));
}

// ---------------------------------------------------------------------------
// Re-screening: people already checked are checked again every PEP_RESCREEN_DAYS (people take up and
// leave public office, so a customer who was clear at sign-up may not be now).
// ---------------------------------------------------------------------------
interface DuePerson {
  userId: string;
  subject: Subject;
  name: string;
  birthDate: string | null;
  nationality: string | null;
  lastChecked: string | null;
}

/** Everyone due for a (re-)check: verified legal names and company directors and owners, oldest check first. */
export function pepDue(ctx: Ctx): DuePerson[] {
  const days = ctx.config.PEP_RESCREEN_DAYS;
  if (!pepConfigured(ctx) || days <= 0) return [];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const last = (userId: string, subject: Subject) =>
    one<{ at: string | null }>(ctx.db, "SELECT MAX(created_at) AS at FROM sanctions_checks WHERE user_id = ? AND subject = ?", userId, `pep_${subject}`)?.at ?? null;
  const out: DuePerson[] = [];
  const seen = new Set<string>();
  for (const s of all<{ user_id: string; data_enc: string }>(
    ctx.db,
    `SELECT s.user_id, s.data_enc FROM kyc_submissions s JOIN users u ON u.id = s.user_id
     WHERE s.level = 1 AND s.status = 'approved' AND s.data_enc IS NOT NULL AND u.closed_at IS NULL ORDER BY s.created_at DESC`,
  )) {
    if (seen.has(s.user_id)) continue; // the latest approved submission only
    seen.add(s.user_id);
    const at = last(s.user_id, "legal_name");
    if (at && at > cutoff) continue;
    try {
      const d = JSON.parse(decryptSecret(s.data_enc, ctx.config.masterKey)) as { legalName?: string; dateOfBirth?: string; nationality?: string };
      if (d.legalName) out.push({ userId: s.user_id, subject: "legal_name", name: d.legalName, birthDate: d.dateOfBirth ?? null, nationality: d.nationality ?? null, lastChecked: at });
    } catch {
      /* unreadable with the current key: skip */
    }
  }
  for (const b of all<{ user_id: string; people_enc: string }>(ctx.db, "SELECT user_id, people_enc FROM business_profiles WHERE status IN ('pending','approved') AND people_enc IS NOT NULL")) {
    const at = last(b.user_id, "business_person");
    if (at && at > cutoff) continue;
    try {
      for (const p of JSON.parse(decryptSecret(b.people_enc, ctx.config.masterKey)) as { name: string; dateOfBirth?: string; nationality?: string }[]) {
        out.push({ userId: b.user_id, subject: "business_person", name: p.name, birthDate: p.dateOfBirth ?? null, nationality: p.nationality ?? null, lastChecked: at });
      }
    } catch {
      /* unreadable with the current key: skip */
    }
  }
  return out.sort((a, b) => (a.lastChecked ?? "").localeCompare(b.lastChecked ?? ""));
}

/** Re-screens up to `max` people that are due (each check uses one OpenSanctions credit). */
export async function rescreenPeps(ctx: Ctx, max = ctx.config.PEP_RESCREEN_BATCH) {
  const due = pepDue(ctx);
  let screened = 0;
  let matches = 0;
  let failed = 0;
  for (const p of due.slice(0, max)) {
    const r = await screenPep(ctx, p.userId, { name: p.name, birthDate: p.birthDate, nationality: p.nationality }, p.subject);
    if (r.status === "error") {
      failed++;
      if (failed >= 3) break; // OpenSanctions unreachable: try again on the next run
      continue;
    }
    screened++;
    matches += r.matches.length;
  }
  return { due: due.length, screened, matches, failed };
}

/** Runs a re-screening batch a few times a day while anyone is due. */
export function startPepRescreenJob(ctx: Ctx, everyMs = 6 * 3600_000) {
  if (!pepConfigured(ctx) || ctx.config.PEP_RESCREEN_DAYS <= 0) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await rescreenPeps(ctx);
      if (r.screened || r.failed) console.log(`[pep] re-screened ${r.screened} of ${r.due} due (${r.matches} possible matches, ${r.failed} failed)`);
    } catch (err) {
      console.error("[pep]", err);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  first.unref();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
