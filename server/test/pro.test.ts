import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { verifyLedger } from "../src/services/ledger.js";
import { isPro, processRenewals } from "../src/services/pro.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;
const DAY = 86_400_000;
const PRO = { PRO_ENABLED: "true", PRO_PRICE: "5", PRO_CURRENCY: "USD", AI_FREE_DAILY_REQUESTS: "10", PRO_AI_DAILY_REQUESTS: "200" };

async function customer(env: App, name: string, deposit?: { amount: string; currency: string }) {
  const { agent, user } = await signup(env.app, name);
  const A = api(agent);
  if (deposit) expect((await A.post("/api/payments/deposits", { rail: "sandbox", ...deposit })).status).toBe(201);
  return { A, user };
}
const balance = async (A: ReturnType<typeof api>, currency = "USD") =>
  (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === currency)?.balance;
const fees = (env: App, currency = "USD") =>
  (env.ctx.db.prepare("SELECT balance FROM accounts WHERE owner_type = 'system' AND code = 'fees' AND currency = ?").get(currency) as { balance: number } | undefined)?.balance ?? 0;

describe("Aurex Pro", () => {
  it("is off by default, and then nothing is behind it", async () => {
    const env = makeApp();
    const { A } = await customer(env, "plain");
    const pro = (await A.get("/api/pro")).body;
    expect(pro).toMatchObject({ enabled: false, pro: false });
    expect((await A.post("/api/pro/subscribe", {})).status).toBe(404);
    expect((await A.put("/api/trading/autopilot", { enabled: true, acknowledge: true })).status).toBe(200);
  });

  it("is paid from the wallet into fee income, and unlocks its perks", async () => {
    const env = makeApp(PRO);
    const broke = await customer(env, "broke");
    const res = await broke.A.post("/api/pro/subscribe", {});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/costs USD 5\.00 a month/);

    const { A, user } = await customer(env, "subscriber", { amount: "12", currency: "USD" });
    // Before: the free plan.
    expect((await A.get("/api/ai/providers")).body.freeAllowance).toMatchObject({ limit: 10, pro: false, proAvailable: true });
    const ap = await A.put("/api/trading/autopilot", { enabled: true, acknowledge: true });
    expect(ap.status).toBe(403);
    expect(ap.body.error.code).toBe("pro_required");

    const sub = await A.post("/api/pro/subscribe", {});
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ pro: true, subscription: { status: "active", currency: "USD", amount: "5.00", comped: false } });
    expect(await balance(A)).toBe("7.00");
    expect(fees(env)).toBe(500);
    const journal = env.ctx.db.prepare("SELECT kind, memo FROM journals WHERE kind = 'subscription'").get() as { kind: string; memo: string };
    expect(journal.memo).toMatch(/^Aurex Pro, \d{4}-\d{2}-\d{2} to /);
    expect(verifyLedger(env.ctx).ok).toBe(true);

    // After: the Pro perks.
    expect((await A.get("/api/ai/providers")).body.freeAllowance).toMatchObject({ limit: 200, pro: true });
    expect((await A.put("/api/trading/autopilot", { enabled: true, acknowledge: true })).status).toBe(200);
    expect((await A.post("/api/pro/subscribe", {})).body.error.code).toBe("already_pro");
    expect(isPro(env.ctx, user.id)).toBe(true);
  });

  it("can be paid in the customer's own currency at the mid-market rate", async () => {
    const env = makeApp(PRO);
    const { A } = await customer(env, "kenyan", { amount: "5000", currency: "KES" });
    const overview = (await A.get("/api/pro")).body;
    const kes = overview.payWith.find((o: { currency: string }) => o.currency === "KES");
    expect(Number(kes.price)).toBeGreaterThan(100); // USD 5 is a few hundred shillings
    expect(kes.affordable).toBe(true);
    expect((await A.post("/api/pro/subscribe", { currency: "KES" })).status).toBe(201);
    expect(Number(await balance(A, "KES"))).toBeCloseTo(5000 - Number(kes.price), 2);
    expect(fees(env, "KES")).toBe(Math.round(Number(kes.price) * 100));
  });

  it("renews monthly, retries for a few days when the wallet is short, then ends", async () => {
    const env = makeApp(PRO);
    const { A, user } = await customer(env, "renewer", { amount: "11", currency: "USD" });
    await A.post("/api/pro/subscribe", {});
    const now = Date.now();
    // Month two: paid.
    expect(processRenewals(env.ctx, new Date(now + 31 * DAY))).toEqual({ renewed: 1, failed: 0, ended: 0 });
    expect(await balance(A)).toBe("1.00");
    // Month three: only $1 left, so it retries...
    expect(processRenewals(env.ctx, new Date(now + 61 * DAY))).toEqual({ renewed: 0, failed: 1, ended: 0 });
    expect((await A.get("/api/pro")).body.subscription.status).toBe("past_due");
    expect(isPro(env.ctx, user.id)).toBe(true); // grace period
    const alerts = (await A.get("/api/settings/security")).body.alerts.map((a: { message: string }) => a.message);
    expect(alerts.some((m: string) => /couldn't renew/.test(m))).toBe(true);
    // ...not twice in a day...
    expect(processRenewals(env.ctx, new Date(now + 61 * DAY + 3_600_000))).toEqual({ renewed: 0, failed: 0, ended: 0 });
    // ...and after the grace period it ends.
    expect(processRenewals(env.ctx, new Date(now + 64 * DAY))).toEqual({ renewed: 0, failed: 0, ended: 1 });
    expect((await A.get("/api/pro")).body.subscription.status).toBe("canceled");
    expect(await balance(A)).toBe("1.00"); // never overdrawn
    expect(verifyLedger(env.ctx).ok).toBe(true);
  });

  it("cancels at the end of the month already paid for, and can be resumed before then", async () => {
    const env = makeApp(PRO);
    const { A, user } = await customer(env, "canceller", { amount: "20", currency: "USD" });
    await A.post("/api/pro/subscribe", {});
    let o = (await A.post("/api/pro/cancel")).body;
    expect(o.subscription).toMatchObject({ renewsAt: null, endsAt: expect.any(String) });
    expect(o.pro).toBe(true);
    o = (await A.post("/api/pro/resume")).body;
    expect(o.subscription.renewsAt).toEqual(expect.any(String));
    await A.post("/api/pro/cancel");
    expect(processRenewals(env.ctx, new Date(Date.now() + 31 * DAY))).toEqual({ renewed: 0, failed: 0, ended: 1 });
    expect(isPro(env.ctx, user.id)).toBe(false);
    expect(await balance(A)).toBe("15.00"); // charged once
  });

  it("lets an admin give Pro free for a while", async () => {
    const env = makeApp(PRO);
    const { agent, user: adminUser } = await signup(env.app, "admin");
    env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
    const Admin = api(agent);
    const setup = await Admin.post("/api/settings/2fa/setup");
    await Admin.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
    const { A, user } = await customer(env, "tester");
    expect((await Admin.post(`/api/admin/users/${user.id}/pro`, { days: 14 })).status).toBe(200);
    expect((await A.get("/api/pro")).body).toMatchObject({ pro: true, subscription: { comped: true, renewsAt: null } });
    expect(processRenewals(env.ctx, new Date(Date.now() + 15 * DAY))).toEqual({ renewed: 0, failed: 0, ended: 1 });
    expect(isPro(env.ctx, user.id)).toBe(false);
  });
});
