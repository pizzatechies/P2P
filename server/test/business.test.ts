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

  it("needs directors, owners and documents from a registered company, and screens each person", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const o = await signup(env.app, "founder");
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(o.user.id);
    const O = api(o.agent);
    const company = { businessName: "Savanna Logistics Ltd", businessType: "company", category: "transport", registrationNumber: "PVT-2026-7781", country: "KE", website: "" };
    const founder = { name: "Achieng Odhiambo", role: "director_owner", ownershipPct: 60, dateOfBirth: "1985-03-02", nationality: "KE", isApplicant: true };

    expect((await O.put("/api/account/business", { ...company, registrationNumber: "" })).body.error.message).toMatch(/registration number/);
    expect((await O.put("/api/account/business", { ...company, people: [] })).body.error.message).toMatch(/directors/);
    expect((await O.put("/api/account/business", { ...company, people: [{ ...founder, role: "owner" }] })).body.error.message).toMatch(/at least one director/);
    expect((await O.put("/api/account/business", { ...company, people: [founder, { ...founder, name: "Otieno Kamau", ownershipPct: 50 }] })).body.error.message).toMatch(/more than 100%/);
    expect((await O.put("/api/account/business", { ...company, people: [{ ...founder, ownershipPct: 10 }] })).body.error.message).toMatch(/25% or more/);
    // Documents come first.
    expect((await O.put("/api/account/business", { ...company, people: [founder] })).body.error.code).toBe("documents_missing");

    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 32)]);
    const up = (kind: string, body: Buffer) => o.agent.post(`/api/account/business/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "application/pdf").send(body);
    expect((await up("registration", Buffer.alloc(2048, 7))).status).toBe(400); // not a real PDF or photo
    expect((await up("registration", pdf)).status).toBe(201);
    expect((await up("ownership", pdf)).status).toBe(201);

    const applied = await O.put("/api/account/business", { ...company, people: [founder] });
    expect(applied.status).toBe(200);
    expect(applied.body.profile).toMatchObject({ businessType: "company", people: [expect.objectContaining({ name: "Achieng Odhiambo" })], status: "pending" });
    // People are encrypted at rest; documents too.
    const row = env.ctx.db.prepare("SELECT people_enc FROM business_profiles WHERE user_id = ?").get(o.user.id) as { people_enc: string };
    expect(row.people_enc).not.toContain("Achieng");
    const docRow = env.ctx.db.prepare("SELECT data_enc FROM business_documents LIMIT 1").get() as { data_enc: string };
    expect(docRow.data_enc).not.toContain("JVBERi"); // base64 of "%PDF"

    // The reviewer sees the people and can open the documents (audited); others can't.
    const app = (await admin.get("/api/admin/businesses")).body.applications[0];
    expect(app.people).toHaveLength(1);
    expect(app.documents.map((d: { kind: string }) => d.kind).sort()).toEqual(["ownership", "registration"]);
    const opened = await admin.get(`/api/admin/businesses/documents/${app.documents[0].id}`);
    expect(opened.status).toBe(200);
    expect(opened.headers["content-type"]).toBe("application/pdf");
    const stranger = await signup(env.app, "stranger");
    expect((await api(stranger.agent).get(`/api/account/business/documents/${app.documents[0].id}`)).status).toBe(404);
    // While under review, nothing more can be uploaded.
    expect((await up("other", pdf)).body.error.code).toBe("under_review");
  });

  it("screens company directors and owners against sanctions lists, with their year of birth", async () => {
    const env = makeApp();
    env.ctx.db.prepare("INSERT INTO sanctions_entries (list, ref, kind, name, aliases, birth_years, programs, countries) VALUES ('un', 'QDi.999', 'individual', 'JOHN TESTPERSON MWANGI', '[]', '[1970]', 'TEST', '[]')").run();
    invalidateIndex(env.ctx);
    const o = await signup(env.app, "boardco");
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(o.user.id);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 32)]);
    for (const kind of ["registration", "ownership"]) await o.agent.post(`/api/account/business/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "application/pdf").send(pdf);
    await api(o.agent).put("/api/account/business", {
      businessName: "Clean Trading Ltd",
      businessType: "company",
      category: "retail",
      registrationNumber: "C-1",
      country: "KE",
      people: [
        { name: "Mary Wanjiru", role: "director", ownershipPct: null, dateOfBirth: "1990-01-01", nationality: "KE", email: "mary@example.com" },
        { name: "John Testperson Mwangi", role: "owner", ownershipPct: 40, dateOfBirth: "1970-06-06", nationality: "KE", email: "john@example.com" },
      ],
    });
    const alert = env.ctx.db.prepare("SELECT summary FROM compliance_alerts WHERE user_id = ? AND rule = 'sanctions_match'").get(o.user.id) as { summary: string };
    expect(alert.summary).toMatch(/Company director or owner resembles "JOHN TESTPERSON MWANGI"/);
  });
});
