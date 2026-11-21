import type { Ctx } from "../context.js";
import { nowIso, one, run } from "../db/index.js";
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
