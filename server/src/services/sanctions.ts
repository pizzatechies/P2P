import type { Config } from "../config.js";
import type { Ctx } from "../context.js";
import { decryptSecret } from "../lib/crypto.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { openAlert } from "./monitoring.js";

/**
 * Sanctions screening against the UN Security Council Consolidated List, the US Treasury's OFAC SDN
 * list (with its aliases), the EU's consolidated financial sanctions list and the UK Sanctions List,
 * each downloaded from the official source and refreshed daily (SANCTIONS_LISTS chooses which), plus
 * the operator's own list: national designations or anyone else they must screen for, uploaded as CSV.
 *
 * Customers are screened on their legal name and date of birth when they submit identity details,
 * on their display name at sign-up, and again whenever the lists change. Payout recipients are
 * screened before money is sent. A possible match opens a high-severity compliance alert. Until an
 * admin clears it, the customer can't send or withdraw and nobody can pay them, and identity
 * submissions aren't approved automatically. Name matching tolerates word order, accents,
 * punctuation and small spelling differences; a different year of birth rules a person out.
 */

export type DownloadedList = Config["SANCTIONS_LISTS"][number];
export type ListId = DownloadedList | "own";
export type EntryKind = "individual" | "entity";

interface Entry {
  list: ListId;
  ref: string;
  kind: EntryKind;
  name: string;
  aliases: string[];
  birthYears: number[];
  programs: string;
  countries: string[];
}

export const LIST_NAMES: Record<ListId, string> = {
  un: "UN Security Council Consolidated List",
  ofac: "US Treasury OFAC SDN List",
  eu: "EU Consolidated Financial Sanctions List",
  uk: "UK Sanctions List",
  own: "Your own list",
};

/** The official lists in use, in the order they're shown. */
const enabledLists = (ctx: Ctx): DownloadedList[] => (ctx.config.SANCTIONS_SCREENING ? ctx.config.SANCTIONS_LISTS : []);

// ---------------------------------------------------------------------------
// Parsing the official files
// ---------------------------------------------------------------------------
const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeXml(m[1]) : "";
};
const tags = (block: string, name: string) => [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => decodeXml(m[1])).filter(Boolean);

