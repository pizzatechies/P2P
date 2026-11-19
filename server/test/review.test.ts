import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { csvCell } from "../src/lib/csv.js";
import { verifyLedger } from "../src/services/ledger.js";
import { sendMoney, withdraw } from "../src/services/payments.js";
import { api, makeApp, signup } from "./helpers.js";

// Regression tests for findings from the November 2026 security review.

async function makeAdmin(env: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

describe("security review fixes", () => {
  it("doesn't let payments fired at the same moment get past the 24-hour limit", async () => {
    const env = makeApp();
    const a = await signup(env.app, "racer");
    const b = await signup(env.app, "payee");
    expect((await api(a.agent).post("/api/payments/deposits", { rail: "sandbox", amount: "2000", currency: "USD" })).status).toBe(201);
    env.ctx.db.prepare("UPDATE users SET limit_tx_usd = 200, limit_daily_usd = 500 WHERE id = ?").run(a.user.id);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => sendMoney(env.ctx, { senderId: a.user.id, to: b.user.handle, currency: "USD", amountMinor: 15_000 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3); // 3 x $150 = $450; a 4th would pass $500
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["limit_exceeded", "limit_exceeded", "limit_exceeded"]);
    expect(verifyLedger(env.ctx).ok).toBe(true);
  });

  it("refuses a withdrawal that reuses another payment's idempotency key", async () => {
    const env = makeApp();
    const a = await signup(env.app, "reuser");
    const b = await signup(env.app, "other");
    await api(a.agent).post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
    await sendMoney(env.ctx, { senderId: a.user.id, to: b.user.handle, currency: "USD", amountMinor: 1000, idempotencyKey: "key-12345678" });
    await expect(
      withdraw(env.ctx, { userId: a.user.id, rail: "sandbox", currency: "USD", amountMinor: 1000, idempotencyKey: "key-12345678", destination: { type: "bank_account", name: "Me", accountNumber: "12345678" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("only accepts http(s) websites for business accounts", async () => {
    const env = makeApp();
    const o = await signup(env.app, "shop");
    env.ctx.db.prepare("UPDATE users SET kyc_level = 1 WHERE id = ?").run(o.user.id);
    const O = api(o.agent);
    const shop = { businessName: "Corner Shop", category: "retail", country: "KE" };
    for (const website of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "ftp://files.example.com", "https://ok.example.com/\"onmouseover=alert(1)"]) {
      expect((await O.put("/api/account/business", { ...shop, website })).status, website).toBe(400);
    }
    expect((await O.put("/api/account/business", { ...shop, website: "https://corner.example.com/shop" })).status).toBe(200);
  });

  it("doesn't let an admin give themselves free Pro", async () => {
    const env = makeApp({ PRO_ENABLED: "true" });
    const admin = await makeAdmin(env);
    expect((await admin.A.post(`/api/admin/users/${admin.user.id}/pro`, { days: 30 })).status).toBe(403);
    const other = await signup(env.app, "tester");
    expect((await admin.A.post(`/api/admin/users/${other.user.id}/pro`, { days: 30 })).status).toBe(200);
  });

  it("keeps negative amounts as numbers in CSV exports while still neutralising formulas", () => {
    expect(csvCell("-12.50")).toBe('"-12.50"');
    expect(csvCell("-3")).toBe('"-3"');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("-1+1")).toBe('"\'-1+1"');
    expect(csvCell("+254712345678")).toBe('"\'+254712345678"');
    expect(csvCell("@SUM(A1)")).toBe('"\'@SUM(A1)"');
  });
});
