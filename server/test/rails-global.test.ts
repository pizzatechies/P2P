import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

type Bal = { currency: string; balance: string }[];
const bal = (b: Bal, c: string) => b.find((x) => x.currency === c)?.balance;
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fundedUser(app: ReturnType<typeof makeApp>["app"], name: string, currency: string, amount: string) {
  const { agent } = await signup(app, name);
  const A = api(agent);
  expect((await A.post("/api/payments/deposits", { rail: "sandbox", amount, currency })).body.transfer.status).toBe("completed");
  return A;
}

// ---------------------------------------------------------------------------
describe("Skrill rail", () => {
  const SECRET = "mysecret";
  async function setup(extra: Record<string, string> = {}) {
    const state = { trn: null as null | Record<string, string>, transfer: "2", transferError: "" as string, transferId: 900 };
    const skrill = await stub((r) => {
      if (r.method === "POST" && r.route === "/pay") return { text: "5e281d1376d92ba789ca7f0583e045d4" };
      if (r.route === "/app/query.pl") {
        if (r.body.email !== "merchant@aurex.example" || r.body.password !== md5("api-pass")) return { status: 401, text: "401\t\tCannot login" };
        if (!state.trn) return { status: 404, text: "404\t\tTransaction not found" };
        return { text: `200\t\tOK\n${new URLSearchParams(state.trn).toString()}` };
      }
      if (r.route === "/app/pay.pl" && r.body.action === "prepare") {
        if (r.body.password !== md5("api-pass")) return { text: "<?xml version=\"1.0\"?><response><error><error_msg>CANNOT_LOGIN</error_msg></error></response>" };
        return { text: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<response><sid>7783bfa23641a627d2bb3b3d3a7d1e70</sid></response>" };
      }
      if (r.route === "/app/pay.pl" && r.body.action === "transfer") {
        if (state.transferError) return { text: `<?xml version="1.0"?><response><error><error_msg>${state.transferError}</error_msg></error></response>` };
        state.transferId++;
        return { text: `<?xml version="1.0"?><response><transaction><amount>30.00</amount><currency>EUR</currency><id>${state.transferId}</id><status>${state.transfer}</status><status_msg>processed</status_msg></transaction></response>` };
      }
      return undefined;
    });
    const made = makeApp({
      PAYMENT_RAILS: "sandbox,skrill",
      SKRILL_EMAIL: "merchant@aurex.example",
      SKRILL_SECRET_WORD: SECRET,
      SKRILL_API_PASSWORD: "api-pass",
      SKRILL_PAY_URL: `${skrill.url}/pay`,
      SKRILL_API_URL: `${skrill.url}/app`,
      ...extra,
    });
    return { ...made, skrill, state };
  }
  const notify = (fields: Record<string, string>, secret = SECRET) => {
    const sig = md5(`${fields.merchant_id}${fields.transaction_id}${md5(secret).toUpperCase()}${fields.mb_amount}${fields.mb_currency}${fields.status}`).toUpperCase();
    return new URLSearchParams({ ...fields, md5sig: sig }).toString();
  };

  it("sends the user to Quick Checkout and credits only after Skrill confirms the amount", async () => {
    const { app, ctx, skrill, state } = await setup();
    const { agent } = await signup(app, "skrill");
    const A = api(agent);
    const dep = await A.post("/api/payments/deposits", { rail: "skrill", amount: "25", currency: "EUR" });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBe(`${skrill.url}/pay?sid=5e281d1376d92ba789ca7f0583e045d4`);
    const prep = skrill.calls.find((c) => c.route === "/pay")!.body;
    expect(prep).toMatchObject({ pay_to_email: "merchant@aurex.example", transaction_id: dep.body.transfer.id, amount: "25.00", currency: "EUR", prepare_only: "1" });
    expect(prep.status_url).toBe("http://localhost:5173/api/webhooks/skrill");
    expect(prep.return_url).toContain(`ref=${dep.body.transfer.id}`);

    const base = { pay_to_email: "merchant@aurex.example", merchant_id: "6999381", transaction_id: dep.body.transfer.id, mb_amount: "25", mb_currency: "EUR", status: "2", currency: "EUR", amount: "25.00" };
    // A forged notification is refused outright.
    const forged = await request(app).post("/api/webhooks/skrill").set("content-type", "application/x-www-form-urlencoded").send(notify(base, "guess"));
    expect(forged.status).toBe(400);
    // A genuine one only triggers a query; Skrill's record doesn't show it yet, so nothing is credited.
    await request(app).post("/api/webhooks/skrill").set("content-type", "application/x-www-form-urlencoded").send(notify(base));
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBeUndefined();

    state.trn = { status: "2", transaction_id: dep.body.transfer.id, currency: "EUR", amount: "25.00", mb_amount: "25", mb_currency: "EUR", merchant_id: "6999381" };
    const ok = await request(app).post("/api/webhooks/skrill").set("content-type", "application/x-www-form-urlencoded").send(notify(base));
    expect(ok.text).toBe("OK");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("25.00");

    // Skrill's record says less was paid: refused.
    const dep2 = await A.post("/api/payments/deposits", { rail: "skrill", amount: "80", currency: "EUR" });
    state.trn = { status: "2", transaction_id: dep2.body.transfer.id, currency: "EUR", amount: "8.00" };
    expect((await A.post(`/api/payments/transfers/${dep2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("without an API password, settles from the verified notification", async () => {
    const { app } = await setup({ SKRILL_API_PASSWORD: "" });
    const { agent } = await signup(app, "skrill");
    const A = api(agent);
    const dep = await A.post("/api/payments/deposits", { rail: "skrill", amount: "40", currency: "USD" });
    const fields = { pay_to_email: "merchant@aurex.example", merchant_id: "1", transaction_id: dep.body.transfer.id, mb_amount: "36.5", mb_currency: "EUR", status: "2", currency: "USD", amount: "40.00" };
    await request(app).post("/api/webhooks/skrill").set("content-type", "application/x-www-form-urlencoded").send(notify(fields));
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("40.00");
    expect((await A.get("/api/meta")).body.rails.find((r: { id: string }) => r.id === "skrill").supportsWithdrawal).toBe(false);
  });

  it("pays out to a Skrill account and refunds failed payouts", async () => {
    const { app, ctx, skrill, state } = await setup();
    const A = await fundedUser(app, "skrill", "EUR", "200");
    const dest = { type: "email", name: "Ama B", email: "ama@skrill.example" };
    const w = await A.post("/api/payments/withdrawals", { rail: "skrill", amount: "30", currency: "EUR", destination: dest });
    expect(w.status).toBe(201);
    expect(w.body.transfer.status).toBe("completed");
    expect(skrill.calls.find((c) => c.body?.action === "prepare")!.body).toMatchObject({
      email: "merchant@aurex.example",
      password: md5("api-pass"),
      amount: "30.00",
      currency: "EUR",
      bnf_email: "ama@skrill.example",
      frn_trn_id: w.body.transfer.id,
    });
    expect(skrill.calls.find((c) => c.body?.action === "transfer")!.body.sid).toBe("7783bfa23641a627d2bb3b3d3a7d1e70");

    // Recipient not registered yet: scheduled, then processed.
    state.transfer = "1";
    const w2 = await A.post("/api/payments/withdrawals", { rail: "skrill", amount: "20", currency: "EUR", destination: dest });
    expect(w2.body.transfer.status).toBe("pending");
    state.trn = { status: "2", mb_transaction_id: String(state.transferId) };
    expect((await A.post(`/api/payments/transfers/${w2.body.transfer.id}/refresh`)).body.transfer.status).toBe("completed");

    state.transferError = "BALANCE_NOT_ENOUGH";
    const w3 = await A.post("/api/payments/withdrawals", { rail: "skrill", amount: "50", currency: "EUR", destination: dest });
    expect(w3.body.error.code).toBe("payout_failed");
    expect(w3.body.error.message).toMatch(/BALANCE_NOT_ENOUGH/);
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("150.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("MoneyGram cash pickup rail", () => {
  async function setup() {
    const state = { status: "AVAILABLE", seq: 0 };
    const mg = await stub((r) => {
      if (r.route === "/oauth/accesstoken") {
        const ok = r.query.get("grant_type") === "client_credentials" && r.headers.authorization === `Basic ${Buffer.from("mg-id:mg-secret").toString("base64")}`;
        return ok ? { body: { access_token: "mg-token", expires_in: "3599", token_type: "BearerToken" } } : { status: 401, body: { error: "invalid_client" } };
      }
      if (r.headers.authorization !== "Bearer mg-token") return { status: 401, body: { errors: [{ code: "401", message: "Unauthorized" }] } };
      if (r.method === "POST" && r.route === "/disbursement/v1/transactions/quote") {
        state.seq++;
        return { body: { transactions: [{ transactionId: `mg-tx-${state.seq}`, serviceOptionCode: "WILL_CALL", serviceOptionName: "10 Minute Service", receiveAmount: { total: { value: 302000, currencyCode: "NGN" }, fxRate: 1510 } }] } };
      }
      const upd = /^\/disbursement\/v1\/transactions\/(mg-tx-\d+)$/.exec(r.route);
      if (r.method === "PUT" && upd) {
        if (r.body.receiver?.name?.lastName === "Blocked") return { status: 400, body: { errors: [{ category: "TA", code: "4041", message: "Receiver failed compliance screening", offendingField: "receiver.name" }] } };
        return { body: { readyForCommit: true, transactionId: upd[1] } };
      }
      const com = /^\/disbursement\/v1\/transactions\/(mg-tx-\d+)\/commit$/.exec(r.route);
      if (r.method === "PUT" && com) return { body: { referenceNumber: `8${com[1].slice(-1)}412345`, partnerTransactionId: r.body.partnerTransactionId, expectedPayoutDate: "2026-11-16" } };
      if (/^\/status\/v1\/transactions\/mg-tx-\d+$/.test(r.route)) return { body: { transactionStatus: state.status, transactionSubStatus: [] } };
      return undefined;
    });
    const made = makeApp({ PAYMENT_RAILS: "sandbox,moneygram", MONEYGRAM_CLIENT_ID: "mg-id", MONEYGRAM_CLIENT_SECRET: "mg-secret", MONEYGRAM_PARTNER_ID: "30150519", MONEYGRAM_BASE_URL: mg.url });
    return { ...made, mg, state };
  }

  it("quotes, validates the recipient, commits and returns a pickup reference", async () => {
    const { app, ctx, mg, state } = await setup();
    const A = await fundedUser(app, "mgram", "USD", "1000");
    const dest = { type: "cash_pickup", name: "Chidi Okafor", firstName: "Chidi", lastName: "Okafor", country: "NG" };

    expect((await A.post("/api/payments/withdrawals", { rail: "moneygram", amount: "50", currency: "EUR", destination: dest })).body.error.message).toMatch(/doesn't support EUR/);
    expect((await A.post("/api/payments/withdrawals", { rail: "moneygram", amount: "50", currency: "USD", destination: { ...dest, country: undefined } })).status).toBe(400);

    const w = await A.post("/api/payments/withdrawals", { rail: "moneygram", amount: "200", currency: "USD", destination: dest });
    expect(w.status).toBe(201);
    expect(w.body.transfer.status).toBe("pending");
    expect(w.body.transfer.payoutReference).toBe("81412345");
    const quote = mg.calls.find((c) => c.route.endsWith("/quote"))!;
    expect(quote.body).toMatchObject({ agentPartnerId: "30150519", targetAudience: "AGENT_FACING", destinationCountryCode: "NGA", serviceOptionCode: "WILL_CALL", beneficiaryTypeCode: "Consumer", sendAmount: { currencyCode: "USD", value: 200 } });
    expect(quote.headers["x-mg-clientrequestid"]).toMatch(UUID);
    expect(mg.calls.find((c) => c.method === "PUT" && c.route === "/disbursement/v1/transactions/mg-tx-1")!.body.receiver).toEqual({ name: { firstName: "Chidi", middleName: "", lastName: "Okafor", secondLastName: "" } });
    expect(mg.calls.find((c) => c.route.endsWith("/commit"))!.body).toEqual({ partnerTransactionId: w.body.transfer.id });

    // Waiting for pickup, then collected.
    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("pending");
    state.status = "RECEIVED";
    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("completed");
    const statusCall = mg.calls.find((c) => c.route.startsWith("/status/"))!;
    expect(statusCall.query.get("agentPartnerId")).toBe("30150519");

    // Never collected and refunded by MoneyGram: the user gets the money back.
    state.status = "AVAILABLE";
    const w2 = await A.post("/api/payments/withdrawals", { rail: "moneygram", amount: "100", currency: "USD", destination: dest });
    state.status = "REFUNDED";
    expect((await A.post(`/api/payments/transfers/${w2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("800.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("shows MoneyGram's compliance message and refunds when the recipient is refused", async () => {
    const { app, ctx } = await setup();
    const A = await fundedUser(app, "mgram", "USD", "300");
    const res = await A.post("/api/payments/withdrawals", { rail: "moneygram", amount: "100", currency: "USD", destination: { type: "cash_pickup", name: "X Blocked", firstName: "X", lastName: "Blocked", country: "MX" } });
    expect(res.body.error.code).toBe("payout_failed");
    expect(res.body.error.message).toMatch(/compliance screening/);
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("300.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});
