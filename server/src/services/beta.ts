import { randomInt } from "node:crypto";
import type { Ctx } from "../context.js";
import { all, nowIso, one, run, tx } from "../db/index.js";
import { sha256 } from "../lib/crypto.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { sendEmail, simpleHtml } from "../lib/mailer.js";
import { audit } from "./users.js";

/**
 * A controlled launch. REGISTRATION_MODE decides who can create an account:
 * - open: anyone (subject to MAX_USERS);
 * - invite: only with an invite code from an admin; everyone else can join a waitlist;
 * - closed: nobody new.
 * ADMIN_EMAILS addresses can always sign up, so the operator can't lock themselves out.
 * Invite codes are stored only as hashes and shown once, when they're created.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const newCode = () => Array.from({ length: 10 }, (_, i) => (i === 5 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)]).join("");
const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hash = (code: string) => sha256(`invite:${normalise(code)}`);

function customerCount(ctx: Ctx) {
  return one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users WHERE role <> 'admin'")!.n;
}

/** What the sign-up page needs to know. */
export function signupStatus(ctx: Ctx) {
  const mode = ctx.config.REGISTRATION_MODE;
  const full = ctx.config.MAX_USERS > 0 && customerCount(ctx) >= ctx.config.MAX_USERS;
  return { mode, full, waitlist: mode !== "open" || full };
}

