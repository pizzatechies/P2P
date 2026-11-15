import request from "supertest";
import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/app.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { decryptSecret, encryptSecret, totp } from "../src/lib/crypto.js";
import { checkPasswordRules } from "../src/lib/password.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const PASSWORD = "correct-horse-42";
type Agent = ReturnType<typeof request.agent>;

async function login(app: ReturnType<typeof makeApp>["app"], email: string, password: string, totpCode?: string, ua = "TestAgent/1.0") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("x-aurex-csrf", "1").set("user-agent", ua).send({ email, password, totpCode });
  return { agent, res };
}

/** Turns on 2FA and returns the secret plus the recovery codes. */
async function enable2fa(A: ReturnType<typeof api>) {
  const setup = await A.post("/api/settings/2fa/setup");
  const secret = setup.body.secret as string;
  const confirm = await A.post("/api/settings/2fa/confirm", { code: totp(secret) });
  expect(confirm.status).toBe(200);
  return { secret, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

/** Makes the session's last password check look old, so sensitive actions ask again. */
function expireReauth(ctx: ReturnType<typeof makeApp>["ctx"], userId: string) {
  ctx.db.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), userId);
}

describe("passwords", () => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:" });
  it("refuses short, common, repetitive and personal passwords", () => {
    expect(() => checkPasswordRules(config, "short1")).toThrow(/at least 12/);
    expect(() => checkPasswordRules(config, "Password2024!")).toThrow(/too common/);
    expect(() => checkPasswordRules(config, "qwerty123456")).toThrow(/too common/);
    expect(() => checkPasswordRules(config, "aaaaaaaaaaa1")).toThrow(/repetitive/);
    expect(() => checkPasswordRules(config, "kwame-2024-sunrise", { handle: "kwame" })).toThrow(/name, handle or email/);
    expect(() => checkPasswordRules(config, "amber-tractor-91-violin")).not.toThrow();
  });

  it("rejects passwords found in breaches, sending only a 5-character hash prefix", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update("breached-password-77").digest("hex").toUpperCase();
    const pwned = await stub((r) => (r.route === `/range/${hash.slice(0, 5)}` ? { text: `${hash.slice(5)}:4012\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0` } : { text: "" }));
    const { app } = makeApp({ PASSWORD_BREACH_CHECK: "true", PWNED_PASSWORDS_URL: `${pwned.url}/range/` });
    const res = await request(app).post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "b@example.com", handle: "breachy", displayName: "B", password: "breached-password-77" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/data breach/);
    expect(pwned.calls[0].route).toBe(`/range/${hash.slice(0, 5)}`);
    expect(pwned.calls[0].headers["add-padding"]).toBe("true");
    const ok = await request(app).post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "c@example.com", handle: "careful", displayName: "C", password: "amber-tractor-91-violin" });
    expect(ok.status).toBe(201);
  });
});

describe("account lockout", () => {
  it("locks an account after repeated failures, even against the right password, with escalating locks", async () => {
    const { app, ctx } = makeApp();
    const { user } = await signup(app, "lockme");
    for (let i = 0; i < 5; i++) expect((await login(app, user.email, "wrong-password-1")).res.status).toBe(401);
    const locked = await login(app, user.email, PASSWORD);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.error.code).toBe("account_locked");
    expect(locked.res.body.error.message).toMatch(/15 more minutes/);

    // The lock expires; the next run of failures locks for twice as long.
    ctx.db.prepare("UPDATE users SET locked_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), user.id);
    for (let i = 0; i < 5; i++) await login(app, user.email, "wrong-password-1");
    const row = ctx.db.prepare("SELECT locked_until, lockouts FROM users WHERE id = ?").get(user.id) as { locked_until: string; lockouts: number };
    expect(row.lockouts).toBe(2);
    expect(Date.parse(row.locked_until) - Date.now()).toBeGreaterThan(29 * 60_000);

    // The owner sees it.
    ctx.db.prepare("UPDATE users SET locked_until = NULL WHERE id = ?").run(user.id);
    const ok = await login(app, user.email, PASSWORD);
    expect(ok.res.status).toBe(200);
    const sec = await api(ok.agent).get("/api/settings/security");
    expect(sec.body.alerts.some((a: { kind: string }) => a.kind === "account_locked")).toBe(true);
  });
});

