import request from "supertest";
import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/services/ledger.js";
import { mpesaCallbackToken } from "../src/services/rails/index.js";
import { darajaTimestamp } from "../src/services/rails/mpesa.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

type Bal = { currency: string; balance: string }[];
const bal = (b: Bal, c: string) => b.find((x) => x.currency === c)?.balance;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Signs up a user and gives them test money through the sandbox rail. */
async function fundedUser(app: ReturnType<typeof makeApp>["app"], name: string, currency: string, amount: string) {
  const { agent } = await signup(app, name);
  const A = api(agent);
  const dep = await A.post("/api/payments/deposits", { rail: "sandbox", amount, currency });
  expect(dep.body.transfer.status).toBe("completed");
  return A;
}

// ---------------------------------------------------------------------------
describe("M-Pesa (Daraja) rail", () => {
  async function setup() {
    const state = { stk: "processing" as "processing" | "ok" | "cancelled", b2c: 0 };
    const daraja = await stub((r) => {
      if (r.route === "/oauth/v1/generate") {
        const ok = r.headers.authorization === `Basic ${Buffer.from("ck:cs").toString("base64")}` && r.query.get("grant_type") === "client_credentials";
        return ok ? { body: { access_token: "darajatoken", expires_in: "3599" } } : { status: 401, body: { errorMessage: "Invalid credentials" } };
      }
      if (r.headers.authorization !== "Bearer darajatoken") return { status: 401, body: { errorCode: "404.001.03", errorMessage: "Invalid Access Token" } };
      if (r.route === "/mpesa/stkpush/v1/processrequest") {
        return { body: { MerchantRequestID: "29115-1", CheckoutRequestID: "ws_CO_191220191020363925", ResponseCode: "0", ResponseDescription: "Success. Request accepted for processing", CustomerMessage: "Success. Request accepted for processing" } };
      }
      if (r.route === "/mpesa/stkpushquery/v1/query") {
        if (state.stk === "processing") return { status: 500, body: { requestId: "x", errorCode: "500.001.1001", errorMessage: "The transaction is being processed" } };
        return { body: { ResponseCode: "0", MerchantRequestID: "29115-1", CheckoutRequestID: r.body.CheckoutRequestID, ResultCode: state.stk === "ok" ? "0" : "1032", ResultDesc: state.stk === "ok" ? "The service request is processed successfully." : "Request cancelled by user" } };
      }
      if (r.route === "/mpesa/b2c/v3/paymentrequest") {
        state.b2c++;
        return { body: { ConversationID: `AG_20240706_${state.b2c}`, OriginatorConversationID: r.body.OriginatorConversationID, ResponseCode: "0", ResponseDescription: "Accept the service request successfully." } };
      }
      return undefined;
    });
    const made = makeApp({
      PAYMENT_RAILS: "sandbox,mpesa",
      MPESA_CONSUMER_KEY: "ck",
      MPESA_CONSUMER_SECRET: "cs",
      MPESA_SHORTCODE: "174379",
      MPESA_PASSKEY: "passkey",
      MPESA_INITIATOR_NAME: "testapi",
      MPESA_SECURITY_CREDENTIAL: "c2VjdXJpdHk=",
      MPESA_B2C_SHORTCODE: "600992",
      MPESA_BASE_URL: daraja.url,
    });
    return { ...made, daraja, state, token: mpesaCallbackToken(made.ctx) };
  }
  const stkCallback = (checkoutId: string, code: number) => JSON.stringify({ Body: { stkCallback: { MerchantRequestID: "29115-1", CheckoutRequestID: checkoutId, ResultCode: code, ResultDesc: "..." } } });

  it("collects with STK Push and credits only after the query API confirms", async () => {
    const { app, ctx, daraja, state, token } = await setup();
    const { agent } = await signup(app, "mpesa");
    const A = api(agent);

    const rails = (await A.get("/api/meta")).body.rails ?? [];
    const meta = rails.find((r: { id: string }) => r.id === "mpesa");
    if (meta) expect(meta).toMatchObject({ depositInput: "phone", payoutInput: "phone", currencies: ["KES"] });

    expect((await A.post("/api/payments/deposits", { rail: "mpesa", amount: "100", currency: "KES" })).body.error.message).toMatch(/Safaricom number/);
    expect((await A.post("/api/payments/deposits", { rail: "mpesa", amount: "100.50", currency: "KES", phone: "0712345678" })).body.error.message).toMatch(/whole shillings/);

    const dep = await A.post("/api/payments/deposits", { rail: "mpesa", amount: "100", currency: "KES", phone: "0712 345 678" });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBeNull();
    expect(dep.body.instructions).toMatch(/M-Pesa PIN/);
    const push = daraja.calls.find((c) => c.route === "/mpesa/stkpush/v1/processrequest")!;
    expect(push.body).toMatchObject({ BusinessShortCode: "174379", TransactionType: "CustomerPayBillOnline", Amount: 100, PartyA: "254712345678", PartyB: "174379", PhoneNumber: "254712345678" });
    expect(Buffer.from(push.body.Password, "base64").toString()).toBe(`174379passkey${push.body.Timestamp}`);
    expect(push.body.Timestamp).toMatch(/^\d{14}$/);
    expect(push.body.CallBackURL).toBe(`http://localhost:5173/api/webhooks/mpesa/${token}/stk`);

    // A callback on the wrong URL is ignored; on the right one it only triggers a query.
    expect((await request(app).post("/api/webhooks/mpesa/not-the-secret/stk").set("content-type", "application/json").send(stkCallback("ws_CO_191220191020363925", 0))).status).toBe(404);
    await request(app).post(`/api/webhooks/mpesa/${token}/stk`).set("content-type", "application/json").send(stkCallback("ws_CO_191220191020363925", 0));
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("pending"); // query says still processing
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBeUndefined();

    state.stk = "ok";
    const cb = await request(app).post(`/api/webhooks/mpesa/${token}/stk`).set("content-type", "application/json").send(stkCallback("ws_CO_191220191020363925", 0));
    expect(cb.body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("completed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("100.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("marks a cancelled prompt as failed", async () => {
    const { app, state } = await setup();
    const { agent } = await signup(app, "mpesa");
    const A = api(agent);
    const dep = await A.post("/api/payments/deposits", { rail: "mpesa", amount: "50", currency: "KES", phone: "254712345678" });
    state.stk = "cancelled";
    expect((await A.post(`/api/payments/transfers/${dep.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
  });

  it("pays out with B2C and settles or refunds from the signed-URL result callback", async () => {
    const { app, ctx, daraja, token } = await setup();
    const A = await fundedUser(app, "mpesa", "KES", "1000");
    const dest = { type: "mobile_money", name: "Wanjiku M", accountNumber: "0712345678" };

    const w = await A.post("/api/payments/withdrawals", { rail: "mpesa", amount: "300", currency: "KES", destination: dest });
    expect(w.status).toBe(201);
    expect(w.body.transfer.status).toBe("pending");
    expect(w.body.transfer.destination.accountLast4).toBe("5678");
    const b2c = daraja.calls.find((c) => c.route === "/mpesa/b2c/v3/paymentrequest")!;
    expect(b2c.body).toMatchObject({
      OriginatorConversationID: w.body.transfer.id,
      InitiatorName: "testapi",
      SecurityCredential: "c2VjdXJpdHk=",
      CommandID: "BusinessPayment",
      Amount: 300,
      PartyA: "600992",
      PartyB: "254712345678",
      ResultURL: `http://localhost:5173/api/webhooks/mpesa/${token}/b2c/result`,
      QueueTimeOutURL: `http://localhost:5173/api/webhooks/mpesa/${token}/b2c/timeout`,
    });
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("700.00");

    const result = (id: string, conv: string, code: number) =>
      JSON.stringify({ Result: { ResultType: 0, ResultCode: code, ResultDesc: code ? "The initiator information is invalid." : "The service request is processed successfully.", OriginatorConversationID: id, ConversationID: conv, TransactionID: "SG632NMUAB" } });

    // Wrong secret, or a conversation id that doesn't match the one Safaricom gave us: ignored.
    expect((await request(app).post("/api/webhooks/mpesa/guess/b2c/result").set("content-type", "application/json").send(result(w.body.transfer.id, "AG_20240706_1", 0))).status).toBe(404);
    await request(app).post(`/api/webhooks/mpesa/${token}/b2c/result`).set("content-type", "application/json").send(result(w.body.transfer.id, "AG_forged", 0));
    expect((await A.get(`/api/payments/transfers/${w.body.transfer.id}`)).body.transfer.status).toBe("pending");

    await request(app).post(`/api/webhooks/mpesa/${token}/b2c/result`).set("content-type", "application/json").send(result(w.body.transfer.id, "AG_20240706_1", 0));
    expect((await A.get(`/api/payments/transfers/${w.body.transfer.id}`)).body.transfer.status).toBe("completed");

    const w2 = await A.post("/api/payments/withdrawals", { rail: "mpesa", amount: "200", currency: "KES", destination: dest });
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("500.00");
    await request(app).post(`/api/webhooks/mpesa/${token}/b2c/result`).set("content-type", "application/json").send(result(w2.body.transfer.id, "AG_20240706_2", 2001));
    const failed = (await A.get(`/api/payments/transfers/${w2.body.transfer.id}`)).body.transfer;
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/initiator information/);
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("700.00"); // refunded

    // Invalid number: refused and refunded straight away.
    const bad = await A.post("/api/payments/withdrawals", { rail: "mpesa", amount: "10", currency: "KES", destination: { ...dest, accountNumber: "12345" } });
    expect(bad.body.error.code).toBe("payout_failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("700.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("formats Daraja timestamps in Nairobi time", () => {
    expect(darajaTimestamp(Date.UTC(2026, 0, 31, 22, 5, 9))).toBe("20260201010509");
  });
});

// ---------------------------------------------------------------------------
describe("MTN MoMo rail", () => {
  async function setup() {
    const state: { collect: Record<string, any>; transfer: Record<string, any>; mode: { collect: string; transfer: string; amount?: string } } = {
      collect: {},
      transfer: {},
      mode: { collect: "PENDING", transfer: "PENDING" },
    };
    const momo = await stub((r) => {
      for (const product of ["collection", "disbursement"] as const) {
        const sub = product === "collection" ? "col-sub" : "dis-sub";
        if (r.route === `/${product}/token/`) {
          const basic = Buffer.from(product === "collection" ? "col-user:col-key" : "dis-user:dis-key").toString("base64");
          if (r.headers.authorization !== `Basic ${basic}` || r.headers["ocp-apim-subscription-key"] !== sub) return { status: 401, body: { message: "bad" } };
          return { body: { access_token: `${product}-token`, token_type: "access_token", expires_in: 3600 } };
        }
        if (r.route.startsWith(`/${product}/v1_0/`) && (r.headers.authorization !== `Bearer ${product}-token` || r.headers["x-target-environment"] !== "sandbox" || r.headers["ocp-apim-subscription-key"] !== sub)) {
          return { status: 401, body: { code: "UNAUTHORIZED" } };
        }
      }
      if (r.method === "POST" && r.route === "/collection/v1_0/requesttopay") {
        state.collect[String(r.headers["x-reference-id"])] = r.body;
        return { status: 202 };
      }
      if (r.method === "POST" && r.route === "/disbursement/v1_0/transfer") {
        state.transfer[String(r.headers["x-reference-id"])] = r.body;
        return { status: 202 };
      }
      const c = /^\/collection\/v1_0\/requesttopay\/(.+)$/.exec(r.route);
      if (c && state.collect[c[1]]) {
        const sent = state.collect[c[1]];
        return { body: { amount: state.mode.amount ?? sent.amount, currency: sent.currency, externalId: sent.externalId, payer: sent.payer, status: state.mode.collect } };
      }
      const t = /^\/disbursement\/v1_0\/transfer\/(.+)$/.exec(r.route);
      if (t && state.transfer[t[1]]) {
        const sent = state.transfer[t[1]];
        return { body: { amount: sent.amount, currency: sent.currency, externalId: sent.externalId, payee: sent.payee, status: state.mode.transfer, ...(state.mode.transfer === "FAILED" ? { reason: "PAYEE_NOT_FOUND" } : {}) } };
      }
      return undefined;
    });
    const made = makeApp({
      PAYMENT_RAILS: "sandbox,mtn-momo",
      MTN_MOMO_BASE_URL: momo.url,
      MTN_MOMO_CURRENCY: "EUR",
      MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY: "col-sub",
      MTN_MOMO_COLLECTION_USER_ID: "col-user",
      MTN_MOMO_COLLECTION_API_KEY: "col-key",
      MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: "dis-sub",
      MTN_MOMO_DISBURSEMENT_USER_ID: "dis-user",
      MTN_MOMO_DISBURSEMENT_API_KEY: "dis-key",
    });
    return { ...made, momo, state };
  }

  it("requests payment on the phone and checks amount, currency and status before crediting", async () => {
    const { app, ctx, momo, state } = await setup();
    const { agent } = await signup(app, "momo");
    const A = api(agent);
    expect((await A.post("/api/payments/deposits", { rail: "mtn-momo", amount: "25", currency: "KES", phone: "46733123453" })).body.error.message).toMatch(/doesn't support KES/);

    const dep = await A.post("/api/payments/deposits", { rail: "mtn-momo", amount: "25", currency: "EUR", phone: "+46 733 123 453" });
    expect(dep.status).toBe(201);
    expect(dep.body.instructions).toMatch(/MoMo PIN/);
    const sent = momo.calls.find((c) => c.route === "/collection/v1_0/requesttopay")!;
    expect(sent.headers["x-reference-id"]).toMatch(UUID);
    expect(sent.headers["x-callback-url"]).toBeUndefined(); // only sent for https callback URLs
    expect(sent.body).toEqual({
      amount: "25",
      currency: "EUR",
      externalId: dep.body.transfer.id,
      payer: { partyIdType: "MSISDN", partyId: "46733123453" },
      payerMessage: "Aurex wallet top-up",
      payeeNote: "Aurex wallet top-up",
    });

    // The callback only triggers a status read; still PENDING means nothing moves.
    await request(app).put("/api/webhooks/mtn-momo").set("content-type", "application/json").send(JSON.stringify({ externalId: dep.body.transfer.id, status: "SUCCESSFUL" }));
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("pending");

    state.mode.collect = "SUCCESSFUL";
    await request(app).put("/api/webhooks/mtn-momo").set("content-type", "application/json").send(JSON.stringify({ externalId: dep.body.transfer.id, status: "SUCCESSFUL" }));
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("completed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("25.00");

    // MoMo reports less than was requested: refused.
    const dep2 = await A.post("/api/payments/deposits", { rail: "mtn-momo", amount: "40", currency: "EUR", phone: "46733123453" });
    state.mode.amount = "4";
    expect((await A.post(`/api/payments/transfers/${dep2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("25.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("disburses to a MoMo wallet and refunds failed transfers", async () => {
    const { app, ctx, momo, state } = await setup();
    const A = await fundedUser(app, "momo", "EUR", "100");
    const dest = { type: "mobile_money", name: "Kwame A", accountNumber: "46733123450" };

    const w = await A.post("/api/payments/withdrawals", { rail: "mtn-momo", amount: "30", currency: "EUR", destination: dest });
    expect(w.body.transfer.status).toBe("pending");
    const sent = momo.calls.find((c) => c.route === "/disbursement/v1_0/transfer")!;
    expect(sent.body).toMatchObject({ amount: "30", currency: "EUR", externalId: w.body.transfer.id, payee: { partyIdType: "MSISDN", partyId: "46733123450" } });
    state.mode.transfer = "SUCCESSFUL";
    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("completed");

    state.mode.transfer = "PENDING";
    const w2 = await A.post("/api/payments/withdrawals", { rail: "mtn-momo", amount: "20", currency: "EUR", destination: dest });
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("50.00");
    state.mode.transfer = "FAILED";
    expect((await A.post(`/api/payments/transfers/${w2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("70.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("PayPal rail", () => {
  async function setup() {
    const state = { order: "PAYER_ACTION_REQUIRED", captureAmount: null as string | null, payout: "PENDING", captures: 0 };
    const orders = new Map<string, any>();
    let batches = 0;
    const pp = await stub((r) => {
      if (r.route === "/v1/oauth2/token") {
        const ok = r.headers.authorization === `Basic ${Buffer.from("pp-id:pp-secret").toString("base64")}` && r.body?.grant_type === "client_credentials";
        return ok ? { body: { access_token: "pp-token", token_type: "Bearer", expires_in: 32400 } } : { status: 401, body: { error: "invalid_client" } };
      }
      if (r.headers.authorization !== "Bearer pp-token") return { status: 401, body: { name: "AUTHENTICATION_FAILURE" } };
      const unit = (sent: any) => ({
        reference_id: sent.purchase_units[0].reference_id,
        custom_id: sent.purchase_units[0].custom_id,
        ...(state.order === "COMPLETED"
          ? { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: sent.purchase_units[0].amount.currency_code, value: state.captureAmount ?? sent.purchase_units[0].amount.value } }] } }
          : {}),
      });
      if (r.method === "POST" && r.route === "/v2/checkout/orders") {
        const id = `ORDER${orders.size + 1}`;
        orders.set(id, r.body);
        return { status: 200, body: { id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: "x" }, { rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] } };
      }
      const o = /^\/v2\/checkout\/orders\/(ORDER\d+)(\/capture)?$/.exec(r.route);
      if (o && orders.has(o[1])) {
        if (r.method === "GET") return { body: { id: o[1], status: state.order, purchase_units: [unit(orders.get(o[1]))] } };
        if (state.order !== "APPROVED") return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] } };
        state.captures++;
        state.order = "COMPLETED";
        return { status: 201, body: { id: o[1], status: "COMPLETED", purchase_units: [unit(orders.get(o[1]))] } };
      }
      if (r.method === "POST" && r.route === "/v1/payments/payouts") {
        batches++;
        return { status: 201, body: { batch_header: { payout_batch_id: `BATCH${batches}`, batch_status: "PENDING", sender_batch_header: r.body.sender_batch_header } } };
      }
      const b = /^\/v1\/payments\/payouts\/(BATCH\d+)$/.exec(r.route);
      if (b) return { body: { batch_header: { payout_batch_id: b[1], batch_status: "SUCCESS" }, items: [{ transaction_status: state.payout }] } };
      return undefined;
    });
    const made = makeApp({ PAYMENT_RAILS: "sandbox,paypal", PAYPAL_CLIENT_ID: "pp-id", PAYPAL_CLIENT_SECRET: "pp-secret", PAYPAL_BASE_URL: pp.url });
    return { ...made, pp, state, order: (id = "ORDER1") => orders.get(id) };
  }

  it("sends the user to PayPal, captures after approval and checks the captured amount", async () => {
    const { app, ctx, pp, state, order } = await setup();
    const { agent } = await signup(app, "paypal");
    const A = api(agent);
    const dep = await A.post("/api/payments/deposits", { rail: "paypal", amount: "40", currency: "USD" });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");
    const create = pp.calls.find((c) => c.route === "/v2/checkout/orders")!;
    expect(create.headers["paypal-request-id"]).toBe(`order-${dep.body.transfer.id}`);
    expect(order()).toMatchObject({ intent: "CAPTURE", purchase_units: [{ custom_id: dep.body.transfer.id, amount: { currency_code: "USD", value: "40.00" } }] });
    expect(order().payment_source.paypal.experience_context.return_url).toBe(`http://localhost:5173/app/wallet?deposit=return&ref=${dep.body.transfer.id}`);

    // Back from PayPal without approving: still pending, nothing captured.
    expect((await A.post(`/api/payments/transfers/${dep.body.transfer.id}/refresh`)).body.transfer.status).toBe("pending");
    expect(state.captures).toBe(0);

    // Approval arrives by webhook: Aurex captures, then credits.
    state.order = "APPROVED";
    await request(app).post("/api/webhooks/paypal").set("content-type", "application/json").send(JSON.stringify({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER1" } }));
    expect(state.captures).toBe(1);
    expect(pp.calls.find((c) => c.route.endsWith("/capture"))!.headers["paypal-request-id"]).toBe(`capture-${dep.body.transfer.id}`);
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("completed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("40.00");

    // A capture for less than the order is refused.
    state.order = "APPROVED";
    state.captureAmount = "4.00";
    const dep2 = await A.post("/api/payments/deposits", { rail: "paypal", amount: "60", currency: "USD" });
    expect((await A.post(`/api/payments/transfers/${dep2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("40.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("pays out to PayPal and Venmo, refunding returned payouts", async () => {
    const { app, ctx, pp, state } = await setup();
    const A = await fundedUser(app, "paypal", "USD", "500");

    expect((await A.post("/api/payments/withdrawals", { rail: "paypal", amount: "10", currency: "USD", destination: { type: "email", name: "Sam" } })).status).toBe(400);

    const w = await A.post("/api/payments/withdrawals", { rail: "paypal", amount: "120", currency: "USD", destination: { type: "email", name: "Sam Lee", email: "sam@example.com", wallet: "paypal" } });
    expect(w.status).toBe(201);
    expect(w.body.transfer.destination.accountLast4).toBe("s•••@example.com");
    const sent = pp.calls.find((c) => c.route === "/v1/payments/payouts")!;
    expect(sent.body.sender_batch_header.sender_batch_id).toBe(w.body.transfer.id);
    expect(sent.body.items[0]).toMatchObject({ recipient_type: "EMAIL", receiver: "sam@example.com", amount: { value: "120.00", currency: "USD" }, recipient_wallet: "PAYPAL", sender_item_id: w.body.transfer.id });

    state.payout = "UNCLAIMED";
    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("pending");
    state.payout = "SUCCESS";
    await request(app).post("/api/webhooks/paypal").set("content-type", "application/json")
      .send(JSON.stringify({ event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: "BATCH1", payout_item: { sender_item_id: w.body.transfer.id } } }));
    expect((await A.get(`/api/payments/transfers/${w.body.transfer.id}`)).body.transfer.status).toBe("completed");

    // Venmo is USD-only.
    const venmoEur = await A.post("/api/payments/withdrawals", { rail: "paypal", amount: "5", currency: "EUR", destination: { type: "email", name: "Sam Lee", email: "+1 415 555 0100", wallet: "venmo" } });
    expect(venmoEur.body.error.message).toMatch(/EUR|Venmo/);

    state.payout = "PENDING";
    const v = await A.post("/api/payments/withdrawals", { rail: "paypal", amount: "30", currency: "USD", destination: { type: "email", name: "Sam Lee", email: "+1 415 555 0100", wallet: "venmo" } });
    expect(pp.calls.filter((c) => c.route === "/v1/payments/payouts").at(-1)!.body.items[0]).toMatchObject({ recipient_type: "PHONE", receiver: "+14155550100", recipient_wallet: "VENMO" });
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("350.00");
    state.payout = "RETURNED";
    expect((await A.post(`/api/payments/transfers/${v.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "USD")).toBe("380.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("Wise rail", () => {
  const groups = [
    {
      type: "iban",
      title: "IBAN",
      fields: [
        { name: "Full name of the account holder", group: [{ key: "accountHolderName", name: "Full name", type: "text", required: true, refreshRequirementsOnChange: false, valuesAllowed: null }] },
        { name: "IBAN", group: [{ key: "IBAN", name: "IBAN", type: "text", required: true, refreshRequirementsOnChange: false, example: "DE89370400440532013000", validationRegexp: "^[A-Z]{2}[0-9A-Z ]+$", valuesAllowed: null }] },
        { name: "Country", group: [{ key: "address.country", name: "Country", type: "select", required: true, refreshRequirementsOnChange: true, valuesAllowed: [{ key: "DE", name: "Germany" }, { key: "US", name: "United States" }] }] },
      ],
    },
  ];
  async function setup() {
    const state = { fund: "COMPLETED", status: "processing", quotes: 0, transfers: 5004 };
    const wise = await stub((r) => {
      if (r.headers.authorization !== "Bearer wise-token") return { status: 401, body: { error: "unauthorized" } };
      if (r.route === "/profiles/42/balances" && r.query.get("types") === "STANDARD") return { body: [{ id: 1, currency: "EUR" }, { id: 2, currency: "USD" }] };
      if (r.method === "POST" && r.route === "/profiles/42/quotes") {
        state.quotes++;
        return { body: { id: `quote-${state.quotes}`, sourceCurrency: r.body.sourceCurrency, targetCurrency: r.body.targetCurrency, status: "PENDING" } };
      }
      const req = /^\/quotes\/(quote-\d+)\/account-requirements$/.exec(r.route);
      if (req) {
        if (r.method === "GET") return { body: groups };
        const withState = structuredClone(groups);
        if (r.body?.details?.address?.country === "US") {
          withState[0].fields.push({ name: "State", group: [{ key: "address.state", name: "State", type: "select", required: true, refreshRequirementsOnChange: false, valuesAllowed: [{ key: "NY", name: "New York" }] }] } as never);
        }
        return { body: withState };
      }
      if (r.method === "POST" && r.route === "/accounts") return { body: { id: 9001, currency: r.body.currency, type: r.body.type } };
      if (r.method === "POST" && r.route === "/transfers") return { body: { id: ++state.transfers, status: "incoming_payment_waiting", customerTransactionId: r.body.customerTransactionId } };
      if (r.method === "POST" && /^\/profiles\/42\/transfers\/\d+\/payments$/.test(r.route)) {
        return state.fund === "COMPLETED" ? { status: 201, body: { type: "BALANCE", status: "COMPLETED", balanceTransactionId: 1 } } : { status: 422, body: { type: "BALANCE", status: "REJECTED", errorCode: "balance.insufficient-funds" } };
      }
      if (r.method === "PUT" && /^\/transfers\/\d+\/cancel$/.test(r.route)) return { body: { status: "cancelled" } };
      if (/^\/transfers\/\d+$/.test(r.route)) return { body: { id: Number(r.route.split("/")[2]), status: state.status } };
      return undefined;
    });
    const made = makeApp({ PAYMENT_RAILS: "sandbox,wise", WISE_API_TOKEN: "wise-token", WISE_PROFILE_ID: "42", WISE_BASE_URL: wise.url });
    return { ...made, wise, state };
  }

  it("describes the payout form from Wise and refreshes it as fields change", async () => {
    const { app, wise } = await setup();
    const { agent } = await signup(app, "wise");
    const A = api(agent);
    const r1 = await A.post("/api/payments/payout-requirements", { rail: "wise", currency: "EUR", amount: "100" });
    expect(r1.status).toBe(200);
    expect(r1.body.quoteId).toBe("quote-1");
    expect(r1.body.groups[0].fields.map((f: { group: { key: string }[] }) => f.group[0].key)).toEqual(["accountHolderName", "IBAN", "address.country"]);
    const q = wise.calls.find((c) => c.route === "/profiles/42/quotes")!;
    expect(q.body).toEqual({ sourceCurrency: "EUR", targetCurrency: "EUR", targetAmount: 100, payIn: "BALANCE" }); // the profile holds EUR
    expect(wise.calls.find((c) => c.route.endsWith("/account-requirements"))!.headers["accept-minor-version"]).toBe("1");

    const r2 = await A.post("/api/payments/payout-requirements", { rail: "wise", currency: "EUR", amount: "100", quoteId: "quote-1", type: "iban", details: { accountHolderName: "Ada L", "address.country": "US" } });
    expect(r2.body.groups[0].fields.at(-1).group[0].key).toBe("address.state");
    expect(wise.calls.filter((c) => c.method === "POST" && c.route.endsWith("/account-requirements")).at(-1)!.body).toMatchObject({ type: "iban", accountHolderName: "Ada L", details: { address: { country: "US" } } });

    // A currency the profile doesn't hold is funded from USD.
    await A.post("/api/payments/payout-requirements", { rail: "wise", currency: "NGN", amount: "50000" });
    expect(wise.calls.filter((c) => c.route === "/profiles/42/quotes").at(-1)!.body).toMatchObject({ sourceCurrency: "USD", targetCurrency: "NGN", targetAmount: 50000 });
  });

  it("creates the recipient, transfer and funding, then settles from the transfer status", async () => {
    const { app, ctx, wise, state } = await setup();
    const A = await fundedUser(app, "wise", "EUR", "1000");
    const destination = { type: "wise", name: "Ada Lovelace", wiseType: "iban", details: { accountHolderName: "Ada Lovelace", IBAN: "DE89370400440532013000", "address.country": "DE" } };

    const w = await A.post("/api/payments/withdrawals", { rail: "wise", amount: "250", currency: "EUR", destination });
    expect(w.status).toBe(201);
    expect(w.body.transfer.status).toBe("pending");
    expect(w.body.transfer.destination.accountLast4).toBe("3000");
    expect(wise.calls.find((c) => c.route === "/accounts")!.body).toEqual({
      currency: "EUR",
      type: "iban",
      profile: 42,
      accountHolderName: "Ada Lovelace",
      ownedByCustomer: false,
      details: { IBAN: "DE89370400440532013000", address: { country: "DE" } },
    });
    expect(wise.calls.filter((c) => c.route === "/profiles/42/quotes").at(-1)!.body).toMatchObject({ targetAmount: 250, targetAccount: 9001 });
    const transfer = wise.calls.find((c) => c.route === "/transfers")!.body;
    expect(transfer).toMatchObject({ targetAccount: 9001, quoteUuid: "quote-1" });
    expect(transfer.customerTransactionId).toMatch(UUID);
    expect(wise.calls.find((c) => c.route === "/profiles/42/transfers/5005/payments")!.body).toEqual({ type: "BALANCE" });

    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("pending");
    state.status = "outgoing_payment_sent";
    expect((await A.post(`/api/payments/transfers/${w.body.transfer.id}/refresh`)).body.transfer.status).toBe("completed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("750.00");

    // Wise balance short of funds: the transfer is cancelled and the user refunded.
    state.fund = "REJECTED";
    const short = await A.post("/api/payments/withdrawals", { rail: "wise", amount: "100", currency: "EUR", destination });
    expect(short.body.error.code).toBe("payout_failed");
    expect(short.body.error.message).toMatch(/short of funds/);
    expect(wise.calls.some((c) => c.method === "PUT" && c.route === "/transfers/5006/cancel")).toBe(true);
    expect(bal((await A.get("/api/payments/balances")).body.balances, "EUR")).toBe("750.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("Coinbase connection", () => {
  async function setup() {
    const state = { refreshToken: "rt1", refreshes: 0, revoked: [] as string[], access: "at1" };
    const cb = await stub((r) => {
      if (r.route === "/oauth2/token") {
        if (r.body.client_id !== "cb-client" || r.body.client_secret !== "cb-secret") return { status: 401, body: { error: "invalid_client" } };
        if (r.body.grant_type === "authorization_code") {
          if (r.body.code !== "good-code" || r.body.redirect_uri !== "http://localhost:5173/api/connections/oauth/coinbase/callback") return { status: 400, body: { error: "invalid_grant", error_description: "bad code" } };
          return { body: { access_token: "at1", token_type: "bearer", expires_in: 3600, refresh_token: "rt1", scope: "wallet:accounts:read" } };
        }
        if (r.body.grant_type === "refresh_token") {
          if (r.body.refresh_token !== state.refreshToken) return { status: 401, body: { error: "invalid_grant", error_description: "refresh token already used" } };
          state.refreshes++;
          state.refreshToken = `rt${state.refreshes + 1}`;
          state.access = `at${state.refreshes + 1}`;
          return { body: { access_token: state.access, token_type: "bearer", expires_in: 3600, refresh_token: state.refreshToken } };
        }
      }
      if (r.route === "/oauth2/revoke") {
        state.revoked.push(r.body.token);
        return { body: {} };
      }
      if (r.route === "/v2/exchange-rates") return { body: { data: { currency: "USD", rates: { BTC: "0.00001", ETH: "0.0005", USD: "1.0" } } } };
      if (r.headers.authorization !== `Bearer ${state.access}`) return { status: 401, body: { errors: [{ id: "expired_token", message: "The access token expired" }] } };
      if (r.route === "/v2/user") return { body: { data: { id: "cb-user-1", name: "Satoshi", country: { code: "US", name: "United States" } } } };
      if (r.route === "/v2/accounts") {
        if (!r.query.get("starting_after")) {
          return {
            body: {
              pagination: { next_uri: "/v2/accounts?limit=100&starting_after=acc-eth" },
              data: [
                { id: "acc-btc", name: "BTC Wallet", primary: true, type: "wallet", currency: { code: "BTC", name: "Bitcoin", type: "crypto", exponent: 8 }, balance: { amount: "0.50000000", currency: "BTC" } },
                { id: "acc-eth", name: "ETH Wallet", primary: false, type: "wallet", currency: { code: "ETH", type: "crypto" }, balance: { amount: "0.00000000", currency: "ETH" } },
              ],
            },
          };
        }
        return { body: { pagination: { next_uri: null }, data: [{ id: "acc-usd", name: "Cash (USD)", type: "fiat", currency: { code: "USD", type: "fiat" }, balance: { amount: "120.50", currency: "USD" } }] } };
      }
      return undefined;
    });
    const made = makeApp({ COINBASE_CLIENT_ID: "cb-client", COINBASE_CLIENT_SECRET: "cb-secret", COINBASE_OAUTH_URL: cb.url, COINBASE_API_URL: cb.url });
    const { agent } = await signup(made.app, "coin");
    return { ...made, cb, state, A: api(agent), agent };
  }

  it("links through OAuth with a checked state, values crypto in USD and rotates refresh tokens", async () => {
    const { app, ctx, cb, state, A } = await setup();
    const start = await A.post("/api/connections/coinbase/start");
    expect(start.status).toBe(201);
    const auth = new URL(start.body.redirectUrl);
    expect(auth.pathname).toBe("/oauth2/auth");
    expect(auth.searchParams.get("client_id")).toBe("cb-client");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/connections/oauth/coinbase/callback");
    expect(auth.searchParams.get("scope")!.split(",")).toEqual(expect.arrayContaining(["wallet:accounts:read", "offline_access"]));
    const state1 = auth.searchParams.get("state")!;
    expect(state1.startsWith(`${start.body.linkId}.`)).toBe(true);

    // Coinbase redirects to the fixed callback, which forwards to the signed-in app page.
    const cbRedirect = await request(app).get(`/api/connections/oauth/coinbase/callback?code=good-code&state=${encodeURIComponent(state1)}`);
    expect(cbRedirect.status).toBe(302);
    const forwarded = new URL(cbRedirect.headers.location);
    expect(forwarded.pathname).toBe("/app/connections");
    expect(forwarded.searchParams.get("link")).toBe(start.body.linkId);
    expect(forwarded.searchParams.get("code")).toBe("good-code");

    // A state with the wrong nonce is rejected.
    const forged = await A.post(`/api/connections/links/${start.body.linkId}/complete`, { params: { code: "good-code", state: `${start.body.linkId}.wrong` } });
    expect(forged.status).toBe(502);
    expect(forged.body.error.message).toMatch(/didn't match/);

    const again = await A.post("/api/connections/coinbase/start");
    const state2 = new URL(again.body.redirectUrl).searchParams.get("state")!;
    const done = await A.post(`/api/connections/links/${again.body.linkId}/complete`, { params: { code: "good-code", state: state2 } });
    expect(done.body.status).toBe("active");

    const ov = (await A.get("/api/connections")).body;
    const conn = ov.connections[0];
    expect(conn.institution).toBe("Coinbase");
    expect(conn.accounts.map((a: { name: string }) => a.name).sort()).toEqual(["BTC Wallet", "Cash (USD)"]); // empty ETH wallet skipped, page 2 read
    const btc = conn.accounts.find((a: { currency: string }) => a.currency === "BTC");
    expect(btc).toMatchObject({ kind: "crypto", balance: 0.5, valueUsd: 50000 });
    expect(ov.netWorth).toBe(50120.5);
    expect(ov.unconvertedAccounts).toBe(0);

    // The access token expires: the next two syncs (running together) use the single-use refresh token once.
    const row = ctx.db.prepare("SELECT secret_enc FROM linked_connections WHERE id = ?").get(conn.id) as { secret_enc: string };
    const { decryptSecret, encryptSecret } = await import("../src/lib/crypto.js");
    const tokens = JSON.parse(decryptSecret(row.secret_enc, ctx.config.masterKey));
    ctx.db.prepare("UPDATE linked_connections SET secret_enc = ? WHERE id = ?").run(encryptSecret(JSON.stringify({ ...tokens, expires_at: Date.now() - 1000 }), ctx.config.masterKey), conn.id);
    const [s1, s2] = await Promise.all([A.post(`/api/connections/${conn.id}/sync`), A.post(`/api/connections/${conn.id}/sync`)]);
    expect([s1.status, s2.status]).toEqual([200, 200]);
    expect(state.refreshes).toBe(1);
    const saved = JSON.parse(decryptSecret((ctx.db.prepare("SELECT secret_enc FROM linked_connections WHERE id = ?").get(conn.id) as { secret_enc: string }).secret_enc, ctx.config.masterKey));
    expect(saved.refresh_token).toBe("rt2");

    await A.del(`/api/connections/${conn.id}`);
    expect(state.revoked).toEqual(["at2"]);
    expect(cb.calls.some((c) => c.route === "/oauth2/revoke" && c.headers.authorization === "Bearer at2")).toBe(true);
  });

  it("won't let another user finish someone else's link", async () => {
    const { app, A } = await setup();
    const start = await A.post("/api/connections/coinbase/start");
    const st = new URL(start.body.redirectUrl).searchParams.get("state")!;
    const { agent } = await signup(app, "intruder");
    const res = await api(agent).post(`/api/connections/links/${start.body.linkId}/complete`, { params: { code: "good-code", state: st } });
    expect(res.status).toBe(404);
  });
});
