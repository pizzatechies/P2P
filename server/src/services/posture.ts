import type { Ctx } from "../context.js";
import { smileConfigured } from "./smileid.js";
import { listStatus } from "./sanctions.js";
import { all, one } from "../db/index.js";
import { recentIntegrity } from "./integrity.js";
import { verifyLedger } from "./ledger.js";
import { safeguardingPosition } from "./safeguarding.js";

/**
 * A security checklist for admins: the settings and states that matter most for an app holding real
 * money, each with what to do about it. Nothing here is secret (it reports whether things are set,
 * never their values).
 */

export type CheckStatus = "pass" | "warn" | "fail";
export interface Check {
  id: string;
  area: "Secrets" | "Access" | "Money" | "Records" | "Network";
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export function securityPosture(ctx: Ctx) {
  const c = ctx.config;
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // Secrets
  add({
    id: "master_key",
    area: "Secrets",
    label: "Encryption key (MASTER_KEY)",
    status: c.MASTER_KEY ? "pass" : "fail",
    detail: c.MASTER_KEY ? "Set: stored keys, identity documents and seals use your own key." : "Not set: a built-in development key protects stored secrets.",
    fix: "Set MASTER_KEY to the output of: openssl rand -hex 32 (keep a copy somewhere safe).",
  });
  const admins = all<{ id: string; totp_enabled: number }>(ctx.db, "SELECT id, totp_enabled FROM users WHERE role = 'admin' AND status = 'active'");
  const no2fa = admins.filter((a) => !a.totp_enabled).length;

  // Access
  add({
    id: "admin_2fa",
    area: "Access",
    label: "Two-factor sign-in for admins",
    status: c.REQUIRE_ADMIN_2FA && no2fa === 0 ? "pass" : c.REQUIRE_ADMIN_2FA ? "warn" : "fail",
    detail: !c.REQUIRE_ADMIN_2FA
      ? "Admin tools work without two-factor authentication."
      : no2fa
        ? `${no2fa} admin account${no2fa === 1 ? " has" : "s have"} no two-factor yet, so can't use admin tools.`
        : `Required, and all ${admins.length} admin${admins.length === 1 ? "" : "s"} have it on.`,
    fix: "Keep REQUIRE_ADMIN_2FA=true; each admin turns on 2FA under Settings.",
  });
  add({
    id: "admin_ips",
    area: "Access",
    label: "Admin access limited to known IP addresses",
    status: c.adminAllowedIps.length ? "pass" : "warn",
    detail: c.adminAllowedIps.length ? `Admin tools only answer from ${c.adminAllowedIps.length} allowed address${c.adminAllowedIps.length === 1 ? "" : "es"} or ranges.` : "Admin tools answer from anywhere (still behind password, 2FA and re-authentication).",
    fix: "Set ADMIN_ALLOWED_IPS to your office or VPN addresses, e.g. 203.0.113.7,198.51.100.0/24.",
  });
  add({
    id: "admin_idle",
    area: "Access",
    label: "Admin sessions time out quickly",
    status: c.ADMIN_SESSION_IDLE_MINUTES > 0 && c.ADMIN_SESSION_IDLE_MINUTES <= 30 ? "pass" : "warn",
    detail: `Admins are signed out after ${c.ADMIN_SESSION_IDLE_MINUTES || "no"} minutes without activity; everyone else after ${c.SESSION_IDLE_MINUTES || "no"}.`,
    fix: "Set ADMIN_SESSION_IDLE_MINUTES to 30 or less.",
  });
  add({
    id: "admin_setup_code",
    area: "Access",
    label: "Becoming an admin needs a setup code",
    status: c.ADMIN_SETUP_CODE || !c.isProd ? "pass" : "warn",
    detail: c.ADMIN_SETUP_CODE ? "Set: an ADMIN_EMAILS account must also enter the code." : "Not set.",
    fix: "Set ADMIN_SETUP_CODE (openssl rand -hex 16) and remove it again once admins are set up.",
  });
  add({
    id: "alerts_email",
    area: "Access",
    label: "Security alerts reach people by email",
    status: c.emailDelivery !== "none" ? "pass" : "warn",
    detail: c.emailDelivery !== "none" ? "New sign-ins, password and 2FA changes, payouts to review and shortfalls are emailed." : "Alerts appear in the app only; nobody is emailed about a suspicious sign-in.",
    fix: "Connect an email provider (RESEND_API_KEY with a verified domain) once you have a domain of your own.",
  });

  // Network
  const https = c.APP_URL.startsWith("https://");
  add({
    id: "https",
    area: "Network",
    label: "HTTPS everywhere",
    status: https && c.isProd ? "pass" : c.isProd ? "fail" : "warn",
    detail: https ? "The app's address is HTTPS; cookies are Secure and __Host- prefixed, and browsers are told to use HTTPS only (HSTS)." : `The app's address is ${c.APP_URL}.`,
    fix: "Serve the app over HTTPS and set APP_URL=https://… and NODE_ENV=production.",
  });
  add({
    id: "proxy",
    area: "Network",
    label: "Real client addresses behind the proxy",
    status: c.TRUST_PROXY || !c.isProd ? "pass" : "warn",
    detail: c.TRUST_PROXY ? "Rate limits, lockouts and the admin allowlist see each visitor's own address." : "Behind a proxy, every visitor looks like the proxy's address.",
    fix: "Set TRUST_PROXY=true when running behind Caddy, nginx or a load balancer.",
  });

  // Money
  const sandbox = c.rails.includes("sandbox");
  add({
    id: "sandbox",
    area: "Money",
    label: "No test money in production",
    status: sandbox && c.isProd ? "warn" : "pass",
    detail: sandbox ? "The sandbox rail is on: anyone can add test money to their wallet." : "Only real payment rails are enabled.",
    fix: "Remove sandbox from PAYMENT_RAILS before taking real money.",
  });
  add({
    id: "payout_review",
    area: "Money",
    label: "Large withdrawals need a second person",
    status: c.PAYOUT_REVIEW ? "pass" : "fail",
    detail: c.PAYOUT_REVIEW ? `Withdrawals of $${c.PAYOUT_REVIEW_USD.toLocaleString("en-US")} or more, or by customers with an open alert, wait for approval.` : "Every withdrawal is sent straight away.",
    fix: "Set PAYOUT_REVIEW=true.",
  });
  add({
    id: "pep",
    area: "Money",
    label: "Politically exposed people are identified",
    status: c.OPENSANCTIONS_API_KEY ? "pass" : "warn",
    detail: c.OPENSANCTIONS_API_KEY
      ? "Identity checks and company directors and owners are screened for politically exposed people and their relatives and associates (OpenSanctions)."
      : "Nobody is screened for politically exposed people, which anti-money-laundering law requires.",
    fix: "Buy an OpenSanctions API credit bundle and set OPENSANCTIONS_API_KEY.",
  });
  const bots = Boolean(c.TURNSTILE_SITE_KEY && c.TURNSTILE_SECRET_KEY);
  add({
    id: "bot_protection",
    area: "Access",
    label: "Bots are kept out of sign-up and sign-in",
    status: bots ? "pass" : "warn",
    detail: bots ? "Sign-up, sign-in, password reset and the waitlist need a Cloudflare Turnstile check." : "Only rate limits slow down automated sign-ups and password guessing.",
    fix: "Create a free Turnstile widget in Cloudflare and set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.",
  });
  const approvers = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND closed_at IS NULL AND (? = 0 OR totp_enabled = 1)", c.REQUIRE_ADMIN_2FA ? 1 : 0)!.n;
  add({
    id: "two_person",
    area: "Access",
    label: "Raising limits needs a second admin",
    status: c.TWO_PERSON_APPROVAL === "off" ? "fail" : c.TWO_PERSON_APPROVAL === "on" || approvers >= 2 ? "pass" : "warn",
    detail:
      c.TWO_PERSON_APPROVAL === "off"
        ? "One admin can raise a customer's limits or set their identity level alone."
        : approvers >= 2 || c.TWO_PERSON_APPROVAL === "on"
          ? "Custom limits and hand-set identity levels wait for a different admin's approval."
          : "There's only one admin, so their changes apply straight away.",
    fix: c.TWO_PERSON_APPROVAL === "off" ? "Set TWO_PERSON_APPROVAL=auto." : "Add a second admin (with two-factor sign-in).",
  });
  add({
    id: "kyc",
    area: "Money",
    label: "Limits rise only with verified identity",
    status: c.KYC_LIMITS && !c.KYC_AUTO_APPROVE ? "pass" : "fail",
    detail: !c.KYC_LIMITS ? "Everyone gets the highest limits without verifying." : c.KYC_AUTO_APPROVE ? "Identity submissions are approved without anyone looking." : "Verification levels set the limits, and a person reviews each submission.",
    fix: "Set KYC_LIMITS=true and KYC_AUTO_APPROVE=false.",
  });
  add({
    id: "live_auto",
    area: "Money",
    label: "Real trading accounts are reviewed",
    status: c.LIVE_UPGRADE_AUTO_APPROVE ? "warn" : "pass",
    detail: c.LIVE_UPGRADE_AUTO_APPROVE ? "Real-account applications are approved automatically." : "An admin approves each real-account application.",
    fix: "Set LIVE_UPGRADE_AUTO_APPROVE=false.",
  });
  const position = safeguardingPosition(ctx);
  const short = position.filter((p) => p.status === "shortfall");
  const unverified = position.filter((p) => p.status === "unverified");
  add({
    id: "safeguarding",
    area: "Money",
    label: "Customers' money is all there",
    status: short.length ? "fail" : unverified.length ? "warn" : "pass",
    detail: short.length
      ? `Shortfall in ${short.map((p) => p.currency).join(", ")}.`
      : unverified.length
        ? `Not verified for ${unverified.map((p) => p.currency).join(", ")}: no safeguarding account or an out-of-date balance.`
        : position.length
          ? "Every currency is covered by recorded safeguarding balances."
          : "No customer money held yet.",
    fix: "Under Ledger & records → Safeguarding, register the accounts holding customers' money and record their balances daily.",
  });

  add({
    id: "id_checks",
    area: "Money",
    label: "ID numbers are checked against government records",
    status: smileConfigured(ctx) ? (c.SMILEID_ENV === "production" ? "pass" : "warn") : "warn",
    detail: smileConfigured(ctx)
      ? c.SMILEID_ENV === "production"
        ? "Smile ID checks each ID number with the issuing government and Aurex compares the name and date of birth."
        : "Smile ID is connected in sandbox mode: results are test data."
      : "Reviewers compare documents by eye; nothing checks the ID number with the government.",
    fix: "Set SMILEID_PARTNER_ID and SMILEID_API_KEY (and SMILEID_ENV=production once tested), and add /api/webhooks/smileid as your callback URL in the Smile ID portal.",
  });
  const lists = listStatus(ctx).filter((l) => l.downloaded);
  const loaded = lists.filter((l) => l.entries > 0);
  const stale = loaded.filter((l) => !l.fetchedAt || Date.now() - Date.parse(l.fetchedAt) > 3 * 86_400_000);
  add({
    id: "sanctions",
    area: "Money",
    label: "Customers are screened against sanctions lists",
    status: !c.SANCTIONS_SCREENING || loaded.length === 0 ? "fail" : stale.length || loaded.length < lists.length ? "warn" : "pass",
    detail: !c.SANCTIONS_SCREENING
      ? "Sanctions screening is switched off."
      : loaded.length === 0
        ? "The sanctions lists haven't been downloaded yet (the server fetches them shortly after starting)."
        : `${loaded.map((l) => `${l.name}: ${l.entries.toLocaleString("en-US")} entries`).join("; ")}.${stale.length ? " Some lists are more than 3 days old." : ""}${loaded.length < lists.length ? " A list hasn't downloaded yet." : ""}`,
    fix: "Keep SANCTIONS_SCREENING=true and make sure the server can reach scsanctions.un.org, treasury.gov, webgate.ec.europa.eu and sanctionslist.fcdo.gov.uk; Admin → Sanctions lists → Update now.",
  });

  // Records
  add({
    id: "retention",
    area: "Records",
    label: "Closed accounts' personal data is deleted after the retention period",
    status: c.RECORD_RETENTION_YEARS > 0 ? "pass" : "warn",
    detail:
      c.RECORD_RETENTION_YEARS > 0
        ? `Personal data is deleted ${c.RECORD_RETENTION_YEARS} years after an account closes (the ledger, audit log and compliance records are kept).`
        : "Closed accounts' personal data is kept indefinitely; data protection law expects a defined retention period.",
    fix: "Set RECORD_RETENTION_YEARS to the longest period the law requires in your countries (often 5 to 10 years).",
  });
  const ledger = verifyLedger(ctx);
  add({
    id: "ledger",
    area: "Records",
    label: "The books balance",
    status: ledger.ok ? "pass" : "fail",
    detail: ledger.ok ? "Every journal balances, cached balances match the entries, and system totals net to zero." : "The ledger check found a problem.",
    fix: "Open Admin → Ledger & records and investigate before moving money.",
  });
  const integrity = recentIntegrity(ctx);
  add({
    id: "integrity",
    area: "Records",
    label: "Books and audit log untouched",
    status: integrity.ok ? "pass" : "fail",
    detail: integrity.ok
      ? `${integrity.journals.checked} journals and ${integrity.audit.checked} audit events verify against their seals.`
      : `Broken seal: ${!integrity.journals.ok ? `journal ${integrity.journals.brokenAt}` : `audit event ${integrity.audit.brokenAt}`}. Records may have been changed outside Aurex.`,
    fix: "Restore from backup and investigate how the database was accessed.",
  });
  const lastSnapshot = one<{ day: string | null }>(ctx.db, "SELECT MAX(day) AS day FROM ledger_snapshots")!.day;
  const hasEntries = Boolean(one(ctx.db, "SELECT 1 FROM entries WHERE created_at < ? LIMIT 1", new Date().toISOString().slice(0, 10)));
  add({
    id: "snapshots",
    area: "Records",
    label: "End-of-day snapshots are being taken",
    status: !hasEntries || (lastSnapshot && Date.now() - Date.parse(`${lastSnapshot}T00:00:00Z`) < 3 * 86_400_000) ? "pass" : "warn",
    detail: lastSnapshot ? `Latest: ${lastSnapshot}.` : hasEntries ? "None yet." : "Nothing to snapshot yet.",
    fix: "Snapshots are written hourly by the server; check it's running continuously.",
  });

  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2 };
  checks.sort((a, b) => order[a.status] - order[b.status]);
  return {
    score: Math.round((checks.filter((x) => x.status === "pass").length / checks.length) * 100),
    failing: checks.filter((x) => x.status === "fail").length,
    warnings: checks.filter((x) => x.status === "warn").length,
    checks,
  };
}
