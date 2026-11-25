import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { encryptSecret, totp } from "../src/lib/crypto.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub, type Recorded } from "./stub.js";

const PARTNER = "2345";
const KEY = "smile-test-api-key";
const sign = (timestamp: string) => createHmac("sha256", KEY).update(timestamp + PARTNER + "sid_request").digest("base64");

async function smileStub() {
  let jobs = 0;
  return stub((req: Recorded) => {
    if (req.route === "/v3/token") return { body: { token: "jwt-token" } };
    if (req.route === "/v3/services/supported_id_types") {
      return req.query.get("country") === "KE"
        ? { body: { id_types: [{ country: "KE", type: "NATIONAL_ID", label: "National ID", regex: "^[0-9]{1,9}$" }, { country: "KE", type: "PASSPORT", label: "Passport" }] } }
        : { body: { id_types: [] } };
    }
    if (req.route === "/v3/enhanced_kyc" && req.method === "POST") return { status: 202, body: { status: "accepted", job_id: `job_${++jobs}` } };
    return undefined;
  });
}

async function makeAdmin(env: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 32)]);
const jpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, fill)]);
const company = { businessName: "Savanna Logistics Ltd", businessType: "company", category: "transport", registrationNumber: "PVT-2026-7781", country: "KE", website: "" };
const founder = { name: "Achieng Odhiambo", role: "director_owner", ownershipPct: 60, dateOfBirth: "1985-03-02", nationality: "KE", isApplicant: true };
const director = { name: "Otieno Kamau", role: "director", ownershipPct: null, dateOfBirth: "1979-11-20", nationality: "KE", email: "otieno@example.com" };
const investor = { name: "Amina Hassan", role: "owner", ownershipPct: 30, dateOfBirth: "1988-05-09", nationality: "KE", email: "amina@example.com" };

async function companyOwner(env: ReturnType<typeof makeApp>) {
  const o = await signup(env.app, "founder");
  env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(o.user.id);
  for (const kind of ["registration", "ownership"]) await o.agent.post(`/api/account/business/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "application/pdf").send(pdf);
  return { ...o, O: api(o.agent) };
}

const tokenOf = (link: string) => link.split("/verify-person/")[1];
const person = (app: ReturnType<typeof makeApp>["app"], token: string) => {
  const a = request.agent(app);
  return {
    view: () => a.get(`/api/public/kyb-person/${token}`),
    details: (body: object) => a.put(`/api/public/kyb-person/${token}/details`).set("x-aurex-csrf", "1").send(body),
    upload: (kind: string, body = jpeg()) => a.post(`/api/public/kyb-person/${token}/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(body),
    submit: () => a.post(`/api/public/kyb-person/${token}/submit`).set("x-aurex-csrf", "1").send({}),
  };
};

