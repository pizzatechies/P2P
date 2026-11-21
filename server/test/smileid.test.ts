import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { pickIdType } from "../src/services/smileid.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub, type Recorded } from "./stub.js";

const PARTNER = "2345";
const KEY = "smile-test-api-key";
const sign = (timestamp: string) => createHmac("sha256", KEY).update(timestamp + PARTNER + "sid_request").digest("base64");

async function smileStub() {
  let jobs = 0;
  const s = await stub((req: Recorded) => {
    if (req.route === "/v3/token" && req.method === "POST") {
      if (req.headers["smileid-partner-id"] !== PARTNER || req.headers["smileid-api-key"] !== KEY) return { status: 401, body: { status: "Unauthorized", message: "bad key" } };
      return { body: { token: "jwt-token" } };
    }
    if (req.route === "/v3/services/supported_id_types") {
      const country = req.query.get("country");
      if (country === "KE") {
        return {
          body: {
            id_types: [
              { country: "KE", type: "ALIEN_CARD", label: "Alien Card", regex: "^[0-9]{6,9}$" },
              { country: "KE", type: "NATIONAL_ID", label: "National ID", regex: "^[0-9]{1,9}$" },
              { country: "KE", type: "PASSPORT", label: "Passport", regex: "^[A-Z0-9]{7,9}$" },
            ],
          },
        };
      }
      return { body: { id_types: [] } };
    }
    if (req.route === "/v3/compare" && req.method === "POST") {
      if (req.headers["smileid-token"] !== "jwt-token") return { status: 401, body: { status: "Unauthorized", message: "token" } };
      return { status: 202, body: { status: "accepted", message: "Job accepted", job_id: `cmp_${++jobs}`, user_id: req.body.user_id, created_at: new Date().toISOString() } };
    }
    if (req.route === "/v3/enhanced_kyc" && req.method === "POST") {
      if (req.headers["smileid-token"] !== "jwt-token") return { status: 401, body: { status: "Unauthorized", message: "token" } };
      return { status: 202, body: { status: "accepted", message: "Job accepted", job_id: `job_${++jobs}`, user_id: req.body.user_id, created_at: new Date().toISOString() } };
    }
    return undefined;
  });
  return s;
}

async function makeAdmin(env: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
async function submit(agent: ReturnType<typeof request.agent>, details: Record<string, unknown>) {
  const A = api(agent);
  expect((await A.put("/api/account/verification/1", details)).status).toBe(200);
  for (const kind of details.idType === "passport" ? ["id_front", "selfie"] : ["id_front", "id_back", "selfie"]) {
    expect((await agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg())).status).toBe(201);
  }
  return A.post("/api/account/verification/1/submit");
}

const kenyan = {
  legalName: "Wanjiku Achieng Otieno",
  dateOfBirth: "1992-07-14",
  nationality: "KE",
  phone: "+254 712 345 678",
  address: { line1: "4 Ngong Road", city: "Nairobi", country: "KE" },
  idType: "national_id",
  idNumber: "23456789",
  idCountry: "KE",
  idExpiry: "2034-01-01",
};

const webhook = (app: ReturnType<typeof makeApp>["app"], body: unknown, timestamp = new Date().toISOString(), signature = sign(timestamp)) =>
  request(app).post("/api/webhooks/smileid").set("Content-Type", "application/json").set("Response-Timestamp", timestamp).set("Response-Signature", signature).send(JSON.stringify(body));

