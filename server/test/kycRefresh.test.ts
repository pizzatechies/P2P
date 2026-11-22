import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { refreshStatus, sendRefreshReminders } from "../src/services/kycRefresh.js";
import { api, makeApp, signup } from "./helpers.js";

type Env = ReturnType<typeof makeApp>;
const DAY = 86_400_000;
const jpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, fill)]);
const details = (idExpiry = "2034-01-01") => ({
  legalName: "Grace Wambui Njoroge",
  dateOfBirth: "1990-02-03",
  nationality: "KE",
  phone: "+254 712 000 111",
  address: { line1: "12 Moi Avenue", city: "Nairobi", country: "KE" },
  idType: "passport",
  idNumber: "AK7654321",
  idCountry: "KE",
  idExpiry,
});

async function verify(agent: ReturnType<typeof request.agent>, body = details()) {
  const A = api(agent);
  const saved = await A.put("/api/account/verification/1", body);
  if (saved.status !== 200) return saved;
  for (const kind of ["id_front", "selfie"]) await agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());
  return A.post("/api/account/verification/1/submit");
}

/** Moves a customer's approval back in time. */
const approvedAgo = (env: Env, userId: string, days: number) =>
  env.ctx.db.prepare("UPDATE kyc_submissions SET reviewed_at = ? WHERE user_id = ? AND status = 'approved'").run(new Date(Date.now() - days * DAY).toISOString(), userId);

async function makeAdmin(env: Env) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

describe("keeping identity details current", () => {
  it("reminds, then pauses sending and withdrawing until the customer re-verifies with fresh photos", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const grace = await signup(env.app, "grace");
    const G = api(grace.agent);
    expect((await verify(grace.agent)).body.currentLevel).toBe(1);
    await G.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const friend = await signup(env.app, "friend");
    const F = api(friend.agent);
    await F.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    expect((await G.get("/api/account/verification")).body.refresh.state).toBe("ok");

    // Three years on, less ten days: a reminder, once.
    approvedAgo(env, grace.user.id, 3 * 365 - 10);
    expect(refreshStatus(env.ctx, grace.user.id)).toMatchObject({ state: "soon", reason: "periodic" });
    expect((await sendRefreshReminders(env.ctx)).reminded).toBe(1);
    expect((await sendRefreshReminders(env.ctx)).reminded).toBe(0);
    expect((await G.get("/api/settings/security")).body.alerts[0].message).toMatch(/time to update your identity details/);

    // Past the due date: still allowed during the grace period; another reminder.
    approvedAgo(env, grace.user.id, 3 * 366 + 5);
    expect(refreshStatus(env.ctx, grace.user.id).state).toBe("due");
    expect((await sendRefreshReminders(env.ctx)).reminded).toBe(1);
    expect((await G.post("/api/payments/send", { to: friend.user.handle, amount: "1", currency: "USD" })).status).toBe(201);

    // After the grace period: sending and withdrawing pause; receiving still works.
    approvedAgo(env, grace.user.id, 3 * 366 + 40);
    const blocked = await G.post("/api/payments/send", { to: friend.user.handle, amount: "1", currency: "USD" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("identity_refresh_required");
    expect((await G.post("/api/payments/withdrawals", { rail: "sandbox", amount: "5", currency: "USD", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } })).body.error.code).toBe("identity_refresh_required");
    expect((await F.post("/api/payments/send", { to: grace.user.handle, amount: "2", currency: "USD" })).status).toBe(201);
    expect((await admin.get("/api/admin/kyc/refresh")).body.customers).toEqual([expect.objectContaining({ handle: grace.user.handle, status: expect.objectContaining({ state: "restricted" }) })]);

    // Re-verifying: the old photos don't count.
    env.ctx.config.KYC_AUTO_APPROVE = false;
    expect((await G.put("/api/account/verification/1", details("2035-06-30"))).status).toBe(200);
    expect((await G.get("/api/account/verification")).body.identity.documents.every((d: { uploaded: boolean }) => !d.uploaded)).toBe(true);
    expect((await G.post("/api/account/verification/1/submit")).body.error.code).toBe("documents_missing");
    for (const kind of ["id_front", "selfie"]) await grace.agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg(9));
    expect((await G.post("/api/account/verification/1/submit")).status).toBe(200);
    // While a person reviews it, nothing's held against them.
    expect(refreshStatus(env.ctx, grace.user.id).state).toBe("in_review");
    expect((await G.post("/api/payments/send", { to: friend.user.handle, amount: "1", currency: "USD" })).status).toBe(201);
    const queue = (await admin.get("/api/admin/kyc")).body.submissions;
    await admin.post(`/api/admin/kyc/${queue[0].id}/review`, { decision: "approve" });
    expect(refreshStatus(env.ctx, grace.user.id).state).toBe("ok");
    expect((await G.get("/api/settings/security")).body.alerts[0].message).toMatch(/updated identity details were approved/);
    expect((await G.get("/api/account/verification")).body.currentLevel).toBe(1);
  });

  it("asks sooner when the ID expires first, and every year for higher-risk customers", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true" });
    const soon = await signup(env.app, "expiring");
    const inTwentyDays = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    await verify(soon.agent, details(inTwentyDays));
    expect(refreshStatus(env.ctx, soon.user.id)).toMatchObject({ state: "soon", reason: "id_expired", dueAt: `${inTwentyDays}T00:00:00.000Z` });
    // A customer already verified can't resubmit until they're due.
    const fine = await signup(env.app, "fine");
    await verify(fine.agent);
    expect((await api(fine.agent).put("/api/account/verification/1", details())).body.error.code).toBe("already_verified");

    // A confirmed politically exposed person: yearly.
    env.ctx.db.prepare("UPDATE users SET pep_confirmed_at = ? WHERE id = ?").run(new Date().toISOString(), fine.user.id);
    approvedAgo(env, fine.user.id, 370);
    expect(refreshStatus(env.ctx, fine.user.id)).toMatchObject({ state: "due", highRisk: true });
  });

  it("can be switched off (KYC_REFRESH_YEARS=0)", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true", KYC_REFRESH_YEARS: "0" });
    const u = await signup(env.app, "anyone");
    await verify(u.agent);
    approvedAgo(env, u.user.id, 10 * 365);
    expect(refreshStatus(env.ctx, u.user.id).state).toBe("ok");
  });
});
