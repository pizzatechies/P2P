import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { verifyLedger } from "../src/services/ledger.js";
import { invalidateIndex } from "../src/services/sanctions.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;

async function makeAdmin(env: App) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

const shop = { businessName: "Mama Njeri Groceries", category: "retail", registrationNumber: "BN-2026-0042", country: "KE", website: "" };

describe("business accounts", () => {
  it("are applied for by verified customers, reviewed, and then keep a fee on payments received", async () => {
    const env = makeApp({ MERCHANT_FEE_BPS: "150", P2P_FEE_BPS: "0" });
    const admin = await makeAdmin(env);
    const owner = await signup(env.app, "njeri");
    const O = api(owner.agent);
    // Identity first.
    expect((await O.put("/api/account/business", shop)).body.error.code).toBe("identity_first");
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(owner.user.id);
    expect((await O.put("/api/account/business", { ...shop, category: "weapons" })).status).toBe(400);
    const applied = await O.put("/api/account/business", shop);
    expect(applied.body.profile).toMatchObject({ businessName: "Mama Njeri Groceries", status: "pending" });

    // A payment before approval is an ordinary one: no fee.
    const buyer = await signup(env.app, "buyer");
    const B = api(buyer.agent);
    await B.post("/api/payments/deposits", { rail: "sandbox", amount: "300", currency: "USD" });
    await B.post("/api/payments/send", { to: owner.user.handle, amount: "100", currency: "USD" });
    const bal = async () => (await O.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD").balance;
    expect(await bal()).toBe("100.00");

    const queue = (await admin.get("/api/admin/businesses")).body.applications;
    expect(queue).toEqual([expect.objectContaining({ businessName: "Mama Njeri Groceries", status: "pending", user: expect.objectContaining({ handle: owner.user.handle }) })]);
    expect((await admin.post(`/api/admin/businesses/${owner.user.id}/review`, { decision: "reject" })).status).toBe(400);
    expect((await admin.post(`/api/admin/businesses/${owner.user.id}/review`, { decision: "approve" })).status).toBe(200);

    // Now 1.5% is kept from what the business receives; the buyer pays exactly the price.
    const before = (await B.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD").balance;
    expect((await B.post("/api/payments/send", { to: owner.user.handle, amount: "100", currency: "USD", memo: "groceries" })).status).toBe(201);
    expect((await B.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD").balance).toBe((Number(before) - 100).toFixed(2));
    expect(await bal()).toBe("198.50");
    const fees = env.ctx.db.prepare("SELECT balance FROM accounts WHERE owner_type = 'system' AND code = 'fees' AND currency = 'USD'").get() as { balance: number };
    expect(fees.balance).toBe(150);
    expect(verifyLedger(env.ctx).ok).toBe(true);

    // The business sees what it received, and its pay page shows the business name.
    const overview = (await O.get("/api/account/business")).body;
    expect(overview).toMatchObject({ feeBps: 150, profile: { status: "approved" } });
    expect(overview.received.day[0]).toMatchObject({ currency: "USD", received: "198.50", fees: "1.50", payments: 2 });
    const pub = await request(env.app).get(`/api/public/users/@${owner.user.handle}`);
    expect(pub.body.user.business).toEqual({ name: "Mama Njeri Groceries" });
  });

  it("can't be self-approved, and business names are screened against sanctions lists", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const adminRow = env.ctx.db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: string };
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(adminRow.id);
    await admin.put("/api/account/business", shop);
    expect((await admin.post(`/api/admin/businesses/${adminRow.id}/review`, { decision: "approve" })).status).toBe(403);

    // A listed company name opens a sanctions alert.
    env.ctx.db.prepare("INSERT INTO sanctions_entries (list, ref, kind, name, aliases, birth_years, programs, countries) VALUES ('ofac', '306', 'entity', 'BANCO NACIONAL DE CUBA', '[]', '[]', 'CUBA', '[]')").run();
    invalidateIndex(env.ctx);
    const o = await signup(env.app, "bank");
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(o.user.id);
    await api(o.agent).put("/api/account/business", { ...shop, businessName: "Banco Nacional de Cuba" });
    const alert = env.ctx.db.prepare("SELECT rule, summary FROM compliance_alerts WHERE user_id = ?").get(o.user.id) as { rule: string; summary: string };
    expect(alert.rule).toBe("sanctions_match");
    expect(alert.summary).toMatch(/Business name/);
  });
});
