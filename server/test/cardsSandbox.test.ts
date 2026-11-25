import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { one } from "../src/db/index.js";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";

const luhnOk = (n: string) =>
  n
    .split("")
    .reverse()
    .reduce((sum, ch, i) => {
      let d = Number(ch);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      return sum + d;
    }, 0) % 10 === 0;

const usd = async (A: ReturnType<typeof api>) => (await A.get("/api/payments/balances")).body.balances.find((b: { currency: string }) => b.currency === "USD")?.balance;

describe("Test cards (CARD_ISSUING=sandbox)", () => {
  it("are only allowed on a test-money server, and need no identity check by default", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CARD_ISSUING: "sandbox", PAYMENT_RAILS: "sandbox,stripe", STRIPE_SECRET_KEY: "sk_test_x" })).toThrow(/test-money/);
    expect(loadConfig({ NODE_ENV: "test", CARD_ISSUING: "sandbox", PAYMENT_RAILS: "sandbox" })).toMatchObject({ cardIssuer: "sandbox", cardMinKycLevel: 0 });
    expect(loadConfig({ NODE_ENV: "test", CARD_ISSUING: "sandbox", PAYMENT_RAILS: "sandbox", CARD_MIN_KYC_LEVEL: "1" }).cardMinKycLevel).toBe(1);
    expect(loadConfig({ NODE_ENV: "test", CARD_ISSUING: "true", STRIPE_SECRET_KEY: "sk_test_x" })).toMatchObject({ cardIssuer: "stripe", cardMinKycLevel: 2 });
    expect(loadConfig({ NODE_ENV: "test" }).cardIssuer).toBeNull();
  });

  it("issue a test card with a valid test number, and take test payments through the real checks", async () => {
    const { app, ctx } = makeApp({ CARD_ISSUING: "sandbox", PAYMENT_RAILS: "sandbox" });
    const u = await signup(app, "testcard");
    const A = api(u.agent);
    const before = await A.get("/api/cards");
    expect(before.body).toMatchObject({ available: true, issuer: "sandbox", blockers: [], card: null });

    const made = await A.post("/api/cards", { name: "Amina Wanjiku", line1: "12 Moi Avenue", city: "Nairobi", country: "KE", design: "black", acceptTerms: true });
    expect(made.status).toBe(201);
    const card = made.body.card;
    expect(card).toMatchObject({ brand: "Visa", currency: "USD", status: "active", design: "black" });

    // The number is in the 4242 test range, passes the Luhn check, matches the last 4, and stays the same.
    const details = (await A.post(`/api/cards/${card.id}/key`, {})).body;
    expect(details).toMatchObject({ sandbox: true, expMonth: card.expMonth, expYear: card.expYear });
    expect(details.number).toMatch(/^424242\d{10}$/);
    expect(luhnOk(details.number)).toBe(true);
    expect(details.number.slice(-4)).toBe(card.last4);
    expect(details.cvc).toMatch(/^\d{3}$/);
    expect((await A.post(`/api/cards/${card.id}/key`, {})).body.number).toBe(details.number);
    const row = one<{ provider: string }>(ctx.db, "SELECT provider FROM cards WHERE id = ?", card.id)!;
    expect(row.provider).toBe("sandbox");

    // Not enough money: declined, and nothing moves.
    const broke = await A.post(`/api/cards/${card.id}/test-payment`, { amount: "4.50", merchant: "Java House", city: "Nairobi", country: "KE" });
    expect(broke.body).toMatchObject({ approved: false });
    expect(broke.body.message).toMatch(/enough in your wallet/);

    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "50", currency: "USD" });
    const paid = await A.post(`/api/cards/${card.id}/test-payment`, { amount: "4.50", merchant: "Java House", city: "Nairobi", country: "KE", wallet: "samsung_pay" });
    expect(paid.body).toMatchObject({ approved: true, message: null });
    expect(await usd(A)).toBe("45.50");
    expect(paid.body.overview.activity[0]).toMatchObject({ merchant: "Java House", amount: "4.50", wallet: "samsung_pay", approved: true, status: "closed" });
    // Settled in full: nothing left on hold, the money is with the (pretend) shop, and the books balance.
    expect(one<{ balance: number }>(ctx.db, "SELECT balance FROM accounts WHERE owner_type = 'system' AND code = 'card_holds' AND currency = 'USD'")?.balance ?? 0).toBe(0);
    expect(one<{ balance: number }>(ctx.db, "SELECT balance FROM accounts WHERE owner_type = 'system' AND code = 'card_settlement' AND currency = 'USD'")!.balance).toBe(450);

    // The card's own limit and a freeze both decline, exactly as for a real card.
    await A.put(`/api/cards/${card.id}/limit`, { daily: "10" });
    expect((await A.post(`/api/cards/${card.id}/test-payment`, { amount: "8", merchant: "Uber" })).body.message).toMatch(/daily limit/);
    await A.post(`/api/cards/${card.id}/freeze`, {});
    expect((await A.post(`/api/cards/${card.id}/test-payment`, { amount: "1", merchant: "Uber" })).body.message).toMatch(/frozen/);
    expect(await usd(A)).toBe("45.50");
    expect(verifyLedger(ctx).ok).toBe(true);

    // Bad input is refused.
    expect((await A.post(`/api/cards/${card.id}/test-payment`, { amount: "-1", merchant: "Uber" })).status).toBe(400);
    expect((await A.post(`/api/cards/${card.id}/test-payment`, { amount: "1", merchant: "Uber", wallet: "paypal" })).status).toBe(400);
  });

  it("are refused for real cards", async () => {
    const { app } = makeApp({ CARD_ISSUING: "sandbox", PAYMENT_RAILS: "sandbox" });
    const u = await signup(app, "other");
    const A = api(u.agent);
    expect((await A.post("/api/cards/card_nope/test-payment", { amount: "1", merchant: "Uber" })).status).toBe(404);
  });
});
