import { createHash, randomBytes } from "node:crypto";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { decryptSecret, encryptSecret, safeEqual, sha256 } from "../lib/crypto.js";
import { badRequest, HttpError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { sendEmail, simpleHtml } from "../lib/mailer.js";
import { sniffDocument } from "./kyc.js";
import { nameScore, nameTokens } from "./sanctions.js";
import { addAlert } from "./security.js";
import { callbackCheck, smileConfigured, startPersonGovernmentCheck, type SmileWebhook } from "./smileid.js";
import { audit } from "./users.js";

/**
 * Identity checks for a company's directors and owners who aren't the applicant (know your business).
 * Each gets a private link, by email or passed on by the applicant, where they give their ID details,
 * a photo of their ID and a selfie. Where Smile ID covers their country and ID, the ID number is also
 * checked with the issuing authority. A company isn't approved until everyone has done theirs
 * (KYB_PERSON_CHECKS). Their details and photos are encrypted; only reviewers can open them.
 */

export interface ListedPerson {
  name: string;
  role: "director" | "owner" | "director_owner";
  ownershipPct: number | null;
  dateOfBirth: string;
  nationality: string;
  email?: string;
  isApplicant?: boolean;
}

export interface PersonDetails {
  dateOfBirth: string;
  nationality: string;
  idType: "passport" | "national_id" | "drivers_license";
  idNumber: string;
  idCountry: string;
  idExpiry: string;
  phone: string;
  consentAt: string;
}

interface CheckRow {
  id: string;
  business_user_id: string;
  person_key: string;
  email_enc: string | null;
  token_hash: string | null;
  token_expires_at: string | null;
  status: "invited" | "submitted";
  data_enc: string | null;
  provider: string | null;
  provider_job_id: string | null;
  provider_status: string | null;
  provider_result: string | null;
  invited_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocRow {
  id: string;
  check_id: string;
  kind: PersonDocKind;
  mime: string;
  size: number;
  sha256: string;
  data_enc: string;
  created_at: string;
}

export const PERSON_DOC_KINDS = ["id_front", "id_back", "selfie"] as const;
export type PersonDocKind = (typeof PERSON_DOC_KINDS)[number];
const DOC_LABEL: Record<PersonDocKind, string> = { id_front: "ID (front)", id_back: "ID (back)", selfie: "Selfie" };
const LINK_DAYS = 14;
const MAX_DOC_BYTES = 5 * 1024 * 1024;

export const personChecksOn = (ctx: Ctx) => ctx.config.KYB_PERSON_CHECKS;

/** Identifies a listed person across re-applications: the same name and date of birth. */
export const personKey = (p: { name: string; dateOfBirth: string }) => sha256(`kyb-person:${nameTokens(p.name).join(" ")}|${p.dateOfBirth}`).slice(0, 32);

const linkFor = (ctx: Ctx, token: string) => new URL(`/verify-person/${token}`, ctx.config.APP_URL).toString();
const tokenHash = (token: string) => sha256(`kyb-person-link:${token}`);
const decrypt = <T>(ctx: Ctx, enc: string | null): T | null => {
  if (!enc) return null;
  try {
    return JSON.parse(decryptSecret(enc, ctx.config.masterKey)) as T;
  } catch {
    return null;
  }
};

function deleteCheck(ctx: Ctx, id: string) {
  run(ctx.db, "DELETE FROM business_person_documents WHERE check_id = ?", id);
  run(ctx.db, "DELETE FROM business_person_checks WHERE id = ?", id);
}

/** A fresh private link for a check (any older link stops working). */
function issueLink(ctx: Ctx, checkId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = nowIso();
  run(
    ctx.db,
    "UPDATE business_person_checks SET token_hash = ?, token_expires_at = ?, invited_at = ?, updated_at = ? WHERE id = ?",
    tokenHash(token),
    new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString(),
    now,
    now,
    checkId,
  );
  return token;
}

async function emailInvite(ctx: Ctx, to: string, person: ListedPerson, businessName: string, link: string) {
  const role = person.role === "director" ? "a director" : person.role === "owner" ? "an owner" : "a director and owner";
  const paragraphs = [
    `Hello ${person.name.split(/\s+/)[0]},`,
    `${businessName} is opening a business account with Aurex and has listed you as ${role}. The law requires us to confirm the identity of the people who run and own a business.`,
    `It takes about five minutes: your ID details, a photo of your ID and a selfie. The link works for ${LINK_DAYS} days.`,
    "If you don't know this business, ignore this email.",
  ];
  return sendEmail(ctx.config, {
    to,
    subject: `Confirm your identity for ${businessName}`,
    text: `${paragraphs.join("\n\n")}\n\n${link}`,
    html: simpleHtml(`Confirm your identity for ${businessName}`, paragraphs, undefined, { label: "Confirm my identity", url: link }),
  });
}

export interface PersonInvite {
  key: string;
  name: string;
  email: string;
  link: string;
  emailed: boolean;
}

/**
 * Brings the checks in line with the people on a company application: people no longer listed lose
 * theirs; everyone else who hasn't finished gets a fresh link (emailed). Finished checks are kept.
 */
export async function syncPersonChecks(ctx: Ctx, userId: string, businessName: string, people: ListedPerson[]): Promise<PersonInvite[]> {
  const others = personChecksOn(ctx) ? people.filter((p) => !p.isApplicant) : [];
  const keys = new Set(others.map(personKey));
  const existing = all<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE business_user_id = ?", userId);
  const toInvite: { person: ListedPerson; checkId: string }[] = [];
  tx(ctx.db, () => {
    for (const c of existing) if (!keys.has(c.person_key)) deleteCheck(ctx, c.id);
    for (const p of others) {
      const key = personKey(p);
      const emailEnc = encryptSecret(JSON.stringify(p.email ?? ""), ctx.config.masterKey);
      const c = existing.find((x) => x.person_key === key);
      if (c?.status === "submitted") continue;
      const id = c?.id ?? newId("bpc");
      if (c) run(ctx.db, "UPDATE business_person_checks SET email_enc = ?, updated_at = ? WHERE id = ?", emailEnc, nowIso(), id);
      else
        run(
          ctx.db,
          "INSERT INTO business_person_checks (id, business_user_id, person_key, email_enc, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'invited', ?, ?)",
          id,
          userId,
          key,
          emailEnc,
          nowIso(),
          nowIso(),
        );
      toInvite.push({ person: p, checkId: id });
    }
  });
  const out: PersonInvite[] = [];
  for (const { person, checkId } of toInvite) {
    const link = linkFor(ctx, issueLink(ctx, checkId));
    const emailed = person.email ? await emailInvite(ctx, person.email, person, businessName, link) : false;
    out.push({ key: personKey(person), name: person.name, email: person.email ?? "", link, emailed });
  }
  return out;
}

/** A new link for someone who lost theirs or let it expire (the old one stops working). */
export async function resendPersonInvite(ctx: Ctx, userId: string, key: string, businessName: string, person: ListedPerson, ip?: string): Promise<PersonInvite> {
  const c = one<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE business_user_id = ? AND person_key = ?", userId, key);
  if (!c) throw notFound("No identity check for that person");
  if (c.status === "submitted") throw unprocessable("already_done", `${person.name} has already confirmed their identity`);
  const link = linkFor(ctx, issueLink(ctx, c.id));
  const email = decrypt<string>(ctx, c.email_enc) ?? "";
  const emailed = email ? await emailInvite(ctx, email, person, businessName, link) : false;
  audit(ctx, userId, "business.person_link_reissued", { checkId: c.id, emailed }, ip);
  return { key, name: person.name, email, link, emailed };
}

/** Each listed person's check, as the applicant sees it (no ID details). */
export function personCheckStatus(ctx: Ctx, userId: string) {
  return Object.fromEntries(
    all<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE business_user_id = ?", userId).map((c) => [
      c.person_key,
      {
        status: c.status === "submitted" ? "done" : c.token_expires_at && Date.parse(c.token_expires_at) < Date.now() ? "expired" : "waiting",
        invitedAt: c.invited_at,
        expiresAt: c.status === "submitted" ? null : c.token_expires_at,
        submittedAt: c.submitted_at,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// The person's side: the private link
// ---------------------------------------------------------------------------
interface Opened {
  check: CheckRow;
  person: ListedPerson;
  businessName: string;
}

/** The open check behind a link: unexpired, not yet submitted, and still on the application. */
function open(ctx: Ctx, token: string, people: (userId: string) => { businessName: string; people: ListedPerson[] } | null): Opened {
  const gone = () => new HttpError(404, "link_invalid", "This link has expired or has already been used. Ask the business for a new one.");
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) throw gone();
  const check = one<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE token_hash = ?", tokenHash(token));
  if (!check || check.status !== "invited" || !check.token_expires_at || Date.parse(check.token_expires_at) < Date.now()) throw gone();
  const biz = people(check.business_user_id);
  const person = biz?.people.find((p) => !p.isApplicant && personKey(p) === check.person_key);
  if (!biz || !person) throw gone();
  return { check, person, businessName: biz.businessName };
}

const docsOf = (ctx: Ctx, checkId: string) => all<DocRow>(ctx.db, "SELECT * FROM business_person_documents WHERE check_id = ? ORDER BY created_at", checkId);
const needed = (d: PersonDetails | null): PersonDocKind[] => ["id_front", ...(d?.idType === "passport" ? [] : (["id_back"] as const)), "selfie"];

export type PeopleLookup = (userId: string) => { businessName: string; people: ListedPerson[] } | null;

export function personInviteView(ctx: Ctx, token: string, lookup: PeopleLookup) {
  const { check, person, businessName } = open(ctx, token, lookup);
  const details = decrypt<PersonDetails>(ctx, check.data_enc);
  return {
    businessName,
    name: person.name,
    role: person.role,
    ownershipPct: person.ownershipPct,
    detailsSaved: Boolean(details),
    details: details ? { idType: details.idType, idCountry: details.idCountry } : null,
    documents: docsOf(ctx, check.id).map((d) => d.kind),
    needed: needed(details),
    expiresAt: check.token_expires_at,
  };
}

export function savePersonDetails(ctx: Ctx, token: string, lookup: PeopleLookup, input: Omit<PersonDetails, "consentAt"> & { consent: boolean }) {
  const { check } = open(ctx, token, lookup);
  if (!input.consent) throw badRequest("Please agree to the identity check to continue");
  if (Date.parse(input.idExpiry) <= Date.now()) throw badRequest("This ID has expired");
  const { consent: _consent, ...rest } = input;
  const data: PersonDetails = { ...rest, idNumber: rest.idNumber.trim(), consentAt: nowIso() };
  run(ctx.db, "UPDATE business_person_checks SET data_enc = ?, updated_at = ? WHERE id = ?", encryptSecret(JSON.stringify(data), ctx.config.masterKey), nowIso(), check.id);
  return personInviteView(ctx, token, lookup);
}

export function uploadPersonDocument(ctx: Ctx, token: string, lookup: PeopleLookup, kind: PersonDocKind, body: Buffer) {
  const { check } = open(ctx, token, lookup);
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("Choose a photo to upload");
  if (body.length > MAX_DOC_BYTES) throw badRequest("Photos can be up to 5 MB");
  if (body.length < 1024) throw badRequest("That file is too small to be a readable photo");
  const mime = sniffDocument(body);
  if (!mime || mime === "application/pdf") throw badRequest("Upload a JPEG, PNG or WebP photo");
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM business_person_documents WHERE check_id = ? AND kind = ?", check.id, kind);
    run(
      ctx.db,
      "INSERT INTO business_person_documents (id, check_id, kind, mime, size, sha256, data_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      newId("bpd"),
      check.id,
      kind,
      mime,
      body.length,
      createHash("sha256").update(body).digest("hex"),
      encryptSecret(body.toString("base64"), ctx.config.masterKey),
      nowIso(),
    );
  });
  return personInviteView(ctx, token, lookup);
}

/** The person sends their check: the link is spent, the applicant is told, and the government check starts. */
export async function submitPersonCheck(ctx: Ctx, token: string, lookup: PeopleLookup, ip?: string) {
  const { check, person, businessName } = open(ctx, token, lookup);
  const details = decrypt<PersonDetails>(ctx, check.data_enc);
  if (!details) throw unprocessable("details_missing", "Fill in your ID details first");
  const have = new Set(docsOf(ctx, check.id).map((d) => d.kind));
  const missing = needed(details).filter((k) => !have.has(k));
  if (missing.length) throw unprocessable("documents_missing", `Add: ${missing.map((k) => DOC_LABEL[k]).join(", ")}`);
  run(ctx.db, "UPDATE business_person_checks SET status = 'submitted', token_hash = NULL, submitted_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), check.id);
  audit(ctx, null, "business.person_check_submitted", { checkId: check.id, business: check.business_user_id }, ip);
  addAlert(ctx, check.business_user_id, "account", `${person.name} has confirmed their identity for ${businessName}.`);
  if (smileConfigured(ctx)) {
    try {
      const email = decrypt<string>(ctx, check.email_enc) ?? "";
      const started = await startPersonGovernmentCheck(ctx, check.id, { legalName: person.name, dateOfBirth: details.dateOfBirth, phone: details.phone, idType: details.idType, idNumber: details.idNumber, idCountry: details.idCountry }, email);
      run(
        ctx.db,
        "UPDATE business_person_checks SET provider = 'smileid', provider_job_id = ?, provider_status = ?, provider_result = ?, updated_at = ? WHERE id = ?",
        started.started ? started.jobId : null,
        started.started ? "pending" : "skipped",
        started.started ? null : JSON.stringify({ status: "skipped", reason: started.reason }),
        nowIso(),
        check.id,
      );
    } catch (err) {
      run(ctx.db, "UPDATE business_person_checks SET provider = 'smileid', provider_status = 'error', provider_result = ?, updated_at = ? WHERE id = ?", JSON.stringify({ status: "error", message: (err as Error).message.slice(0, 200) }), nowIso(), check.id);
    }
  }
  return { done: true, businessName };
}

/** A government-record result for a person's check (bound to the check exactly like a customer's). */
export function applyPersonResult(ctx: Ctx, payload: SmileWebhook, lookup: PeopleLookup) {
  const p = payload.partner_params ?? {};
  const byJob = p.job_id ? one<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE provider_job_id = ? AND provider = 'smileid'", String(p.job_id)) : undefined;
  const byId = p.aurex_person_check ? one<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE id = ? AND provider = 'smileid'", String(p.aurex_person_check)) : undefined;
  const check = byJob ?? byId;
  if (!check) return null;
  if (!safeEqual(String(p.aurex_check ?? ""), callbackCheck(ctx, `person:${check.id}`))) return null;
  if (check.provider_job_id && p.job_id && String(p.job_id) !== check.provider_job_id) return null;
  if (check.provider_status !== "pending") return null;
  const details = decrypt<PersonDetails>(ctx, check.data_enc);
  const person = lookup(check.business_user_id)?.people.find((x) => personKey(x) === check.person_key) ?? null;
  const f = payload.id_fields ?? null;
  const recordName = f ? f.full_name || [f.first_name, f.other_names, f.last_name].filter(Boolean).join(" ") : "";
  const nameMatch = person && recordName ? Math.round(nameScore(nameTokens(person.name), nameTokens(recordName)) * 100) / 100 : null;
  const dobMatch = details && f?.date_of_birth ? f.date_of_birth.slice(0, 10) === details.dateOfBirth : null;
  const status = payload.status ?? "error";
  const result = { status, reason: payload.reason ?? null, message: payload.message ?? null, nameMatch, dobMatch, recordName: recordName || null, recordDob: f?.date_of_birth ?? null, checkedAt: nowIso() };
  run(ctx.db, "UPDATE business_person_checks SET provider_status = ?, provider_result = ?, updated_at = ? WHERE id = ?", status, JSON.stringify(result), nowIso(), check.id);
  audit(ctx, null, "business.person_government_check", { checkId: check.id, status, verified: status === "clear" && (nameMatch ?? 0) >= 0.85 && dobMatch !== false });
  return { checkId: check.id, result };
}

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------
/** Each listed person's check with what they sent, for the reviewer (keyed by person). */
export function personChecksForReview(ctx: Ctx, userId: string) {
  return Object.fromEntries(
    all<CheckRow>(ctx.db, "SELECT * FROM business_person_checks WHERE business_user_id = ?", userId).map((c) => {
      const d = decrypt<PersonDetails>(ctx, c.data_enc);
      return [
        c.person_key,
        {
          status: c.status,
          invitedAt: c.invited_at,
          submittedAt: c.submitted_at,
          linkExpired: c.status === "invited" && Boolean(c.token_expires_at && Date.parse(c.token_expires_at) < Date.now()),
          details: c.status === "submitted" && d ? { idType: d.idType, idNumber: d.idNumber, idCountry: d.idCountry, idExpiry: d.idExpiry, dateOfBirth: d.dateOfBirth, nationality: d.nationality } : null,
          documents: c.status === "submitted" ? docsOf(ctx, c.id).map((x) => ({ id: x.id, kind: x.kind, label: DOC_LABEL[x.kind] })) : [],
          government: c.provider_result ? (JSON.parse(c.provider_result) as Record<string, unknown>) : c.provider_status === "pending" ? { status: "pending" } : null,
        },
      ];
    }),
  );
}

/** People on the application who still haven't confirmed their identity. */
export function outstandingPersonChecks(ctx: Ctx, userId: string, people: ListedPerson[]) {
  if (!personChecksOn(ctx)) return [];
  const done = new Set(all<{ person_key: string }>(ctx.db, "SELECT person_key FROM business_person_checks WHERE business_user_id = ? AND status = 'submitted'", userId).map((r) => r.person_key));
  return people.filter((p) => !p.isApplicant && !done.has(personKey(p))).map((p) => p.name);
}

export function readPersonDocument(ctx: Ctx, docId: string) {
  const d = one<DocRow & { business_user_id: string }>(
    ctx.db,
    "SELECT d.*, c.business_user_id FROM business_person_documents d JOIN business_person_checks c ON c.id = d.check_id WHERE d.id = ? AND c.status = 'submitted'",
    docId,
  );
  if (!d) throw notFound("Document not found");
  return { kind: d.kind, mime: d.mime, userId: d.business_user_id, checkId: d.check_id, bytes: Buffer.from(decryptSecret(d.data_enc, ctx.config.masterKey), "base64") };
}