describe("two-factor authentication", () => {
  it("never accepts the same code twice, and gives one-time recovery codes", async () => {
    const { app, ctx } = makeApp();
    const { agent, user } = await signup(app, "twofa");
    const { secret, recoveryCodes } = await enable2fa(api(agent));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    // The code used to confirm setup can't be replayed to sign in.
    const setupReplay = await login(app, user.email, PASSWORD, totp(secret));
    expect(setupReplay.res.body.error.code).toBe("totp_invalid");
    const next = totp(secret, Date.now() + 30_000);
    expect((await login(app, user.email, PASSWORD, next)).res.status).toBe(200);
    expect((await login(app, user.email, PASSWORD, next)).res.body.error.code).toBe("totp_invalid");

    // A recovery code works once, starts a security hold and raises an alert.
    const viaRecovery = await login(app, user.email, PASSWORD, recoveryCodes[0].toUpperCase());
    expect(viaRecovery.res.status).toBe(200);
    expect((await login(app, user.email, PASSWORD, recoveryCodes[0])).res.body.error.code).toBe("totp_invalid");
    const sec = (await api(viaRecovery.agent).get("/api/settings/security")).body;
    expect(sec.recoveryCodesLeft).toBe(9);
    expect(sec.securityHoldUntil).toBeTruthy();
    expect(sec.alerts.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["recovery_code_used", "security_hold"]));

    // Only hashes are stored.
    const stored = ctx.db.prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ?").all(user.id) as { code_hash: string }[];
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash))).toBe(true);
  });
});

describe("re-authentication and security holds", () => {
  it("asks for the password (and 2FA) again before money leaves", async () => {
    const { app, ctx } = makeApp();
    const { agent, user } = await signup(app, "stepup");
    const A = api(agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "5000", currency: "USD" });
    const dest = { type: "bank_account", name: "Me", accountNumber: "12345678" };

    // Fresh sign-in counts as recent.
    expect((await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: dest })).status).toBe(201);

    expireReauth(ctx, user.id);
    const blocked = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: dest });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe("reauth_required");

    // Large sends need it too; small ones don't.
    const { user: friend } = await signup(app, "friend");
    expect((await A.post("/api/payments/send", { to: `@${friend.handle}`, amount: "20", currency: "USD" })).status).toBe(201);
    expect((await A.post("/api/payments/send", { to: `@${friend.handle}`, amount: "1500", currency: "USD" })).body.error.code).toBe("reauth_required");

    expect((await A.post("/api/auth/reauth", { password: "not-my-password" })).status).toBe(401);
    const ok = await A.post("/api/auth/reauth", { password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(Date.parse(ok.body.until)).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: dest })).status).toBe(201);
    expect((await A.post("/api/payments/send", { to: `@${friend.handle}`, amount: "1500", currency: "USD" })).status).toBe(201);

    // With 2FA on, re-authentication also needs a fresh code.
    const { secret } = await enable2fa(A);
    expireReauth(ctx, user.id);
    expect((await A.post("/api/auth/reauth", { password: PASSWORD })).body.error.code).toBe("totp_required");
    expect((await A.post("/api/auth/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  });

  it("pauses withdrawals and large sends for 24 hours after a password change, which also needs 2FA and signs out other devices", async () => {
    const { app } = makeApp();
    const { agent, user } = await signup(app, "changer");
    const A = api(agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const other = await login(app, user.email, PASSWORD, undefined, "OtherDevice/2.0");
    expect(other.res.status).toBe(200);
    const { secret } = await enable2fa(A);

    const noCode = await A.post("/api/settings/password", { currentPassword: PASSWORD, newPassword: "amber-tractor-91-violin" });
    expect(noCode.body.error.code).toBe("totp_required");
    const reused = await A.post("/api/settings/password", { currentPassword: PASSWORD, newPassword: PASSWORD, code: totp(secret, Date.now() + 30_000) });
    expect(reused.body.error.message).toMatch(/haven't used/);
    const changed = await A.post("/api/settings/password", { currentPassword: PASSWORD, newPassword: "amber-tractor-91-violin", code: totp(secret, Date.now() + 30_000) });
    expect(changed.status).toBe(200);

    expect((await api(other.agent).get("/api/auth/me")).status).toBe(401); // signed out
    const held = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } });
    expect(held.status).toBe(423);
    expect(held.body.error.code).toBe("security_hold");
  });
});

