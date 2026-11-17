import { afterEach, describe, expect, it, vi } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { verifyLedger } from "../src/services/ledger.js";
import { trialBalance } from "../src/services/ledgerData.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;
const dest = { type: "bank_account", name: "My bank", accountNumber: "12345678" };

afterEach(() => vi.restoreAllMocks());

async function makeAdmin({ app, ctx }: App, name = "admin") {
  const { agent, user } = await signup(app, name);
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, agent, user };
}

async function customer(env: App, name: string, amount = "500") {
  const { agent, user } = await signup(env.app, name);
  const A = api(agent);
  expect((await A.post("/api/payments/deposits", { rail: "sandbox", amount, currency: "USD" })).status).toBe(201);
  return { A, user };
}

const usdBalance = async (A: ReturnType<typeof api>) =>
  (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD")?.balance;

describe("payout review", () => {
  it("holds large withdrawals for a second person, who sends them or returns the money", async () => {
    const env = makeApp({ PAYOUT_REVIEW: "true", PAYOUT_REVIEW_USD: "100" });
    const c = await customer(env, "payee");
    // An established customer (a brand-new account's first withdrawal is always reviewed).
    env.ctx.db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString(), c.user.id);
    const admin = await makeAdmin(env);
    // Under the threshold: paid out at once.
    const small = await c.A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "40", currency: "USD", destination: dest });
    expect(small.body.transfer).toMatchObject({ status: "completed", review: null });

    // Over it: held, the money is reserved, nothing is sent yet.
    const big = await c.A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "150", currency: "USD", destination: dest });
    expect(big.status).toBe(201);
    expect(big.body.transfer).toMatchObject({ status: "pending", review: "required" });
    expect(await usdBalance(c.A)).toBe("310.00");

    const queue = (await admin.A.get("/api/admin/payouts")).body.payouts;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: big.body.transfer.id, amount: "150.00", user: { handle: c.user.handle } });
    expect(queue[0].reasons[0]).toMatch(/\$100/);
    const notified = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM security_alerts WHERE user_id = ? AND message LIKE '%waiting for your review%'").get(admin.user.id) as { n: number };
    expect(notified.n).toBe(1);

    const approved = await admin.A.post(`/api/admin/payouts/${big.body.transfer.id}/approve`, {});
    expect(approved.body.transfer.status).toBe("completed");
    expect((await admin.A.post(`/api/admin/payouts/${big.body.transfer.id}/approve`, {})).status).toBe(422); // only once

    // Rejected: the money comes back and the customer is told why.
    const third = await c.A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "200", currency: "USD", destination: dest });
    expect((await admin.A.post(`/api/admin/payouts/${third.body.transfer.id}/reject`, { note: "x" })).status).toBe(400);
    const rejected = await admin.A.post(`/api/admin/payouts/${third.body.transfer.id}/reject`, { note: "Please withdraw to an account in your own name" });
    expect(rejected.body.transfer).toMatchObject({ status: "failed", review: "rejected" });
    expect(await usdBalance(c.A)).toBe("310.00");
    const told = (await c.A.get("/api/settings/security")).body.alerts.map((a: { message: string }) => a.message).join(" ");
    expect(told).toMatch(/in your own name/);
    expect(verifyLedger(env.ctx).ok).toBe(true);
  });

  it("never lets an admin approve their own withdrawal, and customers can't reach the queue", async () => {
    const env = makeApp({ PAYOUT_REVIEW: "true", PAYOUT_REVIEW_USD: "100" });
    const admin = await makeAdmin(env);
    await admin.A.post("/api/payments/deposits", { rail: "sandbox", amount: "500", currency: "USD" });
    const own = await admin.A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "300", currency: "USD", destination: dest });
    expect(own.body.transfer.review).toBe("required");
    expect((await admin.A.post(`/api/admin/payouts/${own.body.transfer.id}/approve`, {})).status).toBe(403);
    const other = await makeAdmin(env, "admin2");
    expect((await other.A.post(`/api/admin/payouts/${own.body.transfer.id}/approve`, {})).body.transfer.status).toBe("completed");
    const c = await customer(env, "nosy");
    expect((await c.A.get("/api/admin/payouts")).status).toBe(403);
  });
});

