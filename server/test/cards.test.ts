import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { one, run } from "../src/db/index.js";
import { releaseStaleHolds } from "../src/services/cards.js";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const SECRET = "whsec_issuing_test";

/** A stand-in for Stripe Issuing's API. */
async function issuing() {
  return stub((req) => {
    if (req.method !== "POST") return undefined;
    if (req.route === "/v1/issuing/cardholders") return { body: { id: "ich_1" } };
    if (req.route === "/v1/issuing/cards") return { body: { id: "ic_1", brand: "Visa", last4: "4242", exp_month: 12, exp_year: 2029 } };
    if (req.route.startsWith("/v1/issuing/cards/")) return { body: { id: req.route.split("/").pop(), status: (req.body as Record<string, string>).status } };
    if (req.route === "/v1/ephemeral_keys") return { body: { id: "ephkey_1", secret: "ek_test_secret" } };
    return undefined;
  });
}

async function setup() {
  const stripe = await issuing();
  const env = makeApp({
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_BASE_URL: `${stripe.url}/v1`,
    STRIPE_PUBLISHABLE_KEY: "pk_test_x",
    CARD_ISSUING: "true",
    STRIPE_ISSUING_WEBHOOK_SECRET: SECRET,
  });
  const u = await signup(env.app, "cardholder");
  const A = api(u.agent);
  return { ...env, stripe, u, A };
}

/** Sends a signed Stripe Issuing event, as Stripe would. */
function event(app: ReturnType<typeof makeApp>["app"], type: string, object: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return request(app).post("/api/webhooks/stripe-issuing").set("Content-Type", "application/json").set("Stripe-Signature", `t=${t},v1=${sig}`).send(body);
}
const ask = (app: ReturnType<typeof makeApp>["app"], id: string, amount: number, merchant = "Java House", extra: Record<string, unknown> = {}) =>
  event(app, "issuing_authorization.request", { id, card: { id: "ic_1" }, amount: 0, approved: false, status: "pending", pending_request: { amount, currency: "usd" }, merchant_data: { name: merchant, city: "Nairobi", country: "KE" }, ...extra });