describe("Smile ID government record checks", () => {
  it("picks the right ID type from what Smile ID supports", () => {
    const types = [
      { country: "NG", type: "BVN" },
      { country: "NG", type: "NIN_V2" },
      { country: "NG", type: "DRIVERS_LICENSE" },
      { country: "NG", type: "PASSPORT" },
    ];
    expect(pickIdType(types, "national_id")?.type).toBe("NIN_V2");
    expect(pickIdType(types, "drivers_license")?.type).toBe("DRIVERS_LICENSE");
    expect(pickIdType([{ country: "ZM", type: "TPIN" }], "national_id")).toBeNull();
  });

  it("checks the ID with the government, compares name and birth date, and approves when they match", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, SMILEID_AUTO_APPROVE: "true", APP_URL: "https://aurex.example.com" });
    const admin = await makeAdmin(env);
    const { agent, user } = await signup(env.app, "wanjiku");
    const res = await submit(agent, kenyan);
    expect(res.status).toBe(200);
    expect(res.body.identity.submission.status).toBe("submitted"); // waits for the government record

    // What was sent: the supported type, the customer's details and their consent.
    const sent = smile.calls.find((c) => c.route === "/v3/enhanced_kyc")!;
    expect(sent.headers["smileid-partner-id"]).toBe(PARTNER);
    expect(sent.body).toMatchObject({ country: "KE", id_type: "NATIONAL_ID", id_number: "23456789", user_id: user.id, callback_url: "https://aurex.example.com/api/webhooks/smileid" });
    expect(JSON.parse(sent.body.user_details)).toMatchObject({ given_names: "Wanjiku Achieng", last_name: "Otieno", phone_number: "+254712345678" });
    expect(JSON.parse(sent.body.consent)).toMatchObject({ granted: true, notice_language: "EN", notice_privacy_policy_url: "https://aurex.example.com/privacy" });

    // A forged result is refused.
    expect((await webhook(env.app, { status: "clear" }, new Date().toISOString(), "forged")).status).toBe(401);
    // An old (replayed) one too.
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect((await webhook(env.app, { status: "clear" }, old)).status).toBe(401);

    // Smile ID echoes the partner_params Aurex sent. A signed callback with an edited body (another
    // submission, or no keyed check value) changes nothing.
    const echoed = { ...JSON.parse(sent.body.partner_params), job_id: "job_1" };
    expect(echoed.aurex_check).toMatch(/^[0-9a-f]{40}$/);
    const good = { first_name: "WANJIKU", other_names: "ACHIENG", last_name: "OTIENO", date_of_birth: "1992-07-14", id_number: "23456789" };
    await webhook(env.app, { status: "clear", partner_params: { job_id: "job_1", aurex_submission: echoed.aurex_submission }, id_fields: good });
    await webhook(env.app, { status: "clear", partner_params: { ...echoed, aurex_check: "0".repeat(40) }, id_fields: good });
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level).toBe(0);

    const ok = await webhook(env.app, {
      status: "clear",
      message: "ID verified",
      product: "enhanced_kyc",
      partner_params: echoed,
      id_fields: good,
    });
    expect(ok.status).toBe(200);
    const level = env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number };
    expect(level.kyc_level).toBe(1);

    const reviewed = (await admin.get("/api/admin/users/" + user.id)).body.verification[0];
    expect(reviewed.status).toBe("approved");
    expect(reviewed.check).toMatchObject({ provider: "smileid", status: "clear", result: { nameMatch: 1, dobMatch: true } });

    // Replaying the callback later with a different record doesn't overwrite the result.
    await webhook(env.app, { status: "block", partner_params: echoed, id_fields: { full_name: "SOMEONE ELSE" } });
    expect((await admin.get("/api/admin/users/" + user.id)).body.verification[0].check.result.recordName).toBe("WANJIKU ACHIENG OTIENO");
  });

  it("leaves a mismatch for a person to review, with the government record shown", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, SMILEID_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const { agent, user } = await signup(env.app, "borrowed");
    await submit(agent, kenyan);
    const sent = smile.calls.find((c) => c.route === "/v3/enhanced_kyc")!;
    await webhook(env.app, {
      status: "clear",
      partner_params: { ...JSON.parse(sent.body.partner_params), job_id: "job_1" },
      id_fields: { full_name: "JAMES MWANGI KARIUKI", date_of_birth: "1975-01-02" },
    });
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level).toBe(0);
    const queue = (await admin.get("/api/admin/kyc")).body.submissions;
    expect(queue[0].check.result).toMatchObject({ status: "clear", dobMatch: false, recordName: "JAMES MWANGI KARIUKI" });
    expect(queue[0].check.result.nameMatch).toBeLessThan(0.5);
  });

  it("goes straight to a person when the country or ID number isn't covered", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const a = await signup(env.app, "zambian");
    await submit(a.agent, { ...kenyan, nationality: "ZM", idCountry: "ZM", address: { line1: "1 Cairo Road", city: "Lusaka", country: "ZM" } });
    const b = await signup(env.app, "typo");
    await submit(b.agent, { ...kenyan, idNumber: "ABC-123" });
    const queue = (await admin.get("/api/admin/kyc?status=all")).body.submissions;
    const reasons = queue.map((s: { check: { result: { reason: string } } }) => s.check.result.reason).sort();
    expect(reasons[0]).toMatch(/doesn't cover this ID type in ZM/);
    expect(reasons[1]).toMatch(/doesn't look like a National ID/);
    // With no government check running, the old auto-approval still applies.
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(a.user.id) as { kyc_level: number }).kyc_level).toBe(1);
  });

  it("also compares the selfie with the ID photo when switched on, and approves only when both checks pass", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, SMILEID_AUTO_APPROVE: "true", SMILEID_SELFIE_CHECK: "true", APP_URL: "https://aurex.example.com" });
    const admin = await makeAdmin(env);
    const { agent, user } = await signup(env.app, "selfie");
    await submit(agent, kenyan);
    const level = () => (env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level;

    // Both checks went to Smile ID; the comparison is against the front of the ID document.
    const gov = smile.calls.find((c) => c.route === "/v3/enhanced_kyc")!;
    const cmp = smile.calls.find((c) => c.route === "/v3/compare")!;
    expect(cmp.headers["smileid-partner-id"]).toBe(PARTNER);
    expect(cmp.body).toMatchObject({ comparison_image_type: "DOCUMENT", user_id: user.id, callback_url: "https://aurex.example.com/api/webhooks/smileid" });
    const cmpParams = JSON.parse(cmp.body.partner_params);
    expect(cmpParams).toMatchObject({ aurex_kind: "selfie", aurex_check: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const govParams = JSON.parse(gov.body.partner_params);
    expect(cmpParams.aurex_check).not.toBe(govParams.aurex_check); // each check has its own binding

    // The government record matches: not approved yet, the selfie result is still to come.
    const good = { first_name: "WANJIKU", other_names: "ACHIENG", last_name: "OTIENO", date_of_birth: "1992-07-14", id_number: "23456789" };
    await webhook(env.app, { status: "clear", product: "enhanced_kyc", partner_params: { ...govParams, job_id: "job_1" }, id_fields: good });
    expect(level()).toBe(0);

    // A selfie result that isn't bound to the check is ignored.
    await webhook(env.app, { status: "clear", product: "smart_selfie_compare", partner_params: { job_id: "cmp_2", aurex_submission: cmpParams.aurex_submission } });
    expect(level()).toBe(0);
    // The real one: same face, so both checks have passed.
    await webhook(env.app, { status: "clear", message: "Verification successful", reason: null, product: "smart_selfie_compare", partner_params: { ...cmpParams, job_id: "cmp_2" } });
    expect(level()).toBe(1);
    const reviewed = (await admin.get("/api/admin/users/" + user.id)).body.verification[0];
    expect(reviewed.selfieCheck).toMatchObject({ status: "clear", result: { matched: true } });
  });

  it("leaves a different face, or photos it can't compare, to a person", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, SMILEID_AUTO_APPROVE: "true", SMILEID_SELFIE_CHECK: "true" });
    const admin = await makeAdmin(env);
    const a = await signup(env.app, "mismatch");
    await submit(a.agent, kenyan);
    const govParams = JSON.parse(smile.calls.find((c) => c.route === "/v3/enhanced_kyc")!.body.partner_params);
    const cmpParams = JSON.parse(smile.calls.find((c) => c.route === "/v3/compare")!.body.partner_params);
    await webhook(env.app, { status: "clear", partner_params: { ...govParams, job_id: "job_1" }, id_fields: { full_name: "WANJIKU ACHIENG OTIENO", date_of_birth: "1992-07-14" } });
    await webhook(env.app, { status: "block", reason: "face_verification_failed", message: "The submitted selfie did not match the comparison image.", product: "smart_selfie_compare", partner_params: { ...cmpParams, job_id: "cmp_2" } });
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(a.user.id) as { kyc_level: number }).kyc_level).toBe(0);
    const queue = (await admin.get("/api/admin/kyc")).body.submissions;
    expect(queue[0].selfieCheck).toMatchObject({ status: "block", result: { matched: false, reason: "face_verification_failed" } });

    // A PNG selfie can't be sent for comparison: skipped, with the reason for the reviewer.
    const b = await signup(env.app, "pngselfie");
    const B = api(b.agent);
    await B.put("/api/account/verification/1", kenyan);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 3)]);
    await b.agent.post("/api/account/documents/id_front").set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());
    await b.agent.post("/api/account/documents/id_back").set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());
    await b.agent.post("/api/account/documents/selfie").set("x-aurex-csrf", "1").set("Content-Type", "image/png").send(png);
    await B.post("/api/account/verification/1/submit");
    const row = env.ctx.db.prepare("SELECT selfie_status, selfie_result FROM kyc_submissions WHERE user_id = ?").get(b.user.id) as { selfie_status: string; selfie_result: string };
    expect(row.selfie_status).toBe("skipped");
    expect(JSON.parse(row.selfie_result).reason).toMatch(/JPEG/);
  });
});
