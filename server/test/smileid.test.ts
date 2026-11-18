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

    const ok = await webhook(env.app, {
      status: "clear",
      message: "ID verified",
      product: "enhanced_kyc",
      partner_params: { job_id: "job_1", user_id: user.id },
      id_fields: { first_name: "WANJIKU", other_names: "ACHIENG", last_name: "OTIENO", date_of_birth: "1992-07-14", id_number: "23456789" },
    });
    expect(ok.status).toBe(200);
    const level = env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number };
    expect(level.kyc_level).toBe(1);

    const reviewed = (await admin.get("/api/admin/users/" + user.id)).body.verification[0];
    expect(reviewed.status).toBe("approved");
    expect(reviewed.check).toMatchObject({ provider: "smileid", status: "clear", result: { nameMatch: 1, dobMatch: true } });
  });

  it("leaves a mismatch for a person to review, with the government record shown", async () => {
    const smile = await smileStub();
    const env = makeApp({ SMILEID_PARTNER_ID: PARTNER, SMILEID_API_KEY: KEY, SMILEID_BASE_URL: smile.url, SMILEID_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const { agent, user } = await signup(env.app, "borrowed");
    await submit(agent, kenyan);
    await webhook(env.app, {
      status: "clear",
      partner_params: { job_id: "job_1" },
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
});
