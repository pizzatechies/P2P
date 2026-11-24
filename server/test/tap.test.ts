import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { nowIso, run } from "../src/db/index.js";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

const WEBHOOK = "whsec_main_test";

async function setup(extra: Record<string, string> = {}) {
  const intents = new Map<string, { id: string; status: string; client_secret: string }>();
  const stripe = await stub((req) => {
    if (req.method === "POST" && req.route === "/v1/terminal/connection_tokens") return { body: { secret: "pst_test_secret" } };
    if (req.method === "POST" && req.route === "/v1/payment_intents") {
      const id = `pi_${intents.size + 1}`;
      const pi = { id, status: "requires_payment_method", client_secret: `${id}_secret_x` };
      intents.set(id, pi);
      return { body: pi };
    }
    const m = /^\/v1\/payment_intents\/(pi_\d+)(\/cancel)?$/.exec(req.route);
    if (m && intents.has(m[1])) {
      const pi = intents.get(m[1])!;
      if (m[2]) pi.status = "canceled";
      return { body: pi };
    }
    return undefined;
  });
  const env = makeApp({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_BASE_URL: `${stripe.url}/v1`, STRIPE_WEBHOOK_SECRET: WEBHOOK, TAP_TO_PAY: "true", STRIPE_TERMINAL_LOCATION: "tml_test", TAP_TO_PAY_FEE_BPS: "250", ...extra });
  const u = await signup(env.app, "shop");
  return { ...env, stripe, intents, u, A: api(u.agent) };
}
const makeMerchant = (ctx: ReturnType<typeof makeApp>["ctx"], userId: string) =>
  run(ctx.db, "INSERT INTO business_profiles (user_id, business_name, category, country, status, created_at, updated_at) VALUES (?, 'Wanjiku Fabrics', 'retail', 'KE', 'approved', ?, ?)", userId, nowIso(), nowIso());

function stripeEvent(app: ReturnType<typeof makeApp>["app"], type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: "evt_1", type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", WEBHOOK).update(`${t}.${body}`).digest("hex");
  return request(app).post("/api/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", `t=${t},v1=${sig}`).send(body);
}

describe("Tap to Pay for businesses", () => {
  it("is only for approved businesses", async () => {
    const { A } = await setup();
    expect((await A.get("/api/tap")).body).toMatchObject({ available: true, merchant: false });
    expect((await A.post("/api/tap/payments", { amount: "10", currency: "USD" })).status).toBe(422);
    expect((await A.post("/api/tap/connection-token")).status).toBe(422);
    const off = makeApp();
    const B = api((await signup(off.app, "notap")).agent);
    expect((await B.get("/api/tap")).body.available).toBe(false);
  });

  it("creates a card-present payment, and credits the business when Stripe confirms it", async () => {
    const { A, app, ctx, u, stripe, intents } = await setup();
    makeMerchant(ctx, u.user.id);
    expect((await A.get("/api/tap")).body).toMatchObject({ merchant: true, locationId: "tml_test", simulated: true, feeBps: 250 });
    expect((await A.post("/api/tap/connection-token")).body).toEqual({ secret: "pst_test_secret" });
    expect(stripe.calls[0].body).toMatchObject({ location: "tml_test" });

    const p = await A.post("/api/tap/payments", { amount: "40", currency: "USD", note: "Kitenge" });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ status: "pending", amount: "40.00", fee: "1.00", clientSecret: "pi_1_secret_x", paymentIntentId: "pi_1" });
    const sent = stripe.calls.find((c) => c.route === "/v1/payment_intents")!.body as Record<string, string>;
    expect(sent).toMatchObject({ amount: "4000", currency: "usd", "payment_method_types[0]": "card_present", capture_method: "automatic" });
    expect(sent["metadata[aurex_tap_payment]"]).toBe(p.body.id);

    // The phone says it's done; Aurex asks Stripe, which says it isn't yet.
    expect((await A.get(`/api/tap/payments/${p.body.id}`)).body.status).toBe("pending");
    // Stripe confirms through the webhook: 40 less 2.5% lands in the wallet, once.
    intents.get("pi_1")!.status = "succeeded";
    await stripeEvent(app, "payment_intent.succeeded", { id: "pi_1", status: "succeeded", metadata: { aurex_tap_payment: p.body.id } });
    await stripeEvent(app, "payment_intent.succeeded", { id: "pi_1", status: "succeeded", metadata: { aurex_tap_payment: p.body.id } });
    expect((await A.get(`/api/tap/payments/${p.body.id}`)).body.status).toBe("succeeded");
    const usd = (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD");
    expect(usd.balance).toBe("39.00");
    expect((await A.get("/api/payments/activity")).body.items[0]).toMatchObject({ kind: "card_sale", direction: "in" });
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("confirms by asking Stripe when the phone checks, and cancels", async () => {
    const { A, ctx, u, intents } = await setup();
    makeMerchant(ctx, u.user.id);
    const p = await A.post("/api/tap/payments", { amount: "12.50", currency: "USD" });
    intents.get("pi_1")!.status = "succeeded";
    expect((await A.get(`/api/tap/payments/${p.body.id}`)).body.status).toBe("succeeded");

    const q = await A.post("/api/tap/payments", { amount: "5", currency: "USD" });
    expect((await A.post(`/api/tap/payments/${q.body.id}/cancel`)).body.status).toBe("canceled");
    const tap = (await A.get("/api/tap")).body.recent;
    expect(tap.map((t: { status: string }) => t.status)).toEqual(["canceled", "succeeded"]);
  });
});
