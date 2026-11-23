import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.js";
import { nowIso, one, run } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";

/**
 * Push notifications through ntfy (https://ntfy.sh), the open-source push server, self-hosted next to
 * Aurex: no Firebase account, no Google or Apple keys. Each customer gets a private channel (a long
 * random topic name, which works like a password) and subscribes to it in the free ntfy app on
 * Android or iPhone. Aurex publishes to ntfy directly (PUSH_NTFY_URL, on the server's own network);
 * the public address (PUSH_NTFY_PUBLIC_URL) only lets phones read their channel.
 *
 * The channel changes after "sign out everywhere", a password change or reset, so a phone that
 * shouldn't get notifications any more stops getting them; closing the account switches them off.
 */

export type PushCategory = "payments" | "account";
export interface PushMessage {
  category: PushCategory;
  title: string;
  message: string;
  /** In-app page to open when the notification is tapped, e.g. "/app/payments". */
  path?: string;
  tags?: string[];
  priority?: 1 | 2 | 3 | 4 | 5;
}

export const pushConfigured = (ctx: Ctx) => Boolean(ctx.config.PUSH_NTFY_URL);
const publicBase = (ctx: Ctx) => (ctx.config.PUSH_NTFY_PUBLIC_URL ?? ctx.config.PUSH_NTFY_URL ?? "").replace(/\/+$/, "");
const newTopic = () => `aurex-${randomBytes(32).toString("base64url")}`;

export const NTFY_APPS = {
  android: { play: "https://play.google.com/store/apps/details?id=io.heckel.ntfy", fdroid: "https://f-droid.org/en/packages/io.heckel.ntfy/" },
  ios: { appStore: "https://apps.apple.com/us/app/ntfy/id1625396347" },
};

interface PushRow {
  push_topic_enc: string | null;
  push_payments: number;
  push_account: number;
  push_enabled_at: string | null;
  push_opens_app: number;
}
const row = (ctx: Ctx, userId: string) =>
  one<PushRow>(ctx.db, "SELECT push_topic_enc, push_payments, push_account, push_enabled_at, push_opens_app FROM users WHERE id = ?", userId);

function topicOf(ctx: Ctx, r: PushRow | undefined) {
  if (!r?.push_topic_enc) return null;
  try {
    return decryptSecret(r.push_topic_enc, ctx.config.masterKey);
  } catch {
    return null;
  }
}

/** What the Notifications card shows: whether push is set up, and the customer's private channel. */
export function pushStatus(ctx: Ctx, userId: string) {
  const r = row(ctx, userId);
  const topic = r?.push_enabled_at ? topicOf(ctx, r) : null;
  const base = publicBase(ctx);
  const host = base ? new URL(base).host : "";
  return {
    available: pushConfigured(ctx),
    enabled: Boolean(topic),
    server: base || null,
    topic,
    // Android: one tap subscribes in the ntfy app. iPhone: add the server and channel by hand.
    subscribeLink: topic ? `ntfy://${host}/${topic}?display=Aurex` : null,
    prefs: { payments: r?.push_payments !== 0, account: r?.push_account !== 0 },
    opens: r?.push_opens_app ? ("app" as const) : ("web" as const),
    apps: NTFY_APPS,
  };
}

/**
 * Switches notifications on (or re-reads the channel). `opens`: whether tapping a notification
 * should open the Aurex app or the website, depending on where the customer turned them on.
 */
export function enablePush(ctx: Ctx, userId: string, opens: "app" | "web" = "web") {
  if (!pushConfigured(ctx)) throw new HttpError(503, "push_unavailable", "Notifications aren't set up on this server yet");
  const r = row(ctx, userId);
  if (!topicOf(ctx, r)) run(ctx.db, "UPDATE users SET push_topic_enc = ? WHERE id = ?", encryptSecret(newTopic(), ctx.config.masterKey), userId);
  run(ctx.db, "UPDATE users SET push_enabled_at = COALESCE(push_enabled_at, ?), push_opens_app = ? WHERE id = ?", nowIso(), opens === "app" ? 1 : 0, userId);
  return pushStatus(ctx, userId);
}

export function disablePush(ctx: Ctx, userId: string) {
  run(ctx.db, "UPDATE users SET push_enabled_at = NULL, push_topic_enc = NULL WHERE id = ?", userId);
  return pushStatus(ctx, userId);
}

