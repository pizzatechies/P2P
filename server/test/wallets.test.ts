import { describe, expect, it } from "vitest";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

describe("adding money with Apple Pay and Google Pay", () => {
  it("offers the wallets on Stripe and opens Checkout ready for them", async () => {
    const stripe = await stub((req) =>
      req.method === "POST" && req.route === "/v1/checkout/sessions" ? { body: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } } : undefined,
    );
    const { app } = makeApp({ PAYMENT_RAILS: "sandbox,stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_BASE_URL: `${stripe.url}/v1` });
    const A = api((await signup(app, "applepay")).agent);

    const meta = await A.get("/api/meta");
    expect(meta.body.rails.find((r: { id: string }) => r.id === "stripe").wallets).toEqual(["apple_pay", "google_pay"]);
    expect(meta.body.rails.find((r: { id: string }) => r.id === "sandbox").wallets).toEqual([]);

    const dep = await A.post("/api/payments/deposits", { rail: "stripe", amount: "25", currency: "USD", method: "apple_pay" });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const sent = stripe.calls[0].body as Record<string, string>;
    expect(sent["payment_method_types[0]"]).toBe("card");
    expect(sent["line_items[0][price_data][unit_amount]"]).toBe("2500");

    // A plain card top-up leaves Checkout to show every method that's switched on.
    await A.post("/api/payments/deposits", { rail: "stripe", amount: "10", currency: "USD" });
    expect((stripe.calls[1].body as Record<string, string>)["payment_method_types[0]"]).toBeUndefined();
  });

  it("opens Flutterwave straight on the chosen wallet, only where it's switched on", async () => {
    const fw = await stub((req) =>
      req.method === "POST" && req.route === "/v3/payments" ? { body: { status: "success", data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/abc" } } } : undefined,
    );
    const { app } = makeApp({ PAYMENT_RAILS: "sandbox,flutterwave", FLUTTERWAVE_SECRET_KEY: "FLWSECK_TEST-x", FLUTTERWAVE_BASE_URL: `${fw.url}/v3`, FLUTTERWAVE_WALLETS: "google_pay" });
    const A = api((await signup(app, "googlepay")).agent);
    const ok = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "1500", currency: "KES", method: "google_pay" });
    expect(ok.status).toBe(201);
    expect(fw.calls[0].body).toMatchObject({ payment_options: "googlepay", currency: "KES", amount: 1500 });

    const no = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "1500", currency: "KES", method: "apple_pay" });
    expect(no.status).toBe(400);
    expect(no.body.error.message).toContain("Apple Pay");
    expect((await A.post("/api/payments/deposits", { rail: "sandbox", amount: "5", currency: "USD", method: "google_pay" })).status).toBe(400);
    expect((await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "5", currency: "KES", method: "samsung_pay" })).status).toBe(400);
  });
});
