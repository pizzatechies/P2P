import { describe, expect, it } from "vitest";
import { api, makeApp, signup } from "./helpers.js";

describe("splitting a bill", () => {
  it("asks each person for an equal share, with the organiser covering the odd cents", async () => {
    const { app } = makeApp();
    const host = await signup(app, "host");
    const b = await signup(app, "bwalya");
    const c = await signup(app, "chanda");
    const H = api(host.agent);

    // 100.00 between three people (including the host): 33.33 each, the host covers the extra cent.
    const res = await H.post("/api/payments/requests/split", { with: [`@${b.user.handle}`, c.user.email], total: "100", currency: "USD", memo: "Dinner" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ people: 3, share: "33.33", currency: "USD" });
    expect(res.body.requests.map((r: { amount: string; memo: string; payer: { handle: string } }) => [r.payer.handle, r.amount, r.memo])).toEqual([
      [b.user.handle, "33.33", "Dinner"],
      [c.user.handle, "33.33", "Dinner"],
    ]);
    const inbox = (await api(b.agent).get("/api/payments/requests")).body.incoming;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].requester.handle).toBe(host.user.handle);
  });

  it("without the organiser, the others cover the whole total", async () => {
    const { app } = makeApp();
    const host = await signup(app, "organiser");
    const b = await signup(app, "mwila");
    const c = await signup(app, "natasha");
    const res = await api(host.agent).post("/api/payments/requests/split", { with: [b.user.handle, c.user.handle], total: "10.01", currency: "USD", includeMe: false });
    expect(res.status).toBe(201);
    expect(res.body.requests.map((r: { amount: string }) => r.amount)).toEqual(["5.01", "5.00"]);
  });

  it("checks everyone first, so a bad name creates no requests", async () => {
    const { app } = makeApp();
    const host = await signup(app, "careful");
    const b = await signup(app, "mutale");
    const H = api(host.agent);
    const missing = await H.post("/api/payments/requests/split", { with: [b.user.handle, "@nobody_here"], total: "20", currency: "USD" });
    expect(missing.status).toBe(404);
    expect((await H.post("/api/payments/requests/split", { with: [b.user.handle, `@${b.user.handle}`], total: "20", currency: "USD" })).status).toBe(400);
    expect((await H.post("/api/payments/requests/split", { with: [host.user.handle], total: "20", currency: "USD" })).status).toBe(400);
    expect((await H.post("/api/payments/requests/split", { with: [], total: "20", currency: "USD" })).status).toBe(400);
    expect((await H.post("/api/payments/requests/split", { with: [b.user.handle], total: "0.01", currency: "USD" })).status).toBe(400);
    expect((await H.get("/api/payments/requests")).body.outgoing).toHaveLength(0);
  });
});