/** The UN Consolidated List (XML): individuals and entities, with aliases and dates of birth. */
export function parseUnList(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const kind of ["INDIVIDUAL", "ENTITY"] as const) {
    for (const m of xml.matchAll(new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`, "g"))) {
      const b = m[1];
      const name = ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"].map((t) => tag(b, t)).filter(Boolean).join(" ");
      if (!name) continue;
      const years = new Set<number>();
      for (const dob of tags(b, "INDIVIDUAL_DATE_OF_BIRTH")) {
        for (const y of [tag(dob, "YEAR"), tag(dob, "DATE").slice(0, 4)]) if (/^\d{4}$/.test(y)) years.add(Number(y));
        const from = Number(tag(dob, "FROM_YEAR"));
        const to = Number(tag(dob, "TO_YEAR"));
        if (from && to && to >= from && to - from <= 15) for (let y = from; y <= to; y++) years.add(y);
      }
      out.push({
        list: "un",
        ref: tag(b, "REFERENCE_NUMBER") || tag(b, "DATAID"),
        kind: kind === "INDIVIDUAL" ? "individual" : "entity",
        name,
        aliases: tags(b, "ALIAS_NAME"),
        birthYears: [...years],
        programs: tag(b, "UN_LIST_TYPE"),
        countries: tags(b.match(/<NATIONALITY>([\s\S]*?)<\/NATIONALITY>/)?.[1] ?? "", "VALUE"),
      });
    }
  }
  return out;
}

/** A CSV line parser for the OFAC files (quoted fields, commas inside quotes, "" escapes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() && f.trim() !== "\x1a")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() && f.trim() !== "\x1a")) rows.push(row);
  return rows;
}

const ofacField = (v: string | undefined) => (!v || v.trim() === "-0-" ? "" : v.trim());

/** The OFAC SDN list (sdn.csv) and its aliases (alt.csv). */
export function parseOfacList(sdnCsv: string, altCsv: string): Entry[] {
  const aliases = new Map<string, string[]>();
  for (const r of parseCsv(altCsv)) {
    const id = ofacField(r[0]);
    const alt = ofacField(r[3]);
    if (id && alt) aliases.set(id, [...(aliases.get(id) ?? []), alt]);
  }
  const out: Entry[] = [];
  for (const r of parseCsv(sdnCsv)) {
    const id = ofacField(r[0]);
    const name = ofacField(r[1]);
    if (!id || !name || !/^\d+$/.test(id)) continue;
    const type = ofacField(r[2]).toLowerCase();
    const remarks = ofacField(r[11]);
    const years = new Set<number>();
    for (const m of remarks.matchAll(/DOB ([^;]+)/g)) for (const y of m[1].matchAll(/\b(19\d{2}|20\d{2})\b/g)) years.add(Number(y[1]));
    const nationality = [...remarks.matchAll(/nationality ([A-Za-z ,'.-]+?)(?:;|$)/gi)].map((m) => m[1].trim().replace(/\.$/, ""));
    out.push({
      list: "ofac",
      ref: id,
      kind: type === "individual" ? "individual" : "entity",
      name,
      aliases: aliases.get(id) ?? [],
      birthYears: [...years],
      programs: ofacField(r[3]),
      countries: nationality,
    });
  }
  return out;
}

const attr = (tagText: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tagText);
  return m ? decodeXml(m[1]) : "";
};
const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];
/** Years from a "from"-"to" range, when the range is narrow enough to mean something. */
const addRange = (years: Set<number>, from: number, to: number) => {
  if (from && to && to >= from && to - from <= 15) for (let y = from; y <= to; y++) years.add(y);
};

/**
 * The EU consolidated list (XML 1.1): one sanctionEntity per person or organisation, each name and
 * spelling a nameAlias (many in other alphabets; only names written in Latin letters are kept, as
 * customers' names are), with dates of birth, citizenships and the sanctions programmes.
 */
export function parseEuList(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<sanctionEntity\b([^>]*)>([\s\S]*?)<\/sanctionEntity>/g)) {
    const [, head, body] = m;
    const code = attr(/<subjectType\b[^>]*>/.exec(body)?.[0] ?? "", "code");
    if (code !== "person" && code !== "enterprise") continue;
    const names = unique([...body.matchAll(/<nameAlias\b[^>]*>/g)].map((n) => attr(n[0], "wholeName"))).filter((n) => nameTokens(n).length > 0);
    if (!names.length) continue;
    const years = new Set<number>();
    for (const b of body.matchAll(/<birthdate\b[^>]*>/g)) {
      const y = attr(b[0], "year") || attr(b[0], "birthdate").slice(0, 4);
      if (/^\d{4}$/.test(y)) years.add(Number(y));
      addRange(years, Number(attr(b[0], "yearRangeFrom")), Number(attr(b[0], "yearRangeTo")));
    }
    out.push({
      list: "eu",
      ref: attr(head, "euReferenceNumber") || `EU-${attr(head, "logicalId")}`,
      kind: code === "person" ? "individual" : "entity",
      name: names[0],
      aliases: names.slice(1),
      birthYears: [...years],
      programs: unique([...body.matchAll(/<regulation\b[^>]*>/g)].map((r) => attr(r[0], "programme"))).join(", "),
      countries: unique([...body.matchAll(/<citizenship\b[^>]*>/g)].map((c) => attr(c[0], "countryDescription"))).filter((c) => c !== "UNKNOWN"),
    });
  }
  return out;
}

/**
 * The UK Sanctions List (XML): one Designation per person, organisation or ship (ships are skipped).
 * Each name is split into Name1-Name5 (given names) and Name6 (surname, or an organisation's name).
 */
export function parseUkList(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<Designation>([\s\S]*?)<\/Designation>/g)) {
    const b = m[1];
    const type = tag(b, "IndividualEntityShip").toLowerCase();
    if (type !== "individual" && type !== "entity") continue;
    const primary: string[] = [];
    const others: string[] = [];
    for (const n of b.matchAll(/<Name>([\s\S]*?)<\/Name>/g)) {
      const full = ["Name1", "Name2", "Name3", "Name4", "Name5", "Name6"].map((t) => tag(n[1], t)).filter(Boolean).join(" ");
      if (full) (/^primary name$/i.test(tag(n[1], "NameType")) ? primary : others).push(full);
    }
    const names = unique([...primary, ...others]).filter((n) => nameTokens(n).length > 0);
    if (!names.length) continue;
    const years = new Set<number>();
    for (const d of tags(b, "DOB")) {
      const y = /(\d{4})$/.exec(d.trim());
      if (y) years.add(Number(y[1]));
    }
    out.push({
      list: "uk",
      ref: tag(b, "UniqueID"),
      kind: type === "individual" ? "individual" : "entity",
      name: names[0],
      aliases: names.slice(1),
      birthYears: [...years],
      programs: unique(tags(b, "RegimeName")).join(", "),
      countries: unique(type === "individual" ? tags(b, "Nationality") : tags(b, "AddressCountry")),
    });
  }
  return out;
}

const OWN_COLUMNS = {
  name: ["name", "fullname"],
  type: ["type", "kind"],
  aliases: ["aliases", "alias", "aka", "alsoknownas"],
  born: ["birthyears", "birthyear", "yearofbirth", "born", "dateofbirth", "dob"],
  ref: ["reference", "ref", "id"],
  programs: ["programme", "program", "programs", "regime", "source", "list"],
  countries: ["countries", "country", "nationality", "nationalities"],
} as const;
const OWN_MAX_ROWS = 50_000;

/**
 * Your own list, as CSV with a header row: a "name" column, and optionally type (individual or
 * entity), aliases (separated by ;), born (years of birth, or dates), reference, programme and
 * countries. For national designations that aren't published in a format we can download.
 */
export function parseOwnList(csv: string): Entry[] {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = (k: keyof typeof OWN_COLUMNS) => head.findIndex((h) => (OWN_COLUMNS[k] as readonly string[]).includes(h));
  const at = Object.fromEntries((Object.keys(OWN_COLUMNS) as (keyof typeof OWN_COLUMNS)[]).map((k) => [k, col(k)])) as Record<keyof typeof OWN_COLUMNS, number>;
  if (at.name < 0) throw badRequest('The first row must name the columns, with at least a "name" column.');
  if (rows.length - 1 > OWN_MAX_ROWS) throw badRequest(`Up to ${OWN_MAX_ROWS.toLocaleString("en-US")} names per list.`);
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const out: Entry[] = [];
  const refs = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const name = cell(r, at.name);
    if (!nameTokens(name).length) return;
    let ref = cell(r, at.ref) || `row-${i + 2}`;
    if (refs.has(ref)) ref = `${ref}-row-${i + 2}`;
    refs.add(ref);
    out.push({
      list: "own",
      ref: ref.slice(0, 80),
      kind: /^(entity|company|organi[sz]ation|business|group)$/i.test(cell(r, at.type)) ? "entity" : "individual",
      name: name.slice(0, 300),
      aliases: unique(cell(r, at.aliases).split(/[;|]/).map((a) => a.trim().slice(0, 300))).filter((a) => nameTokens(a).length > 0).slice(0, 50),
      birthYears: [...new Set([...cell(r, at.born).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((y) => Number(y[1])))],
      programs: cell(r, at.programs).slice(0, 200),
      countries: unique(cell(r, at.countries).split(/[;|]/).map((c) => c.trim().slice(0, 80))),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Loading and refreshing
// ---------------------------------------------------------------------------
async function download(url: string) {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": "Aurex sanctions screening" }, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`couldn't download ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

function store(ctx: Ctx, list: ListId, source: string, entries: Entry[]) {
  // A file that suddenly lists almost nobody is more likely broken than a real change; keep the old one.
  // (Your own list can be any size: you uploaded it.)
  const before = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sanctions_entries WHERE list = ?", list)!.n;
  if (list !== "own" && (entries.length < 50 || (before > 0 && entries.length < before * 0.5))) {
    throw new Error(`${LIST_NAMES[list]}: only ${entries.length} entries parsed (had ${before}); keeping the previous copy`);
  }
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM sanctions_entries WHERE list = ?", list);
    for (const e of entries) {
      run(
        ctx.db,
        "INSERT INTO sanctions_entries (list, ref, kind, name, aliases, birth_years, programs, countries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        list,
        e.ref,
        e.kind,
        e.name,
        JSON.stringify(e.aliases),
        JSON.stringify(e.birthYears),
        e.programs,
        JSON.stringify(e.countries),
      );
    }
    run(
      ctx.db,
      `INSERT INTO sanctions_lists (list, source, entries, fetched_at, error, checked_at) VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (list) DO UPDATE SET source = excluded.source, entries = excluded.entries, fetched_at = excluded.fetched_at, error = NULL, checked_at = excluded.checked_at`,
      list,
      source,
      entries.length,
      nowIso(),
      nowIso(),
    );
  });
  invalidateIndex(ctx);
}

function recordError(ctx: Ctx, list: ListId, source: string, message: string) {
  run(
    ctx.db,
    `INSERT INTO sanctions_lists (list, source, entries, fetched_at, error, checked_at) VALUES (?, ?, 0, '', ?, ?)
     ON CONFLICT (list) DO UPDATE SET error = excluded.error, checked_at = excluded.checked_at`,
    list,
    source,
    message.slice(0, 300),
    nowIso(),
  );
}

const SOURCE_URL: Record<DownloadedList, (c: Config) => string> = {
  un: (c) => c.SANCTIONS_UN_URL,
  ofac: (c) => c.SANCTIONS_OFAC_SDN_URL,
  eu: (c) => c.SANCTIONS_EU_URL,
  uk: (c) => c.SANCTIONS_UK_URL,
};
const FETCH: Record<DownloadedList, (c: Config) => Promise<Entry[]>> = {
  un: async (c) => parseUnList(await download(c.SANCTIONS_UN_URL)),
  ofac: async (c) => {
    const [sdn, alt] = await Promise.all([download(c.SANCTIONS_OFAC_SDN_URL), download(c.SANCTIONS_OFAC_ALT_URL)]);
    return parseOfacList(sdn, alt);
  },
  eu: async (c) => parseEuList(await download(c.SANCTIONS_EU_URL)),
  uk: async (c) => parseUkList(await download(c.SANCTIONS_UK_URL)),
};

/** Downloads the lists in use, one at a time (some are 20+ MB); a list that fails keeps its previous copy. Then re-screens every customer. */
export async function refreshSanctionsLists(ctx: Ctx) {
  const results: { list: ListId; ok: boolean; entries: number; error?: string }[] = [];
  for (const list of enabledLists(ctx)) {
    const source = SOURCE_URL[list](ctx.config);
    try {
      const entries = await FETCH[list](ctx.config);
      store(ctx, list, source, entries);
      results.push({ list, ok: true, entries: entries.length });
    } catch (err) {
      recordError(ctx, list, source, (err as Error).message);
      results.push({ list, ok: false, entries: 0, error: (err as Error).message });
    }
  }
  const rescreened = results.some((r) => r.ok) ? await rescreenAll(ctx) : { customers: 0, matches: 0 };
  return { results, rescreened };
}

/** Replaces your own list with an uploaded CSV (or removes it, with no rows), then re-screens everyone. */
export async function setOwnList(ctx: Ctx, csv: string | null) {
  const entries = csv === null ? [] : parseOwnList(csv);
  if (csv !== null && entries.length === 0) throw badRequest("No names found in that file.");
  if (entries.length) store(ctx, "own", "uploaded", entries);
  else
    tx(ctx.db, () => {
      run(ctx.db, "DELETE FROM sanctions_entries WHERE list = 'own'");
      run(ctx.db, "DELETE FROM sanctions_lists WHERE list = 'own'");
    });
  invalidateIndex(ctx);
  const rescreened = entries.length ? await rescreenAll(ctx) : { customers: 0, matches: 0 };
  return { entries: entries.length, rescreened };
}

export function listStatus(ctx: Ctx) {
  const rows = all<{ list: ListId; source: string; entries: number; fetched_at: string; error: string | null; checked_at: string | null }>(ctx.db, "SELECT * FROM sanctions_lists");
  const own = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sanctions_entries WHERE list = 'own'")!.n;
  return [...enabledLists(ctx), ...(own > 0 ? (["own"] as const) : [])].map((list) => {
    const r = rows.find((x) => x.list === list);
    return {
      list,
      downloaded: list !== "own",
      name: LIST_NAMES[list],
      entries: one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sanctions_entries WHERE list = ?", list)!.n,
      fetchedAt: r?.fetched_at || null,
      checkedAt: r?.checked_at ?? null,
      error: r?.error ?? null,
      source: r?.source ?? null,
    };
  });
}

/** Refreshes the lists once a day (and soon after start if they're old). Started from index.ts. */
export function startSanctionsJob(ctx: Ctx, everyMs = 6 * 3600_000) {
  if (!ctx.config.SANCTIONS_SCREENING) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const stale = listStatus(ctx).some((l) => l.downloaded && (!l.fetchedAt || Date.now() - Date.parse(l.fetchedAt) > 20 * 3600_000));
    if (!stale) return;
    busy = true;
    try {
      const r = await refreshSanctionsLists(ctx);
      console.log(`[sanctions] ${r.results.map((x) => (x.ok ? `${x.list}: ${x.entries} entries` : `${x.list}: ${x.error}`)).join("; ")}; re-screened ${r.rescreened.customers} customers`);
    } catch (err) {
      console.error("[sanctions]", err);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 15_000);
  first.unref();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
/** Honorifics and titles carry no identity. */
const STOP = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "shaykh", "sheikh", "sheik", "haji", "hajji", "mullah", "maulana", "maulvi", "general", "gen", "col", "colonel", "captain", "capt", "major", "brig", "the", "of", "and", "co", "ltd", "llc", "inc", "plc", "sa", "limited", "company"]);

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Jaro-Winkler similarity between two words (1 = identical). */
export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const TOKEN_MATCH = 0.88;