describe("transaction monitoring", () => {
  it("flags large payments, money passing straight through and new-account withdrawals, and holds the payout", async () => {
    const env = makeApp({ PAYOUT_REVIEW: "true", PAYOUT_REVIEW_USD: "10000", MONITOR_LARGE_USD: "400" });
    const c = await customer(env, "mover", "450");
    const w = await c.A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "420", currency: "USD", destination: dest });
    // Under the review amount, but the alerts it raised hold it.
    expect(w.body.transfer.review).toBe("required");

    const admin = await makeAdmin(env);
    const alerts = (await admin.A.get("/api/admin/compliance")).body.alerts;
    const rules = alerts.map((a: { rule: string }) => a.rule).sort();
    expect(rules).toEqual(["large_amount", "large_amount", "new_account_payout", "rapid_in_out"]);
    expect(alerts[0].severity).toBe("high"); // most serious first
    expect(alerts.every((a: { user: { handle: string } }) => a.user.handle === c.user.handle)).toBe(true);

    // Customers never see their alerts (no tipping off).
    expect((await c.A.get("/api/admin/compliance")).status).toBe(403);
    const exported = JSON.stringify((await c.A.get("/api/account/export")).body);
    expect(exported).not.toMatch(/rapid_in_out|compliance/);

    // Clear one, escalate another and freeze the account.
    expect((await admin.A.post(`/api/admin/compliance/${alerts[1].id}`, { action: "clear", note: "ok" })).status).toBe(400);
    expect((await admin.A.post(`/api/admin/compliance/${alerts[1].id}`, { action: "clear", note: "Salary, matches their profile" })).body.alert.status).toBe("cleared");
    const esc = await admin.A.post(`/api/admin/compliance/${alerts[0].id}`, { action: "escalate", note: "Filing a report", freeze: true });
    expect(esc.body.alert.status).toBe("escalated");
    const status = env.ctx.db.prepare("SELECT status FROM users WHERE id = ?").get(c.user.id) as { status: string };
    expect(status.status).toBe("frozen");
    expect((await admin.A.get(`/api/admin/users/${c.user.id}`)).body.compliance.length).toBe(4);
  });

  it("spots payments split to stay just under the limit", async () => {
    const env = makeApp({ KYC_LIMITS: "true", TIER0_TX_USD: "100", TIER0_DAILY_USD: "100000" });
    const { agent, user } = await signup(env.app, "splitter");
    const A = api(agent);
    for (let i = 0; i < 3; i++) expect((await A.post("/api/payments/deposits", { rail: "sandbox", amount: "95", currency: "USD" })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 50)); // monitoring of deposits runs after they're credited
    const hits = env.ctx.db.prepare("SELECT rule FROM compliance_alerts WHERE user_id = ?").all(user.id) as { rule: string }[];
    expect(hits.map((h) => h.rule)).toContain("structuring");
  });
});

