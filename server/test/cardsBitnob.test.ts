import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { all, nowIso, one, run } from "../src/db/index.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { splitPhone } from "../src/services/cardIssuers/bitnob.js";
import { uploadDocument } from "../src/services/kyc.js";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const CLIENT_ID = "bn_client_test";
const CLIENT_SECRET = "bn_secret_test";
const WEBHOOK_SECRET = "bn_webhook_test";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 1)]);

/** A stand-in for Bitnob's card API, answering with the shapes in its docs. `issuer.balance` is the card's balance there (micro-units). */
async function bitnobStub(opts: { kyc?: "approved" | "pending"; fund?: "completed" | "pending" } = {}) {
  const issuer = { balance: 0, status: "active" };
  const server = await stub((req) => {
    const ok = (data: unknown) => ({ body: { success: true, message: "ok", data, timestamp: new Date().toISOString() } });
    if (req.method === "POST" && req.route === "/api/cards/kyc") return ok({ customer_id: "cus_1", status: opts.kyc ?? "approved", normalized_status: opts.kyc ?? "approved" });
    if (req.method === "POST" && req.route === "/api/cards") {
      issuer.balance = req.body.amount;
      return ok({ card: { id: "bncard_1", status: "pending", created_status: "processing", card_brand: req.body.card_brand, balance_amount: String(req.body.amount), reference: req.body.reference } });
    }
    if (req.method === "GET" && req.route === "/api/cards/bncard_1") return ok({ card: { id: "bncard_1", status: issuer.status, last_four_digit: "7725", card_brand: "visa", balance_amount: String(issuer.balance) } });
    if (req.method === "GET" && req.route === "/api/cards/bncard_1/secure") return ok({ details: { card_id: "bncard_1", card_number: "4111111111117725", cvv: "123", expiry_month: "11", expiry_year: "2029" } });
    if (req.method === "POST" && req.route === "/api/cards/bncard_1/balance") {
      const status = req.body.type === "fund" ? (opts.fund ?? "completed") : "completed";
      if (status === "completed") issuer.balance += req.body.type === "fund" ? req.body.amount : -req.body.amount;
      return ok({ success: status === "completed", transaction: { id: `tx_${req.body.reference}`, type: req.body.type, status, amount: String(req.body.amount), reference: req.body.reference } });
    }
    if (req.method === "POST" && req.route === "/api/cards/bncard_1/status") {
      issuer.status = req.body.status;
      return ok({ card: { id: "bncard_1", status: req.body.status } });
    }
    if (req.method === "DELETE" && req.route === "/api/cards/bncard_1") {
      issuer.status = "terminated";
      return ok({ card: { id: "bncard_1", status: "pending_termination" } });
    }
    if (req.method === "GET" && req.route === "/api/cards/kyc/occupations") return ok({ occupations: [{ code: "15-1132", description: "Software Developers, Applications" }] });
    return undefined;
  });
  return { ...server, issuer };
}