export function setPushPrefs(ctx: Ctx, userId: string, prefs: { payments?: boolean; account?: boolean }) {
  if (prefs.payments !== undefined) run(ctx.db, "UPDATE users SET push_payments = ? WHERE id = ?", prefs.payments ? 1 : 0, userId);
  if (prefs.account !== undefined) run(ctx.db, "UPDATE users SET push_account = ? WHERE id = ?", prefs.account ? 1 : 0, userId);
  return pushStatus(ctx, userId);
}

/**
 * A new private channel: phones subscribed to the old one stop getting notifications (after one last
 * message telling them why). For "sign out everywhere", password changes and resets.
 */
export async function rotatePushTopic(ctx: Ctx, userId: string) {
  const r = row(ctx, userId);
  const old = r?.push_enabled_at ? topicOf(ctx, r) : null;
  if (!old || !r) return;
  run(ctx.db, "UPDATE users SET push_topic_enc = ? WHERE id = ?", encryptSecret(newTopic(), ctx.config.masterKey), userId);
  await publish(ctx, old, Boolean(r.push_opens_app), {
    category: "account",
    title: "Set up Aurex notifications again",
    message: "Your account was signed out on other devices, so this channel no longer gets notifications. Open Aurex → Settings → Notifications to set them up again.",
    path: "/app/settings#notifications",
    tags: ["lock"],
  }).catch(() => false);
}

function clickUrl(ctx: Ctx, opensApp: boolean, path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return opensApp ? `aurex:/${p}` : `${ctx.config.appOrigin}${p}`;
}

async function publish(ctx: Ctx, topic: string, opensApp: boolean, m: PushMessage) {
  const url = ctx.config.PUSH_NTFY_URL!.replace(/\/+$/, "");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ctx.config.PUSH_NTFY_TOKEN ? { Authorization: `Bearer ${ctx.config.PUSH_NTFY_TOKEN}` } : {}) },
    body: JSON.stringify({
      topic,
      title: m.title.slice(0, 200),
      message: m.message.slice(0, 1000),
      // Tapping opens that page, in the Aurex app (aurex:// links) or on the website.
      click: m.path ? clickUrl(ctx, opensApp, m.path) : undefined,
      tags: m.tags,
      priority: m.priority ?? (m.category === "account" ? 4 : 3),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  return true;
}

/**
 * Sends a notification to the customer's phones if they've switched notifications on and that kind
 * is wanted. Never throws: a notification that can't be sent must not break a payment.
 */
export async function notify(ctx: Ctx, userId: string, m: PushMessage): Promise<boolean> {
  if (!pushConfigured(ctx)) return false;
  const r = row(ctx, userId);
  if (!r?.push_enabled_at) return false;
  if ((m.category === "payments" && r.push_payments === 0) || (m.category === "account" && r.push_account === 0)) return false;
  const topic = topicOf(ctx, r);
  if (!topic) return false;
  try {
    return await publish(ctx, topic, Boolean(r.push_opens_app), m);
  } catch (err) {
    if (!ctx.config.isTest) console.warn(`[push] ${(err as Error).message}`);
    return false;
  }
}

/** A test notification, from the Notifications card. */
export function sendTestPush(ctx: Ctx, userId: string) {
  if (!row(ctx, userId)?.push_enabled_at) throw new HttpError(422, "push_off", "Turn notifications on first");
  return notify(ctx, userId, { category: "account", title: "Aurex notifications work", message: "You'll be told here when money arrives and about important account activity.", path: "/app", tags: ["white_check_mark"] });
}

// ---------------------------------------------------------------------------
// What each in-app alert looks like as a notification
// ---------------------------------------------------------------------------
const SECURITY_KINDS = new Set(["new_device", "new_payee", "account_locked", "password_changed", "2fa_enabled", "2fa_disabled", "recovery_code_used", "recovery_codes", "security_hold", "admin"]);

/** The notification for an in-app alert (security, support, verification, account messages). */
export function alertPush(kind: string, message: string): PushMessage {
  if (SECURITY_KINDS.has(kind)) return { category: "account", title: "Aurex security alert", message, path: "/app/settings#security", tags: ["warning"], priority: 4 };
  if (kind === "support") return { category: "account", title: "Aurex support", message, path: "/app/help", tags: ["speech_balloon"] };
  if (kind === "upgrade") return { category: "account", title: "Aurex", message, path: "/app/upgrade" };
  return { category: "account", title: "Aurex", message, path: "/app" };
}
