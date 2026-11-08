import request from "supertest";
import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";

async function fund(client: ReturnType<typeof api>, amount: string, currency = "USD") {
  const res = await client.post("/api/payments/deposits", { rail: "sandbox", amount, currency });
  expect(res.status).toBe(201);
  expect(res.body.transfer.status).toBe("completed");
}

describe("auth", () => {
  it("registers, reads the session, logs out and back in", async () => {
    const { app } = makeApp();
    const { agent, user } = await signup(app, "alice");
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.handle).toBe(user.handle);

    await api(agent).post("/api/auth/logout");
    expect((await agent.get("/api/auth/me")).status).toBe(401);

    const bad = await api(agent).post("/api/auth/login", { email: user.email, password: "nope-nope-1" });
    expect(bad.status).toBe(401);
    const good = await api(agent).post("/api/auth/login", { email: user.email, password: "correct-horse-42" });
    expect(good.status).toBe(200);
  });

  it("rejects weak passwords and duplicate handles", async () => {
    const { app } = makeApp();
    const weak = await request(app).post("/api/auth/register").set("x-aurex-csrf", "1")
      .send({ email: "w@example.com", handle: "weakling", displayName: "W", password: "short" });
    expect(weak.status).toBe(400);
    const { user } = await signup(app, "dup");
    const again = await request(app).post("/api/auth/register").set("x-aurex-csrf", "1")
      .send({ email: "other@example.com", handle: user.handle, displayName: "X", password: "correct-horse-42" });
    expect(again.status).toBe(409);
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "csrf");
    const res = await agent.post("/api/payments/send").send({ to: "x", amount: "1", currency: "USD" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });
});

