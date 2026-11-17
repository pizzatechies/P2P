import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { LESSONS, REQUIRED_LESSONS } from "../src/services/learn.js";
import { api, makeApp } from "./helpers.js";
import { stub } from "./stub.js";

const PASSWORD = "correct-horse-42";
let n = 0;

async function register(app: ReturnType<typeof makeApp>["app"], name = "user") {
  n++;
  const agent = request.agent(app);
  const handle = `${name}${n}`.slice(0, 20);
  const res = await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: `${handle}@example.com`, handle, displayName: name, password: PASSWORD });
  expect(res.status).toBe(201);
  return { agent, A: api(agent), res, user: res.body.user as { id: string; handle: string; email: string } };
}

describe("email verification", () => {
  it("emails a code at sign-up and keeps withdrawals and pay-by-email locked until it's entered", async () => {
    const { app, ctx } = makeApp({ REQUIRE_EMAIL_VERIFICATION: "true" });
    const { A, res, user } = await register(app, "verify");
    expect(res.body.user.emailVerified).toBe(false);
    const code = res.body.emailVerification.devCode as string;
    expect(code).toMatch(/^\d{6}$/);

    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const blocked = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("email_unverified");

    // Nobody can find (or pay) an unverified address by email.
    const { A: friend } = await register(app, "friend");
    await friend.post("/api/payments/deposits", { rail: "sandbox", amount: "50", currency: "USD" });
    expect((await friend.post("/api/payments/send", { to: user.email, amount: "5", currency: "USD" })).status).toBe(404);

    expect((await A.post("/api/auth/email/send")).body.error.code).toBe("too_soon");
    expect((await A.post("/api/auth/email/verify", { code: code === "000000" ? "111111" : "000000" })).body.error.code).toBe("code_invalid");
    const ok = await A.post("/api/auth/email/verify", { code });
    expect(ok.body.user.emailVerified).toBe(true);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM email_codes WHERE user_id = ?").get(user.id)).toMatchObject({ n: 0 });

    expect((await friend.post("/api/payments/send", { to: user.email, amount: "5", currency: "USD" })).status).toBe(201);
    expect((await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } })).status).toBe(201);
  });

  it("locks a code after five wrong tries and stores only its hash", async () => {
    const { app, ctx } = makeApp({ REQUIRE_EMAIL_VERIFICATION: "true" });
    const { A, res } = await register(app, "guesser");
    const code = res.body.emailVerification.devCode as string;
    const row = ctx.db.prepare("SELECT code_hash FROM email_codes").get() as { code_hash: string };
    expect(row.code_hash).not.toContain(code);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await A.post("/api/auth/email/verify", { code: wrong });
    expect((await A.post("/api/auth/email/verify", { code })).body.error.code).toBe("too_many_attempts");
  });

  it("sends real emails through Resend, without exposing the code, and emails security alerts", async () => {
    const resend = await stub((r) => (r.route === "/emails" && r.headers.authorization === "Bearer re_test" ? { body: { id: "email_123" } } : { status: 401, body: { message: "bad key" } }));
    const { app } = makeApp({ RESEND_API_KEY: "re_test", RESEND_BASE_URL: resend.url, EMAIL_FROM: "Aurex <no-reply@aurex.example>" });
    const { A, res, user } = await register(app, "mailed");
    expect(res.body.emailVerification.devCode).toBeUndefined();
    const sent = resend.calls.find((c) => c.route === "/emails")!.body;
    expect(sent).toMatchObject({ from: "Aurex <no-reply@aurex.example>", to: [user.email] });
    const code = /(\d{6}) is your Aurex verification code/.exec(sent.subject)![1];
    expect(sent.html).toContain(code);
    expect((await A.post("/api/auth/email/verify", { code })).body.user.emailVerified).toBe(true);

    await A.post("/api/settings/password", { currentPassword: PASSWORD, newPassword: "amber-tractor-91-violin" });
    await new Promise((r) => setTimeout(r, 50));
    const alert = resend.calls.filter((c) => c.route === "/emails").map((c) => c.body).find((b) => b.subject === "Aurex security alert");
    expect(alert?.text).toMatch(/password was changed/);
  });
});