describe("identity checks for company directors and owners", () => {
  it("sends each person other than the applicant a private link, and holds approval until they've all confirmed", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, APP_URL: "https://aurex.example.com" });
    const admin = await makeAdmin(env);
    const { O, user } = await companyOwner(env);

    // Everyone but the applicant needs their own email; only one person can be the applicant.
    expect((await O.put("/api/account/business", { ...company, people: [founder, { ...director, email: "" }] })).body.error.message).toMatch(/Otieno Kamau's email/);
    expect((await O.put("/api/account/business", { ...company, people: [founder, { ...director, email: user.email.toUpperCase() }] })).body.error.message).toMatch(/own email/);
    expect((await O.put("/api/account/business", { ...company, people: [founder, { ...director, isApplicant: true }] })).body.error.message).toMatch(/Only one person/);

    const applied = await O.put("/api/account/business", { ...company, people: [founder, director, investor] });
    expect(applied.status).toBe(200);
    expect(applied.body.invites.map((i: { name: string; emailed: boolean }) => `${i.name}:${i.emailed}`)).toEqual(["Otieno Kamau:true", "Amina Hassan:true"]);
    expect(applied.body.invites[0].link).toMatch(/^https:\/\/aurex\.example\.com\/verify-person\/[A-Za-z0-9_-]{43}$/);
    const [otienoKey, aminaKey] = applied.body.invites.map((i: { key: string }) => i.key);
    expect(applied.body.personChecks[otienoKey]).toMatchObject({ status: "waiting" });

    // Approval waits for both.
    const early = await admin.post(`/api/admin/businesses/${user.id}/review`, { decision: "approve" });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/Otieno Kamau, Amina Hassan/);

    // Otieno opens his link: he sees who asked, agrees, gives his ID and photos, and sends it.
    const otieno = person(env.app, tokenOf(applied.body.invites[0].link));
    expect((await otieno.view()).body).toMatchObject({ businessName: "Savanna Logistics Ltd", name: "Otieno Kamau", role: "director", detailsSaved: false, needed: ["id_front", "id_back", "selfie"] });
    const details = { dateOfBirth: "1979-11-20", nationality: "KE", idType: "national_id", idNumber: "12345678", idCountry: "KE", idExpiry: "2033-01-01", phone: "+254 700 000 001" };
    expect((await otieno.details({ ...details, consent: false })).status).toBe(400);
    expect((await otieno.details({ ...details, idExpiry: "2020-01-01", consent: true })).body.error.message).toMatch(/expired/);
    const { idExpiry: _expiry, ...withoutExpiry } = details;
    expect((await otieno.details({ ...withoutExpiry, consent: true })).body.detailsSaved).toBe(true);
    expect((await otieno.details({ ...details, consent: true })).body.detailsSaved).toBe(true);
    expect((await otieno.submit()).body.error.code).toBe("documents_missing");
    expect((await otieno.upload("id_front", pdf)).status).toBe(400); // photos only
    for (const k of ["id_front", "id_back", "selfie"]) expect((await otieno.upload(k)).status).toBe(201);
    expect((await otieno.submit()).body).toEqual({ done: true, businessName: "Savanna Logistics Ltd" });
    // The link is spent.
    expect((await otieno.view()).status).toBe(404);
    expect((await O.get("/api/account/business")).body.personChecks[otienoKey].status).toBe("done");
    expect((await O.get("/api/settings/security")).body.alerts[0].message).toMatch(/Otieno Kamau has confirmed/);

    // His ID number went to Smile ID, bound to his check; details and photos are encrypted at rest.
    const sent = smile.calls.find((r) => r.route === "/v3/enhanced_kyc")!;
    const check = env.ctx.db.prepare("SELECT id, data_enc FROM business_person_checks WHERE person_key = ?").get(otienoKey) as { id: string; data_enc: string };
    expect(sent.body).toMatchObject({ country: "KE", id_type: "NATIONAL_ID", id_number: "12345678", user_id: check.id });
    const params = JSON.parse(String(sent.body.partner_params));
    expect(params).toMatchObject({ aurex_kind: "person", aurex_person_check: check.id });
    expect(check.data_enc).not.toContain("12345678");

    // A forged result is ignored; the real one is recorded against his check.
    const ts = new Date().toISOString();
    const result = (aurexCheck: string) => ({ status: "clear", product: "enhanced_kyc", partner_params: { ...params, aurex_check: aurexCheck, job_id: "job_1" }, id_fields: { full_name: "OTIENO KAMAU", date_of_birth: "1979-11-20" } });
    await request(env.app).post("/api/webhooks/smileid").set("Content-Type", "application/json").set("Response-Timestamp", ts).set("Response-Signature", sign(ts)).send(JSON.stringify(result("forged")));
    let review = (await admin.get("/api/admin/businesses")).body.applications[0];
    expect(review.personChecks[otienoKey].government).toEqual({ status: "pending" });
    await request(env.app).post("/api/webhooks/smileid").set("Content-Type", "application/json").set("Response-Timestamp", ts).set("Response-Signature", sign(ts)).send(JSON.stringify(result(params.aurex_check)));
    review = (await admin.get("/api/admin/businesses")).body.applications[0];
    expect(review.personChecks[otienoKey]).toMatchObject({ status: "submitted", details: { idNumber: "12345678", idType: "national_id" }, government: { status: "clear", nameMatch: 1, dobMatch: true } });

    // Amina lost her link: the applicant gets a new one, and the old one stops working.
    const oldAmina = person(env.app, tokenOf(applied.body.invites[1].link));
    const fresh = await O.post(`/api/account/business/people/${aminaKey}/link`);
    expect(fresh.body).toMatchObject({ name: "Amina Hassan", emailed: true });
    expect((await oldAmina.view()).status).toBe(404);
    const amina = person(env.app, tokenOf(fresh.body.link));
    // A passport has no back.
    expect((await amina.details({ ...details, dateOfBirth: "1988-05-09", idType: "passport", idNumber: "AK1234567", consent: true })).body.needed).toEqual(["id_front", "selfie"]);
    for (const k of ["id_front", "selfie"]) await amina.upload(k);
    expect((await amina.submit()).status).toBe(200);

    // The reviewer opens a photo (audited), then approves.
    review = (await admin.get("/api/admin/businesses")).body.applications[0];
    const selfie = review.personChecks[aminaKey].documents.find((d: { kind: string }) => d.kind === "selfie");
    const photo = await admin.get(`/api/admin/businesses/person-documents/${selfie.id}`);
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/jpeg");
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.business_person_document_viewed'").get()).toEqual({ n: 1 });
    expect((await admin.post(`/api/admin/businesses/${user.id}/review`, { decision: "approve" })).status).toBe(200);
  });

  it("keeps finished checks on a re-application, drops people no longer listed, and refuses expired links", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const { O, user } = await companyOwner(env);
    const first = await O.put("/api/account/business", { ...company, people: [founder, director, investor] });
    const otieno = person(env.app, tokenOf(first.body.invites[0].link));
    await otieno.details({ dateOfBirth: "1979-11-20", nationality: "KE", idType: "passport", idNumber: "AB1234567", idCountry: "KE", idExpiry: "2033-01-01", consent: true });
    for (const k of ["id_front", "selfie"]) await otieno.upload(k);
    expect((await otieno.submit()).status).toBe(200);

    await admin.post(`/api/admin/businesses/${user.id}/review`, { decision: "reject", note: "Amina has left the company" });
    const again = await O.put("/api/account/business", { ...company, people: [founder, director] });
    expect(again.body.invites).toEqual([]); // Otieno is already done; Amina isn't listed any more
    expect((await person(env.app, tokenOf(first.body.invites[1].link)).view()).status).toBe(404);
    expect((await admin.post(`/api/admin/businesses/${user.id}/review`, { decision: "approve" })).status).toBe(200);

    // Links expire.
    const other = await companyOwner(env);
    const applied = await other.O.put("/api/account/business", { ...company, businessName: "Rift Valley Foods Ltd", people: [founder, director] });
    env.ctx.db.prepare("UPDATE business_person_checks SET token_expires_at = ? WHERE business_user_id = ?").run(new Date(Date.now() - 1000).toISOString(), other.user.id);
    const expired = await person(env.app, tokenOf(applied.body.invites[0].link)).view();
    expect(expired.status).toBe(404);
    expect(expired.body.error.message).toMatch(/expired/);
    expect((await other.O.get("/api/account/business")).body.personChecks[applied.body.invites[0].key].status).toBe("expired");
  });

  it("checks the applicant's own name against their verified identity", async () => {
    const env = makeApp();
    const { O, user } = await companyOwner(env);
    const now = new Date().toISOString();
    env.ctx.db
      .prepare("INSERT INTO kyc_submissions (id, user_id, level, status, data_enc, created_at, updated_at) VALUES ('kyc_t', ?, 1, 'approved', ?, ?, ?)")
      .run(user.id, encryptSecret(JSON.stringify({ legalName: "Achieng Odhiambo" }), env.ctx.config.masterKey), now, now);
    expect((await O.put("/api/account/business", { ...company, people: [{ ...founder, name: "Someone Else" }, director] })).body.error.message).toMatch(/isn't the name on your verified identity \(Achieng Odhiambo\)/);
    expect((await O.put("/api/account/business", { ...company, people: [founder, director] })).status).toBe(200);
  });

  it("can be switched off (KYB_PERSON_CHECKS=false)", async () => {
    const env = makeApp({ KYB_PERSON_CHECKS: "false" });
    const admin = await makeAdmin(env);
    const { O, user } = await companyOwner(env);
    const applied = await O.put("/api/account/business", { ...company, people: [founder, { ...director, email: "" }] });
    expect(applied.body.invites).toEqual([]);
    expect((await admin.post(`/api/admin/businesses/${user.id}/review`, { decision: "approve" })).status).toBe(200);
  });
});