async function setup(opts: Parameters<typeof bitnobStub>[0] = {}) {
  const bn = await bitnobStub(opts);
  const env = makeApp({ CARD_ISSUING: "bitnob", BITNOB_BASE_URL: bn.url, BITNOB_CLIENT_ID: CLIENT_ID, BITNOB_CLIENT_SECRET: CLIENT_SECRET, BITNOB_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const u = await signup(env.app, "bnholder");
  const A = api(u.agent);
  // A fully verified Kenyan customer, with their ID photos on file.
  const now = nowIso();
  const data = {
    legalName: "Amina Wanjiku Otieno",
    dateOfBirth: "1994-03-08",
    nationality: "KE",
    phone: "+254 712 345 678",
    address: { line1: "12 Moi Avenue", city: "Nairobi", country: "KE" },
    idType: "national_id",
    idNumber: "32145678",
    idCountry: "KE",
  };
  run(env.ctx.db, "INSERT INTO kyc_submissions (id, user_id, level, status, data_enc, submitted_at, reviewed_at, created_at, updated_at) VALUES (?, ?, 1, 'approved', ?, ?, ?, ?, ?)", "kyc_t1", u.user.id, encryptSecret(JSON.stringify(data), env.ctx.config.masterKey), now, now, now, now);
  uploadDocument(env.ctx, u.user.id, "id_front", PNG);
  uploadDocument(env.ctx, u.user.id, "id_back", PNG);
  run(env.ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
  await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
  return { ...env, bn, u, A };
}

const application = {
  name: "Amina Wanjiku",
  line1: "12 Moi Avenue",
  city: "Nairobi",
  state: "Nairobi County",
  postalCode: "00100",
  country: "KE",
  phone: "+254 712 345 678",
  design: "gold",
  acceptTerms: true,
  occupation: "15-1132",
  employmentStatus: "employed",
  yearlyIncomeUsd: 24000,
  monthlySpendUsd: 500,
  purpose: "online shopping and subscriptions",
  openingAmount: "20",
};

/** Sends a webhook signed the way Bitnob signs them. */
function hook(app: ReturnType<typeof makeApp>["app"], event: string, data: Record<string, unknown>, secret = WEBHOOK_SECRET, eventId = `evt_${Math.random().toString(36).slice(2)}`) {
  const body = JSON.stringify({ event, event_id: eventId, data });
  const sig = createHmac("sha512", secret).update(body).digest("hex");
  return request(app).post("/api/webhooks/bitnob").set("Content-Type", "application/json").set("x-bitnob-signature", sig).send(body);
}
const usd = async (A: ReturnType<typeof api>) => (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD")?.balance;
const sys = (ctx: ReturnType<typeof makeApp>["ctx"], code: string) => one<{ balance: number }>(ctx.db, "SELECT balance FROM accounts WHERE owner_type = 'system' AND code = ? AND currency = 'USD'", code)?.balance ?? 0;

describe("Aurex cards on Bitnob (prepaid, for Africa)", () => {
  it("needs Bitnob's credentials and US dollars", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CARD_ISSUING: "bitnob" })).toThrow(/BITNOB_CLIENT_ID/);
    const keys = { NODE_ENV: "test", CARD_ISSUING: "bitnob", BITNOB_CLIENT_ID: "x", BITNOB_CLIENT_SECRET: "y", BITNOB_WEBHOOK_SECRET: "z" };
    expect(() => loadConfig({ ...keys, CARD_CURRENCY: "KES" })).toThrow(/USD/);
    expect(loadConfig(keys)).toMatchObject({ cardIssuer: "bitnob", cardMinKycLevel: 2 });
  });

  it("splits phone numbers into the dialling code and the number", () => {
    expect(splitPhone("+254 712 345 678", "KE")).toEqual({ dialCode: "+254", phone: "712345678" });
    expect(splitPhone("0712 345678", "KE")).toEqual({ dialCode: "+254", phone: "712345678" });
    expect(splitPhone("+234 803 555 0101", "NG")).toEqual({ dialCode: "+234", phone: "8035550101" });
    expect(splitPhone("+44 7700 900123", "KE")).toBeNull();
  });

  it("applies with the customer's verified details, loads the card from the wallet, and keeps the books with Bitnob's balance", async () => {
    const { app, ctx, A, bn } = await setup();
    expect((await A.get("/api/cards")).body).toMatchObject({ available: true, prefunded: true, fees: { issue: "1.00", loadMin: "1.00", loadBps: 100 }, card: null });
    expect((await A.get("/api/cards/occupations")).body.occupations[0].code).toBe("15-1132");

    // Missing the issuer's questions: refused before anything moves.
    expect((await A.post("/api/cards", { ...application, occupation: undefined })).status).toBe(400);
    expect((await A.post("/api/cards", { ...application, yearlyIncomeUsd: 100, monthlySpendUsd: 500 })).body.error.message).toMatch(/yearly income/);
    expect(await usd(A)).toBe("100.00");

    const applied = await A.post("/api/cards", application);
    expect(applied.status).toBe(201);
    // $20 on the card, plus $1 for the card and $1 for loading it (Bitnob's fees, passed on).
    expect(await usd(A)).toBe("78.00");
    expect(applied.body.application).toMatchObject({ status: "creating", opening: "20.00" });

    // What went to Bitnob: signed requests, the verified identity, alpha-3 country, micro-units.
    const kyc = bn.calls.find((c) => c.route === "/api/cards/kyc")!;
    const ts = String(kyc.headers["x-auth-timestamp"]);
    const nonce = String(kyc.headers["x-auth-nonce"]);
    expect(kyc.headers["x-auth-client"]).toBe(CLIENT_ID);
    expect(kyc.headers["x-auth-signature"]).toBe(createHmac("sha256", CLIENT_SECRET).update(`${CLIENT_ID}:${ts}:${nonce}:${JSON.stringify(kyc.body)}`).digest("hex"));
    expect(kyc.body.customer).toMatchObject({ first_name: "Amina Wanjiku", last_name: "Otieno", date_of_birth: "1994-03-08", id_type: "national_id", id_number: "32145678", phone_number: "712345678", dial_code: "+254", country: "KEN", state: "Nairobi County", postal_code: "00100" });
    expect(kyc.body).toMatchObject({ occupation: "15-1132", employment_status: "employed", annual_salary: "24000", expected_monthly_volume: "500", terms_of_service_accepted: true });
    expect(kyc.body.id_front_image).toMatch(/^data:image\/png;base64,/);
    const created = bn.calls.find((c) => c.route === "/api/cards" && c.method === "POST")!;
    expect(created.body).toMatchObject({ card_type: "virtual", currency: "USD", card_brand: "visa", amount: 20_000_000, customer_id: "cus_1", contactless_payment: true });
    expect(created.body.webhook_url).toMatch(/\/api\/webhooks\/bitnob$/);

    // Unsigned or wrongly signed webhooks are refused.
    expect((await hook(app, "virtualcard.created.completed", { id: "bncard_1", reference: created.body.reference }, "wrong")).status).toBe(401);
    // Bitnob confirms the card: it's ready, with $20 on it.
    expect((await hook(app, "virtualcard.created.completed", { id: "bncard_1", reference: created.body.reference, status: "active", lastFour: "7725", cardBrand: "visa" })).status).toBe(200);
    const view = (await A.get("/api/cards")).body;
    expect(view.card).toMatchObject({ brand: "Visa", last4: "7725", status: "active", prefunded: true, balance: "20.00" });
    expect(view.application).toBeNull();
    expect(sys(ctx, "card_funding")).toBe(2000);
    expect(sys(ctx, "fees")).toBe(200);

    // Details come from Bitnob for the cardholder only.
    const details = (await A.post(`/api/cards/${view.card.id}/key`, {})).body;
    expect(details).toMatchObject({ provider: "bitnob", number: "4111111111117725", cvc: "123", expMonth: 11, expYear: 2029 });

    // Load $30 more: $31 leaves the wallet, the card shows $50.
    expect((await A.post(`/api/cards/${view.card.id}/load`, { amount: "30" })).body.card.balance).toBe("50.00");
    expect(await usd(A)).toBe("47.00");
    expect((await A.post(`/api/cards/${view.card.id}/load`, { amount: "1" })).status).toBe(400); // under $2

    // A purchase: the authorisation is pending, then the settlement takes it off the card's balance.
    bn.issuer.balance -= 12_500_000;
    await hook(app, "virtualcard.transaction.authorization", { cardId: "bncard_1", id: "t1", amount: 12_500_000, transaction_type: "authorization", status: "pending", merchant_name: "Java House", merchant_country: "KE" });
    let card = (await A.get("/api/cards")).body;
    expect(card.activity[0]).toMatchObject({ merchant: "Java House", amount: "12.50", status: "pending", approved: true });
    expect(card.card.balance).toBe("37.50");
    const settle = { cardId: "bncard_1", id: "t2", amount: 12_500_000, transaction_type: "settlement", status: "completed", merchant_name: "Java House" };
    await hook(app, "virtualcard.transaction.settlement", settle, WEBHOOK_SECRET, "evt_settle");
    await hook(app, "virtualcard.transaction.settlement", settle, WEBHOOK_SECRET, "evt_settle"); // delivered twice: handled once
    card = (await A.get("/api/cards")).body;
    expect(card.activity).toHaveLength(1);
    expect(card.activity[0]).toMatchObject({ merchant: "Java House", status: "closed" });
    expect(sys(ctx, "card_funding")).toBe(3750);
    expect(sys(ctx, "card_settlement")).toBe(1250);
    // The wallet isn't charged again: the money was already on the card.
    expect(await usd(A)).toBe("47.00");

    // A decline is shown, and nothing moves.
    await hook(app, "virtualcard.transaction.declined", { cardId: "bncard_1", id: "t3", amount: 900_000_000, transaction_type: "authorization_declined", status: "decline", reason: "Insufficient funds", merchant_name: "Jumia" });
    card = (await A.get("/api/cards")).body;
    expect(card.activity[0]).toMatchObject({ merchant: "Jumia", approved: false, declineReason: "Insufficient funds" });
    expect(card.card.balance).toBe("37.50");

    // Move $20 back to the wallet; the card always keeps $1.
    expect((await A.post(`/api/cards/${view.card.id}/unload`, { amount: "37.00" })).body.error.message).toMatch(/up to \$36.50/);
    expect((await A.post(`/api/cards/${view.card.id}/unload`, { amount: "20" })).body.card.balance).toBe("17.50");
    expect(await usd(A)).toBe("67.00");

    // Freeze and unfreeze go to Bitnob first; a daily limit isn't needed on a prepaid card.
    expect((await A.post(`/api/cards/${view.card.id}/freeze`, {})).body.card.status).toBe("frozen");
    expect(bn.issuer.status).toBe("frozen");
    expect((await A.post(`/api/cards/${view.card.id}/load`, { amount: "5" })).body.error.message).toMatch(/Unfreeze/);
    expect((await A.put(`/api/cards/${view.card.id}/limit`, { daily: "10" })).status).toBe(422);
    await A.post(`/api/cards/${view.card.id}/unfreeze`, {});
    expect(bn.issuer.status).toBe("active");

    // An account can't be closed with money on the card.
    expect((await A.get("/api/account")).body.closureBlockers.join(" ")).toMatch(/Move the money on your Aurex card/);

    // Cancelling returns what's left on the card to the wallet.
    const cancelled = await A.post(`/api/cards/${view.card.id}/cancel`, {});
    expect(cancelled.body.card).toBeNull();
    expect(await usd(A)).toBe("84.50");
    expect(sys(ctx, "card_funding")).toBe(0);
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("waits for the issuer's identity check, and returns the money if the card can't be made", async () => {
    const { app, ctx, A, bn } = await setup({ kyc: "pending" });
    const applied = await A.post("/api/cards", application);
    expect(applied.body.application).toMatchObject({ status: "kyc_pending" });
    expect(bn.calls.some((c) => c.route === "/api/cards" && c.method === "POST")).toBe(false);
    expect((await A.post("/api/cards", application)).body.error.code).toBe("card_pending"); // one at a time
    expect(await usd(A)).toBe("78.00");

    // Bitnob approves: the card is requested.
    await hook(app, "virtualcard.user.kyc.complete", { customerId: "cus_1", kycPassed: true });
    const created = bn.calls.find((c) => c.route === "/api/cards" && c.method === "POST")!;
    expect((await A.get("/api/cards")).body.application.status).toBe("creating");
    // ...but creation fails: everything comes back, fees included.
    await hook(app, "virtualcard.created.failed", { id: "bncard_1", reference: created.body.reference, status: "failed", failureReason: "Issuer unavailable" });
    const after = (await A.get("/api/cards")).body;
    expect(after.application).toMatchObject({ status: "failed" });
    expect(after.application.reason).toMatch(/Issuer unavailable/);
    expect(await usd(A)).toBe("100.00");
    expect(sys(ctx, "card_funding")).toBe(0);
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("finishes a load that Bitnob is still processing when its webhook arrives, or gives the money back", async () => {
    const { app, A, ctx } = await setup({ fund: "pending" });
    const applied = await A.post("/api/cards", application);
    const created = applied.body.application;
    expect(created.status).toBe("creating");
    const ref = all<{ id: string }>(ctx.db, "SELECT id FROM card_applications")[0].id;
    await hook(app, "virtualcard.created.completed", { id: "bncard_1", reference: ref, lastFour: "7725" });
    const cardId = (await A.get("/api/cards")).body.card.id;

    const loading = await A.post(`/api/cards/${cardId}/load`, { amount: "10" });
    expect(loading.body.pendingFunding).toMatchObject({ type: "fund", amount: "10.00" });
    expect(loading.body.card.balance).toBe("20.00");
    expect((await A.post(`/api/cards/${cardId}/load`, { amount: "10" })).body.error.code).toBe("card_busy");
    const f1 = one<{ id: string }>(ctx.db, "SELECT id FROM card_fundings WHERE status = 'pending'")!.id;
    await hook(app, "virtualcard.topup.completed", { cardId: "bncard_1", id: "tx1", amount: 10_000_000, reference: f1, status: "completed" });
    expect((await A.get("/api/cards")).body.card.balance).toBe("30.00");

    await A.post(`/api/cards/${cardId}/load`, { amount: "5" });
    expect(await usd(A)).toBe("61.00");
    const f2 = one<{ id: string }>(ctx.db, "SELECT id FROM card_fundings WHERE status = 'pending'")!.id;
    await hook(app, "virtualcard.topup.failed", { cardId: "bncard_1", id: "tx2", amount: 5_000_000, reference: f2, status: "failed", reason: "Company balance too low" });
    expect((await A.get("/api/cards")).body.card.balance).toBe("30.00");
    expect(await usd(A)).toBe("67.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});