describe("safeguarding", () => {
  it("reconciles what's owed to customers with what's actually held, and alerts on a shortfall", async () => {
    const env = makeApp();
    await customer(env, "saver", "300");
    const admin = await makeAdmin(env);
    let sg = (await admin.A.get("/api/admin/safeguarding")).body;
    expect(sg.position).toEqual([expect.objectContaining({ currency: "USD", owed: "300.00", held: "0.00", status: "unverified" })]);

    const acct = (await admin.A.post("/api/admin/safeguarding/accounts", {
      name: "Safeguarding USD",
      kind: "bank",
      institution: "First Example Bank",
      currency: "USD",
      details: "Account 000123456789",
    })).body.account;
    // Details are encrypted at rest, readable by an admin (audited).
    const stored = env.ctx.db.prepare("SELECT details_enc FROM safeguarding_accounts WHERE id = ?").get(acct.id) as { details_enc: string };
    expect(stored.details_enc).not.toContain("000123456789");
    expect((await admin.A.get(`/api/admin/safeguarding/accounts/${acct.id}/details`)).body.details).toBe("Account 000123456789");

    await admin.A.post(`/api/admin/safeguarding/accounts/${acct.id}/balances`, { balance: "250.00", asOf: new Date().toISOString(), note: "Statement" });
    let rec = (await admin.A.post("/api/admin/safeguarding/reconcile")).body;
    expect(rec.position[0]).toMatchObject({ currency: "USD", status: "shortfall", difference: "-50.00" });
    const alerted = env.ctx.db.prepare("SELECT COUNT(*) AS n FROM security_alerts WHERE user_id = ? AND message LIKE 'Safeguarding shortfall%'").get(admin.user.id) as { n: number };
    expect(alerted.n).toBe(1);

    await admin.A.post(`/api/admin/safeguarding/accounts/${acct.id}/balances`, { balance: "320.00", asOf: new Date().toISOString() });
    rec = (await admin.A.post("/api/admin/safeguarding/reconcile")).body;
    expect(rec.position[0]).toMatchObject({ status: "covered", difference: "20.00" });

    // An old statement doesn't count as verified.
    await admin.A.post(`/api/admin/safeguarding/accounts/${acct.id}/balances`, { balance: "320.00", asOf: new Date(Date.now() - 4 * 86_400_000).toISOString() });
    sg = (await admin.A.get("/api/admin/safeguarding")).body;
    expect(sg.position[0].status).toBe("covered"); // the newer balance still wins
    expect(sg.reconciliations.map((r: { status: string }) => r.status)).toEqual(["covered", "shortfall"]);
    expect(() => env.ctx.db.prepare("UPDATE safeguarding_balances SET balance_minor = 0").run()).toThrow(/immutable/);
    expect(() => env.ctx.db.prepare("DELETE FROM reconciliations").run()).toThrow(/immutable/);
    expect((await admin.A.post(`/api/admin/safeguarding/accounts/${acct.id}/balances`, { balance: "1", asOf: "2999-01-01" })).status).toBe(400);
  });

  it("fetches balances from a payment provider", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url !== "https://api.stripe.com/v1/balance") return realFetch(input, init);
      return new Response(JSON.stringify({ available: [{ amount: 50000, currency: "usd" }, { amount: 900, currency: "xyz" }], pending: [{ amount: 2500, currency: "usd" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const env = makeApp({ STRIPE_SECRET_KEY: "sk_test_example" });
    const admin = await makeAdmin(env);
    const acct = (await admin.A.post("/api/admin/safeguarding/accounts", { name: "Stripe USD", kind: "payment_provider", institution: "Stripe", currency: "USD", source: "stripe" })).body.account;
    const r = (await admin.A.post("/api/admin/safeguarding/refresh")).body.results;
    expect(r).toEqual([{ account: "Stripe USD", ok: true, message: "USD 525.00" }]);
    const hist = (await admin.A.get(`/api/admin/safeguarding/accounts/${acct.id}/balances`)).body.balances;
    expect(hist[0]).toMatchObject({ balance: "525.00", source: "api" });
  });

  it("sweeps earned fees out of the safeguarded pool and keeps the books balanced", async () => {
    const env = makeApp({ P2P_FEE_BPS: "100" });
    const a = await customer(env, "payer", "200");
    const b = await signup(env.app, "payee");
    await a.A.post("/api/payments/send", { to: `@${b.user.handle}`, amount: "100", currency: "USD" });
    const admin = await makeAdmin(env);
    let sg = (await admin.A.get("/api/admin/safeguarding")).body;
    expect(sg.income).toEqual([{ from: "fees", currency: "USD", amount: "1.00" }]);
    expect((await admin.A.post("/api/admin/safeguarding/sweep", { from: "fees", currency: "USD", amount: "5" })).status).toBe(422);
    const swept = await admin.A.post("/api/admin/safeguarding/sweep", { from: "fees", currency: "USD", amount: "0.60", note: "October fees" });
    expect(swept.status).toBe(201);
    sg = (await admin.A.get("/api/admin/safeguarding")).body;
    expect(sg.income).toEqual([{ from: "fees", currency: "USD", amount: "0.40" }]);
    expect(verifyLedger(env.ctx).ok).toBe(true);
    expect(trialBalance(env.ctx).balanced).toBe(true);
    expect(sg.assets.wallets[0]).toMatchObject({ currency: "USD", custodian: expect.stringMatching(/safeguarded/) });
  });
});