const usd = async (A: ReturnType<typeof api>) => (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD")?.balance;
const holds = (ctx: ReturnType<typeof makeApp>["ctx"]) => one<{ balance: number }>(ctx.db, "SELECT balance FROM accounts WHERE owner_type = 'system' AND code = 'card_holds' AND currency = 'USD'")?.balance ?? 0;

describe("Aurex cards", () => {
  it("needs a verified identity, then issues a virtual card on Stripe Issuing", async () => {
    const { A, ctx, u, stripe } = await setup();
    const before = await A.get("/api/cards");
    expect(before.body).toMatchObject({ available: true, currency: "USD", card: null });
    expect(before.body.blockers.join(" ")).toContain("Verify your identity");
    const refused = await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true });
    expect(refused.status).toBe(422);

    run(ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
    expect((await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE" })).status).toBe(400); // terms not accepted
    const made = await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true });
    expect(made.status).toBe(201);
    expect(made.body.card).toMatchObject({ brand: "Visa", last4: "4242", expMonth: 12, expYear: 2029, currency: "USD", status: "active", design: "gold" });
    // Gold or Black: switch any time.
    expect((await A.put(`/api/cards/${made.body.card.id}/design`, { design: "black" })).body.card.design).toBe("black");
    expect((await A.put(`/api/cards/${made.body.card.id}/design`, { design: "platinum" })).status).toBe(400);
    const holder = stripe.calls.find((c) => c.route === "/v1/issuing/cardholders")!.body as Record<string, string>;
    expect(holder).toMatchObject({ type: "individual", name: "Amina Wanjiku", "billing[address][country]": "KE", "individual[first_name]": "Amina", "individual[last_name]": "Wanjiku" });
    expect(holder["individual[card_issuing][user_terms_acceptance][date]"]).toMatch(/^\d+$/);
    expect(stripe.calls.find((c) => c.route === "/v1/issuing/cards")!.body).toMatchObject({ cardholder: "ich_1", currency: "usd", type: "virtual" });
    expect((await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true })).status).toBe(422); // one at a time

    // The card number is shown in Stripe's own fields: Aurex only hands out a short-lived key.
    const key = await A.post(`/api/cards/${made.body.card.id}/key`, { nonce: "nonce_abcdefgh" });
    expect(key.body).toMatchObject({ ephemeralKeySecret: "ek_test_secret", providerCardId: "ic_1", publishableKey: "pk_test_x" });
    const ek = stripe.calls.find((c) => c.route === "/v1/ephemeral_keys")!;
    expect(ek.body).toMatchObject({ issuing_card: "ic_1", nonce: "nonce_abcdefgh" });
    expect(ek.headers["stripe-version"]).toBe("2025-03-31.basil");
  });

  it("approves payments the wallet can cover, holds them, and settles, refunds and releases them", async () => {
    const { A, app, ctx, u } = await setup();
    run(ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    const card = (await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", design: "black", acceptTerms: true })).body.card;
    expect(card.design).toBe("black");

    // Approved: answered in the response, with the Stripe-Version header.
    const ok = await ask(app, "iauth_1", 1250);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ approved: true });
    expect(ok.headers["stripe-version"]).toBe("2025-03-31.basil");
    expect(await usd(A)).toBe("87.50");
    expect(holds(ctx)).toBe(1250);
    // Stripe retries the same request: same answer, held once.
    expect((await ask(app, "iauth_1", 1250)).body).toEqual({ approved: true });
    expect(await usd(A)).toBe("87.50");

    // Declined: more than the wallet holds.
    expect((await ask(app, "iauth_2", 50_000)).body).toEqual({ approved: false });
    expect(await usd(A)).toBe("87.50");

    // Settled for the full amount: the hold becomes the settlement, the wallet doesn't move again.
    await event(app, "issuing_transaction.created", { id: "ipi_1", type: "capture", amount: -1250, currency: "usd", card: "ic_1", authorization: "iauth_1", merchant_data: { name: "Java House" } });
    await event(app, "issuing_authorization.updated", { id: "iauth_1", card: "ic_1", status: "closed", amount: 0, approved: true });
    expect(await usd(A)).toBe("87.50");
    expect(holds(ctx)).toBe(0);

    // Approved for 20, settled for 15: the other 5 comes back when Stripe closes it.
    await ask(app, "iauth_3", 2000, "Carrefour");
    await event(app, "issuing_transaction.created", { id: "ipi_3", type: "capture", amount: -1500, currency: "usd", card: "ic_1", authorization: "iauth_3" });
    await event(app, "issuing_transaction.created", { id: "ipi_3", type: "capture", amount: -1500, currency: "usd", card: "ic_1", authorization: "iauth_3" }); // retried
    await event(app, "issuing_authorization.updated", { id: "iauth_3", card: "ic_1", status: "closed", amount: 0, approved: true });
    expect(await usd(A)).toBe("72.50");
    expect(holds(ctx)).toBe(0);

    // A refund comes back to the wallet.
    await event(app, "issuing_transaction.created", { id: "ipi_4", type: "refund", amount: 500, currency: "usd", card: "ic_1", merchant_data: { name: "Carrefour" } });
    expect(await usd(A)).toBe("77.50");

    // The shop cancels before settling: everything held goes back.
    await ask(app, "iauth_5", 800, "Uber");
    expect(await usd(A)).toBe("69.50");
    await event(app, "issuing_authorization.updated", { id: "iauth_5", card: "ic_1", status: "reversed", amount: 0, approved: true });
    expect(await usd(A)).toBe("77.50");

    // A partial reversal while still pending holds only what's left.
    await ask(app, "iauth_6", 1000, "Hotel");
    await event(app, "issuing_authorization.updated", { id: "iauth_6", card: "ic_1", status: "pending", amount: 600, approved: true });
    expect(await usd(A)).toBe("71.50");

    const overview = await A.get("/api/cards");
    expect(overview.body.activity.map((a: { id: string; status: string }) => `${a.id}:${a.status}`)).toEqual(["iauth_6:pending", "iauth_5:reversed", "iauth_3:closed", "iauth_2:declined", "iauth_1:closed"]);
    expect(overview.body.activity.find((a: { id: string }) => a.id === "iauth_2").declineReason).toBe("insufficient_funds");
    const activity = (await A.get("/api/payments/activity")).body.items;
    expect(activity.find((i: { kind: string }) => i.kind === "card_hold")).toMatchObject({ direction: "out" });
    expect(verifyLedger(ctx).ok).toBe(true);
    expect(card.status).toBe("active");
  });

  it("declines on a frozen card or account, and only unfreezes after the password", async () => {
    const { A, app, ctx, u, stripe } = await setup();
    run(ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "50", currency: "USD" });
    const card = (await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true })).body.card;

    const frozen = await A.post(`/api/cards/${card.id}/freeze`);
    expect(frozen.body.card.status).toBe("frozen");
    expect(stripe.calls.at(-1)).toMatchObject({ route: "/v1/issuing/cards/ic_1", body: { status: "inactive" } });
    expect((await ask(app, "iauth_f", 100)).body).toEqual({ approved: false });
    expect((await A.post(`/api/cards/${card.id}/unfreeze`)).body.card.status).toBe("active");
    expect((await ask(app, "iauth_g", 100)).body).toEqual({ approved: true });

    // A daily card limit the customer sets.
    await A.put(`/api/cards/${card.id}/limit`, { daily: "5" });
    expect((await ask(app, "iauth_h", 450)).body).toEqual({ approved: false });

    run(ctx.db, "UPDATE users SET status = 'frozen' WHERE id = ?", u.user.id);
    expect((await ask(app, "iauth_i", 100)).body).toEqual({ approved: false });
    // Unknown cards and bad signatures.
    expect((await event(app, "issuing_authorization.request", { id: "iauth_x", card: { id: "ic_other" }, pending_request: { amount: 100, currency: "usd" } })).body).toEqual({ approved: false });
    expect((await event(app, "issuing_authorization.request", { id: "iauth_y", card: { id: "ic_1" } }, "whsec_wrong")).status).toBe(400);
  });

  it("tells the customer when the card is added to a phone wallet, and releases stale holds", async () => {
    const { A, app, ctx, u } = await setup();
    run(ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "30", currency: "USD" });
    await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true });

    await event(app, "issuing_token.created", { id: "intok_1", card: "ic_1", status: "active", wallet_provider: "apple_pay", network_data: { device: { name: "Amina's iPhone" } } });
    await event(app, "issuing_token.updated", { id: "intok_1", card: "ic_1", status: "active", wallet_provider: "apple_pay" });
    const overview = await A.get("/api/cards");
    expect(overview.body.wallets).toEqual([expect.objectContaining({ wallet: "apple_pay", status: "active", device: "Amina's iPhone" })]);
    const alerts = (await A.get("/api/settings/security")).body.alerts.filter((a: { kind: string }) => a.kind === "card_wallet");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("added to Apple Pay on Amina's iPhone");

    // A wallet payment is labelled as such.
    await ask(app, "iauth_w", 300, "Naivas", { wallet: "apple_pay" });
    expect((await A.get("/api/cards")).body.activity[0].wallet).toBe("apple_pay");
    // Never settled or reversed: after 31 days it goes back to the wallet.
    expect(await usd(A)).toBe("27.00");
    expect(releaseStaleHolds(ctx, Date.now() + 32 * 24 * 3600_000)).toBe(1);
    expect(await usd(A)).toBe("30.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("is off unless switched on, and closing the account cancels the card", async () => {
    const off = makeApp();
    const B = api((await signup(off.app, "nocard")).agent);
    expect((await B.get("/api/cards")).body).toMatchObject({ available: false, card: null });

    const { A, ctx, u, stripe } = await setup();
    run(ctx.db, "UPDATE users SET kyc_level = 2 WHERE id = ?", u.user.id);
    await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", acceptTerms: true });
    expect((await A.post("/api/account/close", { confirmHandle: u.user.handle })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(one<{ status: string }>(ctx.db, "SELECT status FROM cards WHERE user_id = ?", u.user.id)!.status).toBe("canceled");
    expect(stripe.calls.at(-1)).toMatchObject({ route: "/v1/issuing/cards/ic_1", body: { status: "canceled" } });
  });
});