interface InviteRow {
  id: string;
  code_hash: string;
  hint: string;
  label: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

/**
 * Checks whether a new account may be created, and claims an invite use when one is needed. Runs
 * inside the registration transaction, so a code's last use can't be taken twice.
 */
export function admitSignup(ctx: Ctx, email: string, inviteCode: string | undefined): { inviteId: string | null } {
  if (ctx.config.adminEmails.has(email.toLowerCase())) return { inviteId: null };
  const mode = ctx.config.REGISTRATION_MODE;
  if (mode === "closed") throw new HttpError(403, "signups_closed", "Sign-ups are closed for now. Join the waitlist and we'll let you know.");
  if (ctx.config.MAX_USERS > 0 && customerCount(ctx) >= ctx.config.MAX_USERS) {
    throw new HttpError(403, "signups_full", "Aurex is full for now. Join the waitlist and we'll invite you as places open up.");
  }
  if (mode === "open" && !inviteCode) return { inviteId: null };
  if (!inviteCode?.trim()) throw new HttpError(403, "invite_required", "Aurex is invite-only during the beta. Enter your invite code, or join the waitlist.");
  const inv = one<InviteRow>(ctx.db, "SELECT * FROM invite_codes WHERE code_hash = ?", hash(inviteCode));
  const usable = inv && !inv.revoked_at && inv.uses < inv.max_uses && (!inv.expires_at || inv.expires_at > nowIso());
  if (!usable) {
    if (mode === "open") return { inviteId: null }; // an unknown code doesn't block an open sign-up
    throw new HttpError(403, "invite_invalid", "That invite code isn't valid (it may have expired or been used up).");
  }
  const claimed = run(ctx.db, "UPDATE invite_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL", inv.id);
  if (Number(claimed.changes) !== 1) throw new HttpError(403, "invite_invalid", "That invite code has just been used up.");
  return { inviteId: inv.id };
}

export function recordRedemption(ctx: Ctx, inviteId: string, userId: string) {
  run(ctx.db, "INSERT INTO invite_redemptions (invite_id, user_id, created_at) VALUES (?, ?, ?)", inviteId, userId, nowIso());
  run(ctx.db, "UPDATE waitlist SET joined_at = ? WHERE invite_id = ? AND joined_at IS NULL", nowIso(), inviteId);
}

// ---------------------------------------------------------------------------
// Admin: invites
// ---------------------------------------------------------------------------
const inviteView = (r: InviteRow & { joined?: number }) => ({
  id: r.id,
  hint: r.hint,
  label: r.label,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
  revoked: Boolean(r.revoked_at),
  status: r.revoked_at ? "revoked" : r.uses >= r.max_uses ? "used up" : r.expires_at && r.expires_at <= nowIso() ? "expired" : "active",
  createdAt: r.created_at,
});

/** Creates an invite code; the code itself is returned only here. */
export function createInvite(ctx: Ctx, adminId: string, opts: { label?: string; maxUses?: number; expiresInDays?: number }, ip?: string) {
  const code = newCode();
  const id = newId("inv");
  const maxUses = Math.min(Math.max(opts.maxUses ?? 1, 1), 1000);
  const expires = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString() : null;
  run(
    ctx.db,
    "INSERT INTO invite_codes (id, code_hash, hint, label, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
    id,
    hash(code),
    code.slice(0, 4),
    opts.label?.trim().slice(0, 80) || null,
    maxUses,
    expires,
    adminId,
    nowIso(),
  );
  audit(ctx, adminId, "beta.invite_created", { id, maxUses, expiresAt: expires }, ip);
  return { code, invite: inviteView(one<InviteRow>(ctx.db, "SELECT * FROM invite_codes WHERE id = ?", id)!) };
}

export function listInvites(ctx: Ctx) {
  return all<InviteRow>(ctx.db, "SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 200").map(inviteView);
}

export function revokeInvite(ctx: Ctx, adminId: string, id: string, ip?: string) {
  const changed = run(ctx.db, "UPDATE invite_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", nowIso(), id);
  if (Number(changed.changes) === 0) throw notFound("No active invite with that id");
  audit(ctx, adminId, "beta.invite_revoked", { id }, ip);
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------
/** Joins the waitlist. Always answers the same way, so it can't be used to learn who's on it. */
export function joinWaitlist(ctx: Ctx, email: string, name: string | undefined, country: string | undefined) {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badRequest("Enter a valid email address");
  run(
    ctx.db,
    "INSERT OR IGNORE INTO waitlist (id, email, name, country, created_at) VALUES (?, ?, ?, ?, ?)",
    newId("wl"),
    e,
    name?.trim().slice(0, 80) || null,
    country?.trim().toUpperCase().slice(0, 2) || null,
    nowIso(),
  );
  return { ok: true };
}

export function listWaitlist(ctx: Ctx) {
  return all<{ id: string; email: string; name: string | null; country: string | null; created_at: string; invited_at: string | null; joined_at: string | null }>(
    ctx.db,
    "SELECT * FROM waitlist ORDER BY (invited_at IS NOT NULL), created_at LIMIT 500",
  ).map((w) => ({ id: w.id, email: w.email, name: w.name, country: w.country, createdAt: w.created_at, invitedAt: w.invited_at, joinedAt: w.joined_at }));
}

/** Invites someone from the waitlist: a single-use code, emailed when email is set up. */
export async function inviteFromWaitlist(ctx: Ctx, adminId: string, id: string, ip?: string) {
  const w = one<{ id: string; email: string; name: string | null; invited_at: string | null }>(ctx.db, "SELECT * FROM waitlist WHERE id = ?", id);
  if (!w) throw notFound("Not on the waitlist");
  const { code, invite } = tx(ctx.db, () => {
    const created = createInvite(ctx, adminId, { label: w.name ?? w.email, maxUses: 1, expiresInDays: 30 }, ip);
    run(ctx.db, "UPDATE waitlist SET invited_at = ?, invite_id = ? WHERE id = ?", nowIso(), created.invite.id, w.id);
    return created;
  });
  const link = new URL("/register", ctx.config.APP_URL);
  link.searchParams.set("invite", code);
  const emailed =
    ctx.config.emailDelivery !== "none" &&
    (await sendEmail(ctx.config, {
      to: w.email,
      subject: "Your invite to Aurex",
      text: `You're in! Create your Aurex account with this invite code: ${code}\n\n${link}\n\nThe code works once and expires in 30 days.`,
      html: simpleHtml("You're invited to Aurex", ["You're in! Create your account with this invite code. It works once and expires in 30 days.", `Create your account: ${link}`], code),
    }).catch(() => false));
  return { code, invite, emailed: Boolean(emailed), link: link.toString() };
}