describe("sessions", () => {
  it("lists devices, revokes one, and expires idle sessions", async () => {
    const { app, ctx } = makeApp();
    const { user } = await signup(app, "devices");
    const phone = await login(app, user.email, PASSWORD, undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1");
    const laptop = await login(app, user.email, PASSWORD, undefined, "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36");
    const sessions = (await api(laptop.agent).get("/api/settings/security")).body.sessions as { id: string; device: string; current: boolean }[];
    expect(sessions.map((s) => s.device)).toEqual(expect.arrayContaining(["Safari on iOS", "Chrome on Windows"]));
    const phoneSession = sessions.find((s) => s.device === "Safari on iOS")!;
    expect(phoneSession.id).toMatch(/^[0-9a-f]{16}$/);

    // New device alerts.
    const alerts = (await api(laptop.agent).get("/api/settings/security")).body.alerts as { kind: string; message: string }[];
    expect(alerts.some((a) => a.kind === "new_device" && a.message.includes("Chrome on Windows"))).toBe(true);

    expect((await api(laptop.agent).del(`/api/settings/sessions/${phoneSession.id}`)).body.ok).toBe(true);
    expect((await api(phone.agent).get("/api/auth/me")).status).toBe(401);

    // Two hours without activity: signed out.
    ctx.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?").run(new Date(Date.now() - 3 * 3_600_000).toISOString(), user.id);
    expect((await api(laptop.agent).get("/api/auth/me")).status).toBe(401);
  });
});

describe("admin access", () => {
  it("requires 2FA and a fresh re-check for admin actions, and admins can't freeze themselves", async () => {
    const { app, ctx } = makeApp({ ADMIN_EMAILS: "boss1@example.com" });
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "boss1@example.com", handle: "boss1", displayName: "Boss", password: PASSWORD });
    expect(reg.body.user.role).toBe("admin");
    const A = api(agent);
    expect((await A.get("/api/admin/overview")).body.error.code).toBe("admin_2fa_required");
    const { secret } = await enable2fa(A);
    expect((await A.get("/api/admin/overview")).status).toBe(200);
    expect((await A.post("/api/settings/2fa/disable", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).body.error.code).toBe("admin_2fa_required");

    const { user: target } = await signup(app, "target");
    expireReauth(ctx, reg.body.user.id);
    expect((await A.post(`/api/admin/users/${target.id}/status`, { status: "frozen" })).body.error.code).toBe("reauth_required");
    expect((await A.post("/api/auth/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
    expect((await A.post(`/api/admin/users/${target.id}/status`, { status: "frozen" })).status).toBe(200);
    expect((await A.post(`/api/admin/users/${reg.body.user.id}/status`, { status: "frozen" })).status).toBe(400);
  });

  it("in production-style setups, an admin email alone grants nothing until the setup code is entered", async () => {
    const { app } = makeApp({ ADMIN_EMAILS: "owner@example.com", ADMIN_SETUP_CODE: "s3tup-c0de-0123456789" });
    const agent = request.agent(app);
    const reg = await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "owner@example.com", handle: "owner", displayName: "Owner", password: PASSWORD });
    expect(reg.body.user.role).toBe("user");
    const A = api(agent);
    expect((await A.get("/api/settings/security")).body.admin.canClaim).toBe(true);
    expect((await A.post("/api/settings/admin/claim", { code: "s3tup-c0de-0123456789" })).body.error.code).toBe("admin_2fa_required");
    await enable2fa(A);
    expect((await A.post("/api/settings/admin/claim", { code: "wrong-code-wrong-code" })).status).toBe(400);
    const claimed = await A.post("/api/settings/admin/claim", { code: "s3tup-c0de-0123456789" });
    expect(claimed.body.user.role).toBe("admin");

    // Someone else can't claim with the code.
    const { agent: other } = await signup(app, "sneaky");
    expect((await api(other).post("/api/settings/admin/claim", { code: "s3tup-c0de-0123456789" })).status).toBe(403);
  });
});

describe("web hardening", () => {
  it("sends strict security headers and never caches API responses", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(res.headers["content-security-policy"]).toMatch(/object-src 'none'/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toMatch(/camera=\(\)/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const txt = await request(app).get("/.well-known/security.txt");
    expect(txt.text).toMatch(/^Contact: /m);
    expect(txt.text).toMatch(/^Expires: /m);
  });

  it("refuses state-changing requests from other sites", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "origin");
    const body = { displayName: "New name" };
    expect((await agent.patch("/api/settings/profile").set("x-aurex-csrf", "1").set("origin", "https://evil.example").send(body)).status).toBe(403);
    expect((await agent.patch("/api/settings/profile").set("x-aurex-csrf", "1").set("sec-fetch-site", "cross-site").send(body)).status).toBe(403);
    expect((await agent.patch("/api/settings/profile").set("origin", "http://localhost:5173").send(body)).status).toBe(403); // no CSRF header
    expect((await agent.patch("/api/settings/profile").set("x-aurex-csrf", "1").set("origin", "http://localhost:5173").send(body)).status).toBe(200);
  });

  it("uses a __Host- cookie in production", async () => {
    const { app } = makeApp({ NODE_ENV: "production", MASTER_KEY: "prod-master-key-0123456789abcdef0123456789", APP_URL: "https://aurex.example", PAYMENT_RAILS: "sandbox" });
    const res = await request(app).post("/api/auth/register").set("x-aurex-csrf", "1").set("origin", "https://aurex.example").send({ email: "p@example.com", handle: "produser", displayName: "P", password: PASSWORD });
    expect(res.status).toBe(201);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-aurex_session=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=63072000; includeSubDomains; preload/);
  });

  it("keeps the M-Pesa callback secret out of logs", () => {
    expect(redactUrl("/api/webhooks/mpesa/abc123def/b2c/result")).toBe("/api/webhooks/mpesa/[redacted]/b2c/result");
  });
});

