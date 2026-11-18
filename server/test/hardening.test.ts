import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { loadConfig } from "../src/config.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;

async function makeAdmin({ app, ctx }: App, name = "admin") {
  const { agent, user } = await signup(app, name);
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, agent, user };
}

const alerts = async (A: ReturnType<typeof api>) => ((await A.get("/api/settings/security")).body.alerts as { kind: string; message: string }[]);

describe("admin access", () => {
  it("only answers admin requests from allowed addresses", async () => {
    const blocked = makeApp({ ADMIN_ALLOWED_IPS: "203.0.113.7, 198.51.100.0/24" });
    const a = await makeAdmin(blocked);
    const res = await a.A.get("/api/admin/overview");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("admin_ip_blocked");

    const allowed = makeApp({ ADMIN_ALLOWED_IPS: "203.0.113.7,127.0.0.0/8,::1" });
    const b = await makeAdmin(allowed);
    expect((await b.A.get("/api/admin/overview")).status).toBe(200);

    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", ADMIN_ALLOWED_IPS: "office" })).toThrow(/ADMIN_ALLOWED_IPS/);
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", ADMIN_ALLOWED_IPS: "10.0.0.0/33" })).toThrow(/ADMIN_ALLOWED_IPS/);
  });

  it("signs idle admins out sooner than customers", async () => {
    const env = makeApp({ ADMIN_SESSION_IDLE_MINUTES: "30", SESSION_IDLE_MINUTES: "120" });
    const admin = await makeAdmin(env);
    const customer = await signup(env.app, "customer");
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    env.ctx.db.prepare("UPDATE sessions SET last_seen_at = ?").run(fortyMinutesAgo);
    expect((await admin.A.get("/api/auth/me")).status).toBe(401);
    expect((await api(customer.agent).get("/api/auth/me")).status).toBe(200);
  });

  it("tells other admins when someone becomes an admin, and customers when an admin changes their account", async () => {
    const env = makeApp({ ADMIN_EMAILS: "boss@example.com", ADMIN_SETUP_CODE: "setup-code-0123456789abcdef", REQUIRE_ADMIN_2FA: "false" });
    const first = await makeAdmin(env, "first");
    // A second person claims admin access with the setup code.
    const { agent } = await signup(env.app, "boss");
    env.ctx.db.prepare("UPDATE users SET email = 'boss@example.com' WHERE handle LIKE 'boss%'").run();
    const B = api(agent);
    const claim = await B.post("/api/settings/admin/claim", { code: "setup-code-0123456789abcdef" });
    expect(claim.status).toBe(200);
    expect((await alerts(first.A)).some((a) => /now has admin access/.test(a.message))).toBe(true);

    const c = await signup(env.app, "managed");
    expect((await first.A.post(`/api/admin/users/${c.user.id}/limits`, { txUsd: 50, dailyUsd: 100 })).status).toBe(200);
    expect((await alerts(api(c.agent))).some((a) => /limits were changed by our team: \$50 per payment and \$100 a day/.test(a.message))).toBe(true);
  });
});

describe("payouts to new destinations", () => {
  it("alerts the customer the first time money goes somewhere new", async () => {
    const env = makeApp();
    const { agent } = await signup(env.app, "payer");
    const A = api(agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const dest = { type: "bank_account", name: "Savings", accountNumber: "1234 5678" };
    await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: dest });
    // Same account, typed differently and under another name: not new.
    await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { ...dest, name: "My savings", accountNumber: "12345678" } });
    await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { ...dest, accountNumber: "99990000" } });
    const newPayee = (await alerts(A)).filter((a) => a.kind === "new_payee");
    expect(newPayee).toHaveLength(2);
    expect(newPayee[1].message).toMatch(/new destination \(Savings ••5678\)/);
    expect(newPayee[0].message).toMatch(/••0000/);
  });
});

describe("security checklist", () => {
  it("reports what's protected and what still needs doing, worst first", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const res = await admin.A.get("/api/admin/security");
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.checks as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ master_key: "pass", admin_2fa: "pass", payout_review: "fail", kyc: "fail", sanctions: "fail", admin_ips: "warn", ledger: "pass", integrity: "pass" });
    expect(res.body.checks[0].status).toBe("fail");
    expect(res.body.failing).toBe(3); // payout review, identity limits, and sanctions lists not downloaded yet
    // Values are never included, only whether they're set.
    expect(JSON.stringify(res.body)).not.toContain("test-master-key");
    const c = await signup(env.app, "customer");
    expect((await api(c.agent).get("/api/admin/security")).status).toBe(403);
  });
});
