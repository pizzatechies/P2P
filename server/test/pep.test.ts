import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const identity = {
  legalName: "Amina Hassan Odinga",
  dateOfBirth: "1968-04-12",
  nationality: "KE",
  phone: "+254712345678",
  address: { line1: "1 Harambee Ave", city: "Nairobi", country: "KE" },
  idType: "national_id",
  idNumber: "12345678",
  idCountry: "KE",
  idExpiry: "2033-01-01",
};
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]);

async function submitIdentity(agent: Parameters<typeof api>[0]) {
  const A = api(agent);
  await A.put("/api/account/verification/1", identity);
  for (const kind of ["id_front", "id_back", "selfie"]) await agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg);
  return A.post("/api/account/verification/1/submit");
}

async function makeAdmin(env: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(env.app, "mlro");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

async function openSanctions(found: boolean) {
  return stub((r) => {
    if (r.route !== "/match/default") return { status: 404, body: {} };
    if (r.headers.authorization !== "ApiKey os-key") return { status: 401, body: {} };
    const results = found
      ? [{ id: "Q-PEP-1", caption: "Amina Hassan Odinga", schema: "Person", score: 0.93, match: true, datasets: ["ke_parliament"], properties: { topics: ["role.pep", "gov.national"], position: ["Member of Parliament"] } }, { id: "Q-X", caption: "Someone Else", score: 0.6, match: false, properties: { topics: ["role.pep"] } }]
      : [];
    return { body: { responses: { q: { status: 200, results, total: { value: results.length, relation: "eq" } } }, limit: 5 } };
  });
}

describe("politically exposed person screening", () => {
  it("is off until an OpenSanctions key is set", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true" });
    const { agent, user } = await signup(env.app, "plain");
    expect((await submitIdentity(agent)).status).toBe(200);
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level).toBe(1);
  });

  it("screens the legal name, holds a possible match for a person, and puts confirmed PEPs under enhanced due diligence", async () => {
    const os = await openSanctions(true);
    const env = makeApp({ OPENSANCTIONS_API_KEY: "os-key", OPENSANCTIONS_URL: os.url, KYC_AUTO_APPROVE: "true", PAYOUT_REVIEW: "false" });
    const admin = await makeAdmin(env);
    const { agent, user } = await signup(env.app, "amina");
    await submitIdentity(agent);

    // What was asked: a Person with name, birth date and nationality, PEPs and their relatives only.
    const call = os.calls.find((c) => c.route === "/match/default")!;
    expect(call.query.getAll("topics")).toEqual(["role.pep", "role.rca"]);
    expect(call.query.get("threshold")).toBe("0.8");
    expect(call.body).toEqual({ queries: { q: { schema: "Person", properties: { name: ["Amina Hassan Odinga"], birthDate: ["1968-04-12"], nationality: ["KE"] } } } });

    // Only the accepted match opens an alert, and the identity check isn't approved automatically.
    const alerts = env.ctx.db.prepare("SELECT id, rule, severity, summary FROM compliance_alerts WHERE user_id = ?").all(user.id) as { id: string; rule: string; severity: string; summary: string }[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: "pep_match", severity: "medium" });
    expect(alerts[0].summary).toMatch(/resembles "Amina Hassan Odinga", a politically exposed person \(93% match\)/);
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level).toBe(0);

    // The reviewer confirms it: the customer is marked as a PEP, and every payout now waits for review
    // even though PAYOUT_REVIEW is off.
    expect((await admin.post(`/api/admin/compliance/${alerts[0].id}`, { action: "escalate", note: "Confirmed: sitting MP. Enhanced due diligence." })).status).toBe(200);
    expect((await admin.get(`/api/admin/users/${user.id}`)).body.user.pepConfirmedAt).toBeTruthy();
    const A = api(agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const w = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { type: "bank_account", name: "Amina H", accountNumber: "12345678" } });
    expect(w.body.transfer).toMatchObject({ status: "pending" });
    const queue = (await admin.get("/api/admin/payouts")).body.payouts;
    expect(JSON.stringify(queue)).toContain("Politically exposed person");
  });

  it("doesn't approve automatically when the check couldn't run, and clears a non-match", async () => {
    const env = makeApp({ OPENSANCTIONS_API_KEY: "os-key", OPENSANCTIONS_URL: "http://127.0.0.1:9", KYC_AUTO_APPROVE: "true" });
    const { agent, user } = await signup(env.app, "offline");
    await submitIdentity(agent);
    expect((env.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(user.id) as { kyc_level: number }).kyc_level).toBe(0);

    const os = await openSanctions(false);
    const ok = makeApp({ OPENSANCTIONS_API_KEY: "os-key", OPENSANCTIONS_URL: os.url, KYC_AUTO_APPROVE: "true" });
    const c = await signup(ok.app, "clearcase");
    await submitIdentity(c.agent);
    expect((ok.ctx.db.prepare("SELECT kyc_level FROM users WHERE id = ?").get(c.user.id) as { kyc_level: number }).kyc_level).toBe(1);
    const check = ok.ctx.db.prepare("SELECT subject, result FROM sanctions_checks WHERE user_id = ? AND subject LIKE 'pep_%'").get(c.user.id) as { subject: string; result: string };
    expect(check).toEqual({ subject: "pep_legal_name", result: "clear" });
  });
});
