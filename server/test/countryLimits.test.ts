import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { limitsFor } from "../src/services/kyc.js";
import { getUserRow } from "../src/services/users.js";
import { api, makeApp, signup } from "./helpers.js";

type Env = ReturnType<typeof makeApp>;
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);

async function makeAdmin(env: Env, name: string) {
  const { agent, user } = await signup(env.app, name);
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

async function verified(env: Env, name: string, country: string) {
  const u = await signup(env.app, name);
  const A = api(u.agent);
  await A.put("/api/account/verification/1", {
    legalName: "Chidi Okafor Nwosu",
    dateOfBirth: "1991-04-05",
    nationality: country,
    phone: "+234 803 000 1111",
    address: { line1: "3 Broad Street", city: "Lagos", country },
    idType: "passport",
    idNumber: "A12345678",
    idCountry: country,
    idExpiry: "2034-01-01",
  });
  for (const kind of ["id_front", "selfie"]) await u.agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());
  expect((await A.post("/api/account/verification/1/submit")).body.currentLevel).toBe(1);
  return { ...u, A };
}

describe("limits by country", () => {
  it("applies a country's own limits to customers verified there, after a second admin approves", async () => {
    const env = makeApp({ KYC_LIMITS: "true", KYC_AUTO_APPROVE: "true" });
    const first = await makeAdmin(env, "ops");
    const second = await makeAdmin(env, "mlro");
    const lagos = await verified(env, "chidi", "NG");
    const nairobi = await verified(env, "wanjiku", "KE");
    expect((await lagos.A.get("/api/account")).body.account.limits).toMatchObject({ txUsd: 2000, dailyUsd: 5000, country: "NG" });

    // Checks on the change itself.
    const put = (body: object) => first.A.put("/api/admin/country-limits", { country: "ng", level: 1, note: "CBN tiered KYC, tier 2", ...body });
    expect((await put({ txUsd: 1000, dailyUsd: null })).status).toBe(400);
    expect((await put({ txUsd: 1000, dailyUsd: 500 })).body.error.message).toMatch(/daily limit/);
    expect((await put({ txUsd: 1000, dailyUsd: 3000, note: "" })).status).toBe(400);

    // Another admin must approve it.
    const asked = await put({ txUsd: 1000, dailyUsd: 3000 });
    expect(asked.status).toBe(202);
    expect(asked.body.request).toMatchObject({ kind: "country_limits", target: null, summary: "level 1 limits in NG to $1,000 per payment and $3,000 a day" });
    expect((await lagos.A.get("/api/account")).body.account.limits.txUsd).toBe(2000);
    expect((await first.A.post(`/api/admin/approvals/${asked.body.request.id}/approve`, {})).status).toBe(403);
    expect((await second.A.post(`/api/admin/approvals/${asked.body.request.id}/approve`, {})).status).toBe(200);

    // Now in effect for customers verified in Nigeria, and nobody else.
    expect((await lagos.A.get("/api/account")).body.account.limits).toMatchObject({ txUsd: 1000, dailyUsd: 3000 });
    expect((await nairobi.A.get("/api/account")).body.account.limits.txUsd).toBe(2000);
    expect((await lagos.A.get("/api/account/verification")).body.levels[1].limits).toEqual({ txUsd: 1000, dailyUsd: 3000 });
    await lagos.A.post("/api/payments/deposits", { rail: "sandbox", amount: "1000", currency: "USD" });
    const big = await lagos.A.post("/api/payments/send", { to: nairobi.user.handle, amount: "1500", currency: "USD" });
    expect(big.status).toBe(422);
    expect((await lagos.A.post("/api/payments/send", { to: nairobi.user.handle, amount: "900", currency: "USD" })).status).toBe(201);

    // The fees page lists it; the admin page shows it with who approved it.
    expect((await request(env.app).get("/api/meta")).body.limits.byCountry).toEqual([{ country: "NG", level: 1, txUsd: 1000, dailyUsd: 3000 }]);
    const admin = (await first.A.get("/api/admin/country-limits")).body;
    expect(admin.countries).toEqual([expect.objectContaining({ country: "NG", level: 1, txUsd: 1000, note: "CBN tiered KYC, tier 2", updatedBy: second.user.handle })]);
    expect(admin.customers).toMatchObject({ NG: 1, KE: 1 });

    // Back to the defaults (also approved by a second admin).
    const back = await put({ txUsd: null, dailyUsd: null, note: "Moved to a licensed partner's limits" });
    await second.A.post(`/api/admin/approvals/${back.body.request.id}/approve`, {});
    expect((await lagos.A.get("/api/account")).body.account.limits.txUsd).toBe(2000);
  });

  it("finds the country of customers verified before limits by country", async () => {
    const env = makeApp({ KYC_LIMITS: "true", KYC_AUTO_APPROVE: "true", TWO_PERSON_APPROVAL: "off" });
    const ops = await makeAdmin(env, "ops");
    const old = await verified(env, "early", "GH");
    env.ctx.db.prepare("UPDATE users SET residence_country = NULL WHERE id = ?").run(old.user.id);
    expect((await ops.A.put("/api/admin/country-limits", { country: "GH", level: 1, txUsd: 700, dailyUsd: 1400, note: "Bank of Ghana tier 1" })).status).toBe(200);
    expect(limitsFor(env.ctx, getUserRow(env.ctx, old.user.id))).toMatchObject({ country: "GH", txUsd: 700 });
    expect((env.ctx.db.prepare("SELECT residence_country FROM users WHERE id = ?").get(old.user.id) as { residence_country: string }).residence_country).toBe("GH");
  });
});