describe("trading academy and demo account", () => {
  it("serves lessons without answers, grades quizzes on the server and tracks practice missions", async () => {
    const { app } = makeApp();
    const { A } = await register(app, "learner");
    const overview = (await A.get("/api/learn")).body;
    expect(overview.lessons).toHaveLength(LESSONS.length);
    expect(JSON.stringify(overview.lessons)).not.toContain('"answer"');
    expect(overview.missions.every((m: { done: boolean }) => !m.done)).toBe(true);

    const lesson = LESSONS[0];
    const allWrong = lesson.quiz.map((q) => (q.answer + 1) % q.options.length);
    const fail = await A.post(`/api/learn/lessons/${lesson.id}/quiz`, { answers: allWrong });
    expect(fail.body.passed).toBe(false);
    expect(fail.body.results[0].explain).toBeTruthy();
    const pass = await A.post(`/api/learn/lessons/${lesson.id}/quiz`, { answers: lesson.quiz.map((q) => q.answer) });
    expect(pass.body).toMatchObject({ passed: true, score: 1 });
    expect((await A.post(`/api/learn/lessons/${lesson.id}/quiz`, { answers: [0] })).status).toBe(400);

    // Practice in the demo account: a buy and a sell complete two missions.
    await A.post("/api/trading/orders", { symbol: "AAPL", side: "buy", type: "market", qty: 2 });
    await A.post("/api/trading/orders", { symbol: "AAPL", side: "sell", type: "market", qty: 1 });
    const after = (await A.get("/api/learn")).body;
    const done = after.missions.filter((m: { done: boolean }) => m.done).map((m: { id: string }) => m.id);
    expect(done).toEqual(expect.arrayContaining(["first-buy", "first-sell"]));
    expect(after.demoTrades).toBe(2);
    expect(after.progress).toBeGreaterThan(0);
  });

  it("restarts the demo account with the balance the user picks", async () => {
    const { app } = makeApp();
    const { A } = await register(app, "resetter");
    await A.post("/api/trading/orders", { symbol: "MSFT", side: "buy", type: "market", qty: 1 });
    expect((await A.post("/api/trading/account/reset", { startingCash: 500 })).status).toBe(400);
    const reset = await A.post("/api/trading/account/reset", { startingCash: 5000 });
    expect(reset.body.settings).toMatchObject({ accountType: "demo", demoStartingCash: 5000 });
    const account = (await A.get("/api/trading/account")).body.account;
    expect(account.cash).toBe(5000);
    expect(account.positions).toHaveLength(0);
  });
});

