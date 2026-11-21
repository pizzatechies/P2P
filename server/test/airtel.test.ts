import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const bal = (balances: { currency: string; balance: string }[], c: string) => balances.find((b) => b.currency === c)?.balance ?? "0.00";

async function setup(withPayouts = true) {
  const state = { collect: "TIP", payout: "TIP", payments: {} as Record<string, unknown>, disbursements: {} as Record<string, unknown> };
  const airtel = await stub((r) => {
    if (r.method === "POST" && r.route === "/auth/oauth2/token") {
      return r.body.client_id === "air-id" && r.body.client_secret === "air-secret" && r.body.grant_type === "client_credentials" ? { body: { access_token: "air-token", expires_in: "180", token_type: "bearer" } } : { status: 401, body: {} };
    }
    if (r.headers.authorization !== "Bearer air-token" || r.headers["x-country"] !== "KE" || r.headers["x-currency"] !== "KES") return { status: 401, body: { status: { success: false, message: "Unauthorized" } } };
    if (r.method === "POST" && r.route === "/merchant/v1/payments/") {
      state.payments[r.body.transaction.id] = r.body;
      return { body: { data: { transaction: { id: r.body.transaction.id, status: "Success." } }, status: { code: "200", message: "SUCCESS", result_code: "ESB000010", success: true } } };
    }
    if (r.method === "POST" && r.route === "/standard/v1/disbursements/") {
      state.disbursements[r.body.transaction.id] = r.body;
      return { body: { data: { transaction: { id: r.body.transaction.id, reference_id: "R1", airtel_money_id: "AM-1", status: state.payout } }, status: { code: "200", message: "SUCCESS", success: true } } };
    }
    const p = /^\/standard\/v1\/payments\/(.+)$/.exec(r.route);
    if (p) return { body: { data: { transaction: { id: p[1], status: state.collect, message: "Paid", airtel_money_id: "AM-9" } }, status: { success: true } } };
    const d = /^\/standard\/v1\/disbursements\/(.+)$/.exec(r.route);
    if (d) return { body: { data: { transaction: { id: d[1], status: state.payout, message: state.payout === "TF" ? "Insufficient funds" : "OK" } }, status: { success: true } } };
    return undefined;
  });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const made = makeApp({
    PAYMENT_RAILS: "sandbox,airtel",
    AIRTEL_BASE_URL: airtel.url,
    AIRTEL_CLIENT_ID: "air-id",
    AIRTEL_CLIENT_SECRET: "air-secret",
    AIRTEL_COUNTRY: "KE",
    AIRTEL_CURRENCY: "KES",
    ...(withPayouts ? { AIRTEL_DISBURSEMENT_PIN: "1234", AIRTEL_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString() } : {}),
  });
  return { ...made, airtel, state };
}

describe("Airtel Money rail", () => {
  it("pushes a PIN prompt, then credits only when Airtel confirms the transaction", async () => {
    const { app, ctx, airtel, state } = await setup();
    const rails = (await request(app).get("/api/meta")).body.rails;
    expect(rails.find((r: { id: string }) => r.id === "airtel")).toMatchObject({ name: "Airtel Money", supportsDeposit: true, supportsWithdrawal: true, currencies: ["KES"], depositInput: "phone" });

    const { agent } = await signup(app, "airtel");
    const A = api(agent);
    expect((await A.post("/api/payments/deposits", { rail: "airtel", amount: "500", currency: "USD", phone: "254733123456" })).body.error.message).toMatch(/doesn't support USD/);
    const dep = await A.post("/api/payments/deposits", { rail: "airtel", amount: "500", currency: "KES", phone: "+254 733 123 456" });
    expect(dep.status).toBe(201);
    expect(dep.body.instructions).toMatch(/Airtel Money PIN/);
    // The number goes without its country code; the transaction id is Aurex's own transfer id.
    const sent = airtel.calls.find((c) => c.route === "/merchant/v1/payments/")!;
    expect(sent.body).toEqual({
      reference: "Aurex wallet top-up",
      subscriber: { country: "KE", currency: "KES", msisdn: "733123456" },
      transaction: { amount: 500, country: "KE", currency: "KES", id: dep.body.transfer.id },
    });

    // A callback only triggers a check: still in progress means nothing moves.
    const callback = () => request(app).post("/api/webhooks/airtel").set("content-type", "application/json").send(JSON.stringify({ transaction: { id: dep.body.transfer.id, message: "Paid", status_code: "TS", airtel_money_id: "AM-9" } }));
    await callback();
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("pending");
    state.collect = "TS";
    await callback();
    expect((await A.get(`/api/payments/transfers/${dep.body.transfer.id}`)).body.transfer.status).toBe("completed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("500.00");

    // An expired prompt fails the deposit.
    const dep2 = await A.post("/api/payments/deposits", { rail: "airtel", amount: "100", currency: "KES", phone: "0733123456" });
    expect(airtel.calls.filter((c) => c.route === "/merchant/v1/payments/").at(-1)!.body.subscriber.msisdn).toBe("733123456");
    state.collect = "TE";
    expect((await A.post(`/api/payments/transfers/${dep2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("500.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("pays out with an encrypted PIN and refunds failed payouts", async () => {
    const { app, ctx, airtel, state } = await setup();
    const { agent } = await signup(app, "airpay");
    const A = api(agent);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "1000", currency: "KES" });
    const dest = { type: "mobile_money", name: "Wanjiru K", accountNumber: "254733000111" };

    state.payout = "TS";
    const w = await A.post("/api/payments/withdrawals", { rail: "airtel", amount: "300", currency: "KES", destination: dest });
    expect(w.body.transfer.status).toBe("completed");
    const sent = airtel.calls.find((c) => c.route === "/standard/v1/disbursements/")!;
    expect(sent.body).toMatchObject({ payee: { msisdn: "733000111" }, reference: "Aurex withdrawal", transaction: { amount: 300, id: w.body.transfer.id } });
    // The PIN never travels in the clear: it's RSA-encrypted (2048-bit key: 256 bytes, base64).
    expect(sent.body.pin).not.toContain("1234");
    expect(Buffer.from(sent.body.pin, "base64")).toHaveLength(256);

    state.payout = "TIP";
    const w2 = await A.post("/api/payments/withdrawals", { rail: "airtel", amount: "200", currency: "KES", destination: dest });
    expect(w2.body.transfer.status).toBe("pending");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("500.00");
    state.payout = "TF";
    expect((await A.post(`/api/payments/transfers/${w2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(bal((await A.get("/api/payments/balances")).body.balances, "KES")).toBe("700.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("offers deposits only until the payout PIN and key are set", async () => {
    const { app } = await setup(false);
    const rail = (await request(app).get("/api/meta")).body.rails.find((r: { id: string }) => r.id === "airtel");
    expect(rail).toMatchObject({ supportsDeposit: true, supportsWithdrawal: false });
  });
});
