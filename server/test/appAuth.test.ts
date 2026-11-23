import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeApp, signup } from "./helpers.js";

const IOS = "capacitor://localhost";
const ANDROID = "https://localhost";

describe("signing in from the mobile apps", () => {
  it("gives the apps a token instead of a cookie, and accepts it as a bearer token", async () => {
    const env = makeApp();
    const { user } = await signup(env.app, "amara");

    const login = await request(env.app)
      .post("/api/auth/login")
      .set("Origin", IOS)
      .set("Sec-Fetch-Site", "cross-site")
      .set("x-aurex-csrf", "1")
      .send({ email: user.email, password: "correct-horse-42" });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(login.headers["access-control-allow-origin"]).toBe(IOS);
    expect(login.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(login.body.token).toMatch(/^[A-Za-z0-9_-]{20,100}$/);
    const auth = { Authorization: `Bearer ${login.body.token}`, Origin: IOS };

    const me = await request(env.app).get("/api/auth/me").set(auth);
    expect(me.body.user.handle).toBe(user.handle);
    // State-changing calls work across origins with the token (and the CSRF header).
    const dep = await request(env.app).post("/api/payments/deposits").set(auth).set("Sec-Fetch-Site", "cross-site").set("x-aurex-csrf", "1").send({ rail: "sandbox", amount: "10", currency: "USD" });
    expect(dep.status).toBe(201);

    // Signing out ends the session.
    await request(env.app).post("/api/auth/logout").set(auth).set("x-aurex-csrf", "1").send({});
    expect((await request(env.app).get("/api/auth/me").set(auth)).status).toBe(401);
  });

  it("answers the app's preflight, registers with a token, and never hands tokens to web pages", async () => {
    const env = makeApp();
    const pre = await request(env.app).options("/api/auth/login").set("Origin", ANDROID).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,x-aurex-csrf,authorization");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(ANDROID);
    expect(pre.headers["access-control-allow-headers"]).toMatch(/Authorization/);
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    // Other origins get no CORS approval.
    const evil = await request(env.app).options("/api/auth/login").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const reg = await request(env.app)
      .post("/api/auth/register")
      .set("Origin", ANDROID)
      .set("x-aurex-csrf", "1")
      .send({ email: "zola@example.com", handle: "zola", displayName: "Zola Phiri", password: "correct-horse-42" });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeTruthy();
    expect(reg.headers["set-cookie"]).toBeUndefined();

    // A browser on the website gets a cookie and no token, as before.
    const web = await request(env.app).post("/api/auth/login").set("Origin", "http://localhost:5173").set("x-aurex-csrf", "1").send({ email: "zola@example.com", password: "correct-horse-42" });
    expect(web.body.token).toBeUndefined();
    expect(String(web.headers["set-cookie"])).toMatch(/aurex_session=/);
    // Cross-site pages are still refused.
    const forged = await request(env.app).post("/api/auth/login").set("Origin", "https://evil.example").set("Sec-Fetch-Site", "cross-site").set("x-aurex-csrf", "1").send({ email: "zola@example.com", password: "correct-horse-42" });
    expect(forged.status).toBe(403);
    // Still needs the CSRF header, like every state-changing call.
    expect((await request(env.app).post("/api/auth/login").set("Origin", IOS).send({ email: "zola@example.com", password: "correct-horse-42" })).status).toBe(403);
  });

  it("treats the app origins like any other site when the apps are switched off (APP_ORIGINS empty)", async () => {
    const env = makeApp({ APP_ORIGINS: "", NODE_ENV: "production", APP_URL: "https://aurex.example.com", MASTER_KEY: "x".repeat(40) });
    const r = await request(env.app).post("/api/auth/login").set("Origin", IOS).set("x-aurex-csrf", "1").send({ email: "a@example.com", password: "whatever-password" });
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