describe("upgrading to a real account", () => {
  const application = {
    legalName: "Ada Mensah",
    dateOfBirth: "1990-04-12",
    country: "GH",
    employment: "employed",
    annualIncome: "50k_100k",
    liquidNetWorth: "10k_50k",
    sourceOfFunds: "salary",
    experience: "under_1y",
    objective: "growth",
    riskTolerance: "medium",
    timeHorizon: "over_5y",
  };
  const ack = { riskOfLoss: true, notAdvice: true, ownAccount: true, accurate: true };

  async function readyUser(app: ReturnType<typeof makeApp>["app"], ctx: ReturnType<typeof makeApp>["ctx"]) {
    const { A, res, user } = await register(app, "upgrader");
    // Identity verification has its own suite; here it's simply marked done.
    ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(user.id);
    await A.post("/api/auth/email/verify", { code: res.body.emailVerification.devCode });
    const setup = await A.post("/api/settings/2fa/setup");
    await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
    for (const l of LESSONS) await A.post(`/api/learn/lessons/${l.id}/quiz`, { answers: l.quiz.map((q) => q.answer) });
    for (const s of ["AAPL", "MSFT", "NVDA"]) await A.post("/api/trading/orders", { symbol: s, side: "buy", type: "market", qty: 1 });
    return { A, user, secret: setup.body.secret as string };
  }

  it("needs the checklist, keeps personal details encrypted, and goes to an admin for approval", async () => {
    const { app, ctx } = makeApp({ REQUIRE_EMAIL_VERIFICATION: "true", ADMIN_EMAILS: "chief@example.com" });
    const { A: fresh } = await register(app, "eager");
    const start = (await fresh.get("/api/trading/upgrade")).body;
    expect(start.status).toBe("none");
    expect(start.checklist.every((c: { done: boolean }) => !c.done)).toBe(true);
    expect((await fresh.put("/api/trading/upgrade", { ...application, dateOfBirth: "2015-01-01" })).body.error.code).toBe("underage");
    await fresh.put("/api/trading/upgrade", application);
    expect((await fresh.post("/api/trading/upgrade/submit", ack)).body.error.code).toBe("checklist_incomplete");

    const { A, user } = await readyUser(app, ctx);
    const saved = await A.put("/api/trading/upgrade", application);
    expect(saved.body.status).toBe("draft");
    expect(saved.body.checklist.every((c: { done: boolean }) => c.done)).toBe(true);
    const stored = ctx.db.prepare("SELECT data_enc FROM live_applications WHERE user_id = ?").get(user.id) as { data_enc: string };
    expect(stored.data_enc).toMatch(/^v1\./);
    expect(stored.data_enc).not.toContain("Ada");

    expect((await A.post("/api/trading/upgrade/submit", { ...ack, notAdvice: false })).body.error.code).toBe("acknowledgement_required");
    const submitted = await A.post("/api/trading/upgrade/submit", ack);
    expect(submitted.body.status).toBe("submitted");

    // Live brokerage keys stay locked until approval.
    const settings = (await A.get("/api/trading/account")).body.settings;
    expect(settings.realAccountApproved).toBe(false);

    // An admin (with 2FA) reviews it.
    const { A: admin, res: adminRes } = await register(app, "chief");
    expect(adminRes.body.user.email).toBeDefined();
    ctx.db.prepare("UPDATE users SET email = 'chief@example.com', role = 'admin' WHERE id = ?").run(adminRes.body.user.id);
    const s2 = await admin.post("/api/settings/2fa/setup");
    await admin.post("/api/settings/2fa/confirm", { code: totp(s2.body.secret) });
    const queue = (await admin.get("/api/admin/upgrades")).body.applications;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ legalName: "Ada Mensah", country: "GH", twoFactor: true, emailVerified: true, lessonsPassed: REQUIRED_LESSONS.length, demoTrades: 3 });
    const approved = await admin.post(`/api/admin/upgrades/${user.id}/review`, { decision: "approve", note: "Welcome" });
    expect(approved.status).toBe(200);
    const done = (await A.get("/api/trading/upgrade")).body;
    expect(done.status).toBe("approved");
    expect((await A.get("/api/trading/account")).body.settings.realAccountApproved).toBe(true);
    expect((await A.put("/api/trading/upgrade", application)).body.error.code).toBe("already_approved");
  });

  it("warns about risky answers, requires that the warnings are acknowledged, and can auto-approve", async () => {
    const { app, ctx } = makeApp({ REQUIRE_EMAIL_VERIFICATION: "true", LIVE_UPGRADE_AUTO_APPROVE: "true" });
    const { A } = await readyUser(app, ctx);
    const risky = { ...application, experience: "none", objective: "speculation", liquidNetWorth: "under_10k" };
    const saved = (await A.put("/api/trading/upgrade", risky)).body;
    expect(saved.assessment.result).toBe("warning");
    expect(saved.assessment.warnings.length).toBeGreaterThanOrEqual(2);
    expect((await A.post("/api/trading/upgrade/submit", ack)).body.error.code).toBe("acknowledgement_required");
    const res = await A.post("/api/trading/upgrade/submit", { ...ack, understandsWarnings: true });
    expect(res.body.status).toBe("approved");
  });

  it("won't trade a live brokerage account before approval, and stops if approval is revoked", async () => {
    const { saveUserKey } = await import("../src/services/keys.js");
    const { app, ctx } = makeApp({ ALLOW_LIVE_TRADING: "true", ADMIN_EMAILS: "boss9@example.com" });
    const { A, user } = await register(app, "golive");
    saveUserKey(ctx, user.id, "alpaca", JSON.stringify({ keyId: "LIVEKEY", secretKey: "secret" }), { env: "live" });
    const refused = await A.put("/api/trading/broker", { broker: "alpaca" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("upgrade_required");

    // Approved: switching works. Revoked: the account falls back to demo on the next request.
    const now = new Date().toISOString();
    ctx.db.prepare("INSERT INTO live_applications (user_id, status, created_at, updated_at) VALUES (?, 'approved', ?, ?)").run(user.id, now, now);
    expect((await A.put("/api/trading/broker", { broker: "alpaca" })).status).toBe(200);
    ctx.db.prepare("UPDATE live_applications SET status = 'rejected' WHERE user_id = ?").run(user.id);
    const { brokerFor } = await import("../src/services/trading/index.js");
    brokerFor(ctx, user.id);
    expect((ctx.db.prepare("SELECT broker FROM trading_accounts WHERE user_id = ?").get(user.id) as { broker: string }).broker).toBe("paper");
  });
});