/** How well two names agree, 0..1: the share of each name's words found in the other, combined. */
export function nameScore(customer: string[], listed: string[]) {
  if (!customer.length || !listed.length) return 0;
  const weight = (t: string) => Math.min(t.length, 8);
  const covered = (from: string[], against: string[]) => {
    let hit = 0;
    let total = 0;
    for (const t of from) {
      total += weight(t);
      if (against.some((u) => (t.length <= 3 || u.length <= 3 ? t === u : jaroWinkler(t, u) >= TOKEN_MATCH))) hit += weight(t);
    }
    return hit / total;
  };
  const c = covered(customer, listed);
  const l = covered(listed, customer);
  return c && l ? (2 * c * l) / (c + l) : 0;
}

interface IndexedName {
  entry: number;
  tokens: string[];
  label: string;
}
interface Index {
  entries: (Entry & { id: number })[];
  names: IndexedName[];
  byPrefix: Map<string, number[]>;
}

const indexes = new WeakMap<object, Index>();
/** Forgets the in-memory index, so the next screening reads the lists afresh. */
export function invalidateIndex(ctx: Ctx) {
  indexes.delete(ctx.db);
}

function getIndex(ctx: Ctx): Index {
  const hit = indexes.get(ctx.db);
  if (hit) return hit;
  // Only the lists in use (a list switched off in SANCTIONS_LISTS keeps its rows but isn't screened against).
  const inUse: ListId[] = [...enabledLists(ctx), "own"];
  const rows = all<{ id: number; list: ListId; ref: string; kind: EntryKind; name: string; aliases: string; birth_years: string; programs: string; countries: string }>(
    ctx.db,
    `SELECT * FROM sanctions_entries WHERE list IN (${inUse.map(() => "?").join(",")})`,
    ...inUse,
  );
  const idx: Index = { entries: [], names: [], byPrefix: new Map() };
  for (const r of rows) {
    const e = { id: r.id, list: r.list, ref: r.ref, kind: r.kind, name: r.name, aliases: JSON.parse(r.aliases), birthYears: JSON.parse(r.birth_years), programs: r.programs, countries: JSON.parse(r.countries) };
    const at = idx.entries.push(e) - 1;
    for (const label of [e.name, ...e.aliases]) {
      const tokens = nameTokens(label);
      if (!tokens.length) continue;
      const n = idx.names.push({ entry: at, tokens, label }) - 1;
      for (const p of new Set(tokens.map((t) => t.slice(0, 3)))) {
        const list = idx.byPrefix.get(p);
        if (list) list.push(n);
        else idx.byPrefix.set(p, [n]);
      }
    }
  }
  indexes.set(ctx.db, idx);
  return idx;
}