describe("MASTER_KEY rotation", () => {
  it("re-encrypts stored secrets with the new key at startup", async () => {
    const db = openDb(":memory:");
    const base = { NODE_ENV: "test", DATABASE_PATH: ":memory:", PAYMENT_RAILS: "sandbox", APP_URL: "http://localhost:5173" } as const;
    const oldKey = "old-master-key-0123456789abcdef0123456789";
    const first = createApp(loadConfig({ ...base, MASTER_KEY: oldKey }), db);
    const agent: Agent = request.agent(first.app);
    await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "k@example.com", handle: "keyholder", displayName: "K", password: PASSWORD });
    const setup = await api(agent).post("/api/settings/2fa/setup");
    const before = (db.prepare("SELECT totp_secret_enc FROM users WHERE email = 'k@example.com'").get() as { totp_secret_enc: string }).totp_secret_enc;
    expect(decryptSecret(before, first.ctx.config.masterKey)).toBe(setup.body.secret);

    const second = createApp(loadConfig({ ...base, MASTER_KEY: "new-master-key-0123456789abcdef0123456789", MASTER_KEY_PREVIOUS: oldKey }), db);
    const after = (db.prepare("SELECT totp_secret_enc FROM users WHERE email = 'k@example.com'").get() as { totp_secret_enc: string }).totp_secret_enc;
    expect(after).not.toBe(before);
    expect(decryptSecret(after, second.ctx.config.masterKey)).toBe(setup.body.secret);
    expect(() => decryptSecret(after, first.ctx.config.masterKey)).toThrow();
    expect(encryptSecret("x", second.ctx.config.masterKey)).toMatch(/^v1\./);
  });
});