describe("payments", () => {
  it("deposits, sends money and keeps the ledger balanced", async () => {
    const { app, ctx } = makeApp();
    const a = await signup(app, "payer");
    const b = await signup(app, "payee");
    const A = api(a.agent);
    const B = api(b.agent);

    await fund(A, "100.00");
    const send = await A.post("/api/payments/send", { to: `@${b.user.handle}`, amount: "25.50", currency: "USD", memo: "Dinner" });
    expect(send.status).toBe(201);
    expect(send.body.transfer.amount).toBe("25.50");

    const balA = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    const balB = (await B.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(balA.balance).toBe("74.50");
    expect(balB.balance).toBe("25.50");

    const activity = (await B.get("/api/payments/activity")).body.items;
    expect(activity[0]).toMatchObject({ kind: "transfer", direction: "in", memo: "Dinner" });
    expect(activity[0].counterparty.handle).toBe(a.user.handle);

    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("refuses to overdraw and to send to yourself", async () => {
    const { app } = makeApp();
    const a = await signup(app, "broke");
    const b = await signup(app, "rich");
    const A = api(a.agent);
    const over = await A.post("/api/payments/send", { to: b.user.email, amount: "1", currency: "USD" });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("insufficient_funds");
    await fund(A, "10");
    const self = await A.post("/api/payments/send", { to: a.user.handle, amount: "1", currency: "USD" });
    expect(self.status).toBe(400);
  });

  it("is idempotent when the same send is retried", async () => {
    const { app, ctx } = makeApp();
    const a = await signup(app, "retry");
    const b = await signup(app, "target");
    const A = api(a.agent);
    await fund(A, "50");
    const body = { to: b.user.handle, amount: "10", currency: "USD", idempotencyKey: "send-0001-abcdef" };
    const first = await A.post("/api/payments/send", body);
    const second = await A.post("/api/payments/send", body);
    expect(first.body.transfer.id).toBe(second.body.transfer.id);
    const bal = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(bal.balance).toBe("40.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("charges configured fees into the fees account", async () => {
    const { app, ctx } = makeApp({ P2P_FEE_BPS: "100" }); // 1%
    const a = await signup(app, "feepayer");
    const b = await signup(app, "feepayee");
    const A = api(a.agent);
    await fund(A, "100");
    const res = await A.post("/api/payments/send", { to: b.user.handle, amount: "50", currency: "USD" });
    expect(res.body.transfer.fee).toBe("0.50");
    const bal = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(bal.balance).toBe("49.50");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("handles payment requests end to end", async () => {
    const { app, ctx } = makeApp();
    const a = await signup(app, "asker");
    const b = await signup(app, "giver");
    const A = api(a.agent);
    const B = api(b.agent);
    await fund(B, "30");

    const created = await A.post("/api/payments/requests", { from: b.user.handle, amount: "12", currency: "USD", memo: "Tickets" });
    expect(created.status).toBe(201);
    const id = created.body.request.id;

    const inbox = (await B.get("/api/payments/requests")).body.incoming;
    expect(inbox[0].id).toBe(id);
    expect((await A.post(`/api/payments/requests/${id}/pay`)).status).toBe(403); // requester can't pay own request

    const paid = await B.post(`/api/payments/requests/${id}/pay`);
    expect(paid.body.request.status).toBe("paid");
    expect((await B.post(`/api/payments/requests/${id}/pay`)).status).toBe(422); // no double payment

    const balA = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(balA.balance).toBe("12.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("converts currencies with the configured spread", async () => {
    const { app, ctx } = makeApp({ FX_SPREAD_BPS: "0" });
    const a = await signup(app, "fx");
    const A = api(a.agent);
    await fund(A, "100");
    const quote = await A.get("/api/payments/fx/quote?from=USD&to=EUR&amount=100");
    expect(quote.body.quote.toAmount).toBe("92.00");
    const conv = await A.post("/api/payments/convert", { from: "USD", to: "EUR", amount: "100" });
    expect(conv.status).toBe(201);
    const balances = (await A.get("/api/payments/balances")).body.balances;
    expect(balances.find((x: { currency: string }) => x.currency === "EUR").balance).toBe("92.00");
    expect(balances.find((x: { currency: string }) => x.currency === "USD").balance).toBe("0.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("withdraws, and returns the money when the payout fails", async () => {
    const { app, ctx } = makeApp({ WITHDRAWAL_FEE_BPS: "100" });
    const a = await signup(app, "withdrawer");
    const A = api(a.agent);
    await fund(A, "200");
    const dest = { type: "bank_account", name: "My bank", accountNumber: "12345678" };
    const ok = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "100", currency: "USD", destination: dest });
    expect(ok.status).toBe(201);
    expect(ok.body.transfer.status).toBe("completed");
    let usd = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(usd.balance).toBe("99.00"); // 100 + 1% fee

    const fail = await A.post("/api/payments/withdrawals", {
      rail: "sandbox",
      amount: "50",
      currency: "USD",
      destination: { ...dest, accountNumber: "99990000" },
    });
    expect(fail.status).toBe(422);
    expect(fail.body.error.code).toBe("payout_failed");
    usd = (await A.get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(usd.balance).toBe("99.00"); // fully refunded, fee included
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("enforces per-transaction and daily limits", async () => {
    const { app } = makeApp({ MAX_TX_USD: "100", DAILY_LIMIT_USD: "150" });
    const a = await signup(app, "limited");
    const b = await signup(app, "limitrcv");
    const A = api(a.agent);
    await fund(A, "100");
    await fund(A, "100");
    const big = await A.post("/api/payments/send", { to: b.user.handle, amount: "101", currency: "USD" });
    expect(big.body.error.code).toBe("limit_exceeded");
    expect((await A.post("/api/payments/send", { to: b.user.handle, amount: "100", currency: "USD" })).status).toBe(201);
    const daily = await A.post("/api/payments/send", { to: b.user.handle, amount: "60", currency: "USD" });
    expect(daily.body.error.code).toBe("limit_exceeded");
  });

  it("verifies Stripe webhook signatures and credits only once", async () => {
    const { app, ctx } = makeApp({ STRIPE_WEBHOOK_SECRET: "whsec_test" });
    const { createHmac } = await import("node:crypto");
    const { run, nowIso } = await import("../src/db/index.js");
    const a = await signup(app, "stripey");
    run(ctx.db,
      `INSERT INTO external_transfers (id, user_id, direction, rail, currency, amount, status, provider_ref, created_at, updated_at)
       VALUES ('ext_test', ?, 'deposit', 'stripe', 'USD', 4200, 'pending', 'cs_test_123', ?, ?)`,
      a.user.id, nowIso(), nowIso());
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_123", payment_status: "paid" } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");

    const forged = await request(app).post("/api/webhooks/stripe").set("stripe-signature", `t=${t},v1=deadbeef`).set("content-type", "application/json").send(payload);
    expect(forged.status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post("/api/webhooks/stripe").set("stripe-signature", `t=${t},v1=${sig}`).set("content-type", "application/json").send(payload);
      expect(res.status).toBe(200);
    }
    const usd = (await api(a.agent).get("/api/payments/balances")).body.balances.find((x: { currency: string }) => x.currency === "USD");
    expect(usd.balance).toBe("42.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

describe("admin accounts", () => {
  it("grants admin from ADMIN_EMAILS at sign-up and to existing accounts at login", async () => {
    const { createApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const { openDb } = await import("../src/db/index.js");
    const base = { NODE_ENV: "test", DATABASE_PATH: ":memory:", MASTER_KEY: "test-master-key-0123456789abcdef0123456789" };
    const db = openDb(":memory:");

    // Registered while the address is NOT an admin email.
    const before = createApp(loadConfig({ ...base }), db).app;
    const reg = await request(before).post("/api/auth/register").set("x-aurex-csrf", "1")
      .send({ email: "Owner@Example.com", handle: "owner", displayName: "Owner", password: "correct-horse-42" });
    expect(reg.body.user.role).toBe("user");

    // Operator adds the address; the next login promotes the existing account.
    const after = createApp(loadConfig({ ...base, ADMIN_EMAILS: "owner@example.com, boss@example.com" }), db).app;
    const login = await request(after).post("/api/auth/login").set("x-aurex-csrf", "1")
      .send({ email: "owner@example.com", password: "correct-horse-42" });
    expect(login.body.user.role).toBe("admin");

    // New sign-ups with an admin email are admins straight away; everyone else is not.
    const boss = await request(after).post("/api/auth/register").set("x-aurex-csrf", "1")
      .send({ email: "boss@example.com", handle: "boss", displayName: "Boss", password: "correct-horse-42" });
    expect(boss.body.user.role).toBe("admin");
    const other = await request(after).post("/api/auth/register").set("x-aurex-csrf", "1")
      .send({ email: "someone@example.com", handle: "someone", displayName: "Someone", password: "correct-horse-42" });
    expect(other.body.user.role).toBe("user");
  });
});
