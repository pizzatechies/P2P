import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const NEW_PASSWORD = "lantern-orchard-73-copper";

async function setup() {
  const resend = await stub((r) => (r.route === "/emails" ? { body: { id: "email_1" } } : { status: 404, body: {} }));
  const env = makeApp({ RESEND_API_KEY: "re_test", RESEND_BASE_URL: resend.url, APP_URL: "https://aurex.example.com" });
  const anon = (url: string, body: object) => request(env.app).post(url).set("x-aurex-csrf", "1").send(body);
  const resetEmails = () => resend.calls.filter((c) => c.route === "/emails" && c.body.subject === "Reset your Aurex password").map((c) => c.body);
  const settle = () => new Promise((r) => setTimeout(r, 30)); // the email is sent in the background
  const linkToken = (email: { text: string }) => /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(email.text)![1];
  return { env, anon, resetEmails, settle, linkToken };
}

describe("forgot password", () => {
  it("emails a single-use link to a confirmed address, signs every device out and pauses withdrawals", async () => {
    const { env, anon, resetEmails, settle, linkToken } = await setup();
    const u = await signup(env.app, "forgetful");
    const unverified = await signup(env.app, "unconfirmed");
    env.ctx.db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), u.user.id);

    // Same answer whether or not there's an account; nothing is sent for unknown or unconfirmed addresses.
    for (const email of ["nobody@example.com", unverified.user.email]) {
      expect((await anon("/api/auth/password/forgot", { email })).body).toEqual({ sent: true });
    }
    await settle();
    expect(resetEmails()).toHaveLength(0);

    expect((await anon("/api/auth/password/forgot", { email: u.user.email.toUpperCase() })).body).toEqual({ sent: true });
    await settle();
    const [mail] = resetEmails();
    expect(mail.to).toEqual([u.user.email]);
    expect(mail.html).toContain("https://aurex.example.com/reset-password?token=");
    const token = linkToken(mail);
    // Only a hash is stored.
    const row = env.ctx.db.prepare("SELECT token_hash FROM password_resets").get() as { token_hash: string };
    expect(row.token_hash).not.toContain(token);
    // Asking again straight away doesn't send another.
    await anon("/api/auth/password/forgot", { email: u.user.email });
    await settle();
    expect(resetEmails()).toHaveLength(1);

    expect((await anon("/api/auth/password/reset/check", { token })).body).toEqual({ valid: true, twoFactor: false });
    expect((await anon("/api/auth/password/reset/check", { token: "x".repeat(43) })).body.valid).toBe(false);
    expect((await anon("/api/auth/password/reset", { token, password: "password1" })).status).toBe(400); // too weak
    const done = await anon("/api/auth/password/reset", { token, password: NEW_PASSWORD });
    expect(done.status).toBe(200);

    // Every device signed out, the new password works, withdrawals paused, and the link is used up.
    expect((await u.agent.get("/api/auth/me")).status).toBe(401);
    expect((await anon("/api/auth/login", { email: u.user.email, password: "correct-horse-42" })).status).toBe(401);
    expect((await anon("/api/auth/login", { email: u.user.email, password: NEW_PASSWORD })).status).toBe(200);
    const after = env.ctx.db.prepare("SELECT security_hold_until FROM users WHERE id = ?").get(u.user.id) as { security_hold_until: string };
    expect(after.security_hold_until > new Date().toISOString()).toBe(true);
    expect((await anon("/api/auth/password/reset", { token, password: "another-orchard-55-tin" })).body.error.code).toBe("link_invalid");
  });

  it("needs the authenticator too when two-factor is on, and links expire", async () => {
    const { env, anon, resetEmails, settle, linkToken } = await setup();
    const u = await signup(env.app, "careful");
    const A = api(u.agent);
    const s = await A.post("/api/settings/2fa/setup");
    await A.post("/api/settings/2fa/confirm", { code: totp(s.body.secret) });
    env.ctx.db.prepare("UPDATE users SET email_verified_at = ?, totp_last_step = 0 WHERE id = ?").run(new Date().toISOString(), u.user.id);

    await anon("/api/auth/password/forgot", { email: u.user.email });
    await settle();
    const token = linkToken(resetEmails()[0]);
    expect((await anon("/api/auth/password/reset/check", { token })).body).toEqual({ valid: true, twoFactor: true });
    expect((await anon("/api/auth/password/reset", { token, password: NEW_PASSWORD })).body.error.code).toBe("totp_required");
    expect((await anon("/api/auth/password/reset", { token, password: NEW_PASSWORD, code: "000000" })).body.error.code).toBe("totp_invalid");
    const ok = await anon("/api/auth/password/reset", { token, password: NEW_PASSWORD, code: totp(s.body.secret, Date.now() + 30_000) });
    expect(ok.status).toBe(200);

    // An expired link doesn't work.
    env.ctx.db.prepare("UPDATE users SET totp_enabled = 0 WHERE id = ?").run(u.user.id);
    env.ctx.db.prepare("UPDATE password_resets SET sent_at = '2000-01-01T00:00:00.000Z'").run();
    await anon("/api/auth/password/forgot", { email: u.user.email });
    await settle();
    const second = linkToken(resetEmails()[1]);
    env.ctx.db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await anon("/api/auth/password/reset", { token: second, password: "fresh-meadow-62-brass" })).body.error.code).toBe("link_invalid");
  });
});