export interface SanctionsMatch {
  list: ListId;
  listName: string;
  ref: string;
  kind: EntryKind;
  listedName: string;
  matchedName: string;
  score: number;
  birthYears: number[];
  programs: string;
  countries: string[];
}

/**
 * Possible matches for a name, best first. With a year of birth, a listed person born more than a
 * year apart is ruled out; companies and other entities are only considered when asked.
 */
export function screenName(ctx: Ctx, name: string, opts: { birthYear?: number | null; kinds?: EntryKind[]; threshold?: number } = {}): SanctionsMatch[] {
  const tokens = nameTokens(name);
  if (!tokens.length) return [];
  const idx = getIndex(ctx);
  const kinds = new Set(opts.kinds ?? ["individual"]);
  const candidates = new Set<number>();
  for (const t of tokens) for (const n of idx.byPrefix.get(t.slice(0, 3)) ?? []) candidates.add(n);
  const best = new Map<number, SanctionsMatch>();
  for (const n of candidates) {
    const cand = idx.names[n];
    const e = idx.entries[cand.entry];
    if (!kinds.has(e.kind)) continue;
    // A one-word name (an organisation's acronym, say) only matches exactly.
    if ((tokens.length === 1 || cand.tokens.length === 1) && tokens.join(" ") !== cand.tokens.join(" ")) continue;
    let score = nameScore(tokens, cand.tokens);
    if (opts.birthYear && e.birthYears.length) {
      if (!e.birthYears.some((y) => Math.abs(y - opts.birthYear!) <= 1)) continue;
      score = Math.min(1, score + 0.05);
    }
    if (score < (opts.threshold ?? 0.86)) continue;
    const prev = best.get(cand.entry);
    if (!prev || score > prev.score) {
      best.set(cand.entry, {
        list: e.list,
        listName: LIST_NAMES[e.list],
        ref: e.ref,
        kind: e.kind,
        listedName: e.name,
        matchedName: cand.label,
        score: Math.round(score * 100) / 100,
        birthYears: e.birthYears,
        programs: e.programs,
        countries: e.countries,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Screening customers and payees
// ---------------------------------------------------------------------------
type Subject = "legal_name" | "display_name" | "payee" | "business" | "business_person";
const SUBJECT_LABEL: Record<Subject, string> = {
  legal_name: "Legal name (identity details)",
  display_name: "Name given at sign-up",
  payee: "Payout recipient",
  business: "Business name",
  business_person: "Company director or owner",
};
/** Subjects screened under their own alert reference, so each one's matches are tracked separately. */
const OWN_REF = new Set<Subject>(["payee", "business", "business_person"]);

/** Screens a name for a customer and opens an alert per possible match. Returns the matches. */
export function screenForCustomer(ctx: Ctx, userId: string, name: string, subject: Subject, birthYear?: number | null): SanctionsMatch[] {
  if (!ctx.config.SANCTIONS_SCREENING) return [];
  const matches = screenName(ctx, name, { birthYear, kinds: subject === "payee" || subject === "business" ? ["individual", "entity"] : ["individual"] });
  run(
    ctx.db,
    "INSERT INTO sanctions_checks (user_id, subject, result, matches, created_at) VALUES (?, ?, ?, ?, ?)",
    userId,
    subject,
    matches.length ? "possible_match" : "clear",
    JSON.stringify(matches.map((m) => ({ list: m.list, ref: m.ref, score: m.score }))),
    nowIso(),
  );
  for (const m of matches) {
    openAlert(ctx, userId, "sanctions_match", `${userId}:${OWN_REF.has(subject) ? `${subject}:` : ""}${m.list}:${m.ref}`, `${SUBJECT_LABEL[subject]} resembles "${m.matchedName}" on the ${m.listName} (${m.ref}, ${Math.round(m.score * 100)}% match)`, {
      subject,
      screenedName: name,
      list: m.list,
      ref: m.ref,
      listedName: m.listedName,
      matchedName: m.matchedName,
      score: m.score,
      birthYears: m.birthYears,
      customerBirthYear: birthYear ?? null,
      programs: m.programs,
      countries: m.countries,
    });
  }
  return matches;
}

/** True while a possible sanctions match on this customer is open (not yet cleared by an admin). */
export function underSanctionsReview(ctx: Ctx, userId: string) {
  return Boolean(one(ctx.db, "SELECT 1 FROM compliance_alerts WHERE user_id = ? AND rule = 'sanctions_match' AND status IN ('open','escalated') LIMIT 1", userId));
}

/**
 * Blocks money movement for a customer under sanctions review. The message is deliberately generic:
 * telling someone they matched a sanctions list would tip them off.
 */
export function assertNotUnderSanctionsReview(ctx: Ctx, userId: string, who: "you" | "recipient") {
  if (!underSanctionsReview(ctx, userId)) return;
  throw new HttpError(
    403,
    "account_under_review",
    who === "you" ? "Your account is being reviewed, so payments are paused. Contact support if you have questions." : "This person can't receive payments right now.",
  );
}

/** Re-screens every customer after the lists change: legal names (from identity details) where known, else display names. */
export async function rescreenAll(ctx: Ctx) {
  if (!ctx.config.SANCTIONS_SCREENING) return { customers: 0, matches: 0 };
  let customers = 0;
  let matches = 0;
  const legalNames = new Map<string, { name: string; birthYear: number | null }>();
  for (const s of all<{ user_id: string; data_enc: string }>(
    ctx.db,
    "SELECT user_id, data_enc FROM kyc_submissions WHERE level = 1 AND status IN ('submitted','approved') AND data_enc IS NOT NULL ORDER BY created_at",
  )) {
    try {
      const d = JSON.parse(decryptSecret(s.data_enc, ctx.config.masterKey)) as { legalName?: string; dateOfBirth?: string };
      if (d.legalName) legalNames.set(s.user_id, { name: d.legalName, birthYear: Number(d.dateOfBirth?.slice(0, 4)) || null });
    } catch {
      /* unreadable with the current key: skip */
    }
  }
  const users = all<{ id: string; display_name: string }>(ctx.db, "SELECT id, display_name FROM users WHERE closed_at IS NULL");
  for (const u of users) {
    // Let other requests run between batches: screening thousands of customers takes a while.
    if (++customers % 200 === 0) await new Promise((r) => setImmediate(r));
    const legal = legalNames.get(u.id);
    matches += screenForCustomer(ctx, u.id, legal?.name ?? u.display_name, legal ? "legal_name" : "display_name", legal?.birthYear ?? null).length;
  }
  // Businesses too: their names, and the directors and owners of companies.
  for (const b of all<{ user_id: string; business_name: string; people_enc: string | null }>(
    ctx.db,
    "SELECT user_id, business_name, people_enc FROM business_profiles WHERE status IN ('pending','approved')",
  )) {
    matches += screenForCustomer(ctx, b.user_id, b.business_name, "business").length;
    if (!b.people_enc) continue;
    try {
      for (const p of JSON.parse(decryptSecret(b.people_enc, ctx.config.masterKey)) as { name: string; dateOfBirth?: string }[]) {
        matches += screenForCustomer(ctx, b.user_id, p.name, "business_person", Number(p.dateOfBirth?.slice(0, 4)) || null).length;
      }
    } catch {
      /* unreadable with the current key: skip */
    }
  }
  return { customers, matches };
}
