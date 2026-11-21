import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
import { stub } from "./stub.js";

const post = (app: ReturnType<typeof makeApp>["app"], url: string, body: object) => request(app).post(url).set("x-aurex-csrf", "1").send(body);

describe("bot protection (Turnstile)", () => {
  it("is off by default: no widget, no extra CSP, sign-up works without a token", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/meta")).body.captcha).toBeNull();
    const res = await post(app, "/api/auth/register", { email: "plain@example.com", handle: "plain1", displayName: "Plain", password: "correct-horse-42" });
    expect(res.status).toBe(201);
    expect(res.headers["content-security-policy"]).not.toContain("challenges.cloudflare.com");
  });

  it("checks a fresh token with Cloudflare on sign-up, sign-in, password reset and the waitlist", async () => {
    const cf = await stub((r) => (r.route === "/siteverify" ? { body: r.body.secret === "cf-secret" && r.body.response === "good-token" ? { success: true, hostname: "localhost" } : { success: false, "error-codes": ["invalid-input-response"] } } : { status: 404, body: {} }));
    const { app } = makeApp({ TURNSTILE_SITE_KEY: "cf-site", TURNSTILE_SECRET_KEY: "cf-secret", TURNSTILE_VERIFY_URL: `${cf.url}/siteverify`, REGISTRATION_MODE: "open" });
    expect((await request(app).get("/api/meta")).body.captcha).toEqual({ provider: "turnstile", siteKey: "cf-site" });

    const signupBody = { email: "human@example.com", handle: "human1", displayName: "Human", password: "correct-horse-42" };
    expect((await post(app, "/api/auth/register", signupBody)).body.error.code).toBe("captcha_required");
    expect((await post(app, "/api/auth/register", { ...signupBody, captchaToken: "bot-token" })).body.error.code).toBe("captcha_failed");
    const ok = await post(app, "/api/auth/register", { ...signupBody, captchaToken: "good-token" });
    expect(ok.status).toBe(201);
    // The widget's script and frame are allowed only now.
    expect(ok.headers["content-security-policy"]).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    expect(ok.headers["content-security-policy"]).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
    // The secret, the token and the visitor's address went to Cloudflare.
    expect(cf.calls.at(-1)!.body).toMatchObject({ secret: "cf-secret", response: "good-token" });

    expect((await post(app, "/api/auth/login", { email: "human@example.com", password: "correct-horse-42" })).body.error.code).toBe("captcha_required");
    expect((await post(app, "/api/auth/login", { email: "human@example.com", password: "correct-horse-42", captchaToken: "good-token" })).status).toBe(200);
    expect((await post(app, "/api/auth/password/forgot", { email: "human@example.com" })).body.error.code).toBe("captcha_required");
    expect((await post(app, "/api/public/waitlist", { email: "later@example.com" })).body.error.code).toBe("captcha_required");
  });

  it("fails closed when Cloudflare can't be reached", async () => {
    const { app } = makeApp({ TURNSTILE_SITE_KEY: "cf-site", TURNSTILE_SECRET_KEY: "cf-secret", TURNSTILE_VERIFY_URL: "http://127.0.0.1:9/siteverify" });
    const res = await post(app, "/api/auth/register", { email: "x@example.com", handle: "xx1", displayName: "X", password: "correct-horse-42", captchaToken: "anything" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("captcha_unavailable");
  });
});
