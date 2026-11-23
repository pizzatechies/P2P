import request from "supertest";
import { describe, expect, it } from "vitest";
import { one } from "../src/db/index.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub, type Recorded } from "./stub.js";

/** A stand-in ntfy server: accepts JSON publishes at the root, like ntfy does. */
async function ntfy(status = 200) {
  return stub((req) => (req.method === "POST" && req.route === "/" ? { status, body: { id: "msg1", event: "message", topic: req.body?.topic } } : undefined));
}

/** Notifications are sent in the background: wait for the one we expect. */
async function waitFor(calls: Recorded[], match: (c: Recorded) => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = calls.find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no matching notification; got: ${JSON.stringify(calls.map((c) => c.body?.title))}`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("push notifications (ntfy)", () => {
  it("is off until the server has an ntfy address", async () => {
    const { app } = makeApp();
    const A = api((await signup(app, "nopush")).agent);
    const status = await A.get("/api/account/push");
    expect(status.body).toMatchObject({ available: false, enabled: false, topic: null });
    expect((await A.post("/api/account/push/enable")).status).toBe(503);
  });

  it("gives each customer a private channel, kept encrypted, and sends a test", async () => {
    const push = await ntfy();
    const { app, ctx } = makeApp({ PUSH_NTFY_URL: push.url, PUSH_NTFY_PUBLIC_URL: "https://push.aurex.example", PUSH_NTFY_TOKEN: "tk_publish" });
    const u = await signup(app, "pushy");
    const A = api(u.agent);
    expect((await A.post("/api/account/push/test")).status).toBe(422);

    const on = await A.post("/api/account/push/enable");
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(on.body.server).toBe("https://push.aurex.example");
    expect(on.body.topic).toMatch(/^aurex-[A-Za-z0-9_-]{43}$/);
    expect(on.body.subscribeLink).toBe(`ntfy://push.aurex.example/${on.body.topic}?display=Aurex`);
    expect(on.body.opens).toBe("web");
    const stored = one<{ push_topic_enc: string }>(ctx.db, "SELECT push_topic_enc FROM users WHERE id = ?", u.user.id)!.push_topic_enc;
    expect(stored).not.toContain(on.body.topic);
    // Turning it on again keeps the same channel.
    expect((await A.post("/api/account/push/enable")).body.topic).toBe(on.body.topic);

    const test = await A.post("/api/account/push/test");
    expect(test.body.sent).toBe(true);
    const sent = push.calls.at(-1)!;
    expect(sent.headers.authorization).toBe("Bearer tk_publish");
    expect(sent.body).toMatchObject({ topic: on.body.topic, title: "Aurex notifications work", click: "http://localhost:5173/app" });
  });

  it("tells people when money arrives, requests come in and get paid, and money moves in or out", async () => {
    const push = await ntfy();
    const { app } = makeApp({ PUSH_NTFY_URL: push.url });
    const a = await signup(app, "sender");
    const b = await signup(app, "receiver");
    const A = api(a.agent);
    const B = api(b.agent);
    const topicA = (await A.post("/api/account/push/enable")).body.topic;
    const topicB = (await B.post("/api/account/push/enable")).body.topic;

    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "200", currency: "USD" });
    const added = await waitFor(push.calls, (c) => c.body.topic === topicA && c.body.title === "Money added");
    expect(added.body.message).toBe("USD 200.00 from Sandbox (test money) is in your wallet.");

    expect((await A.post("/api/payments/send", { to: `@${b.user.handle}`, amount: "25.50", currency: "USD", memo: "Dinner" })).status).toBe(201);
    const got = await waitFor(push.calls, (c) => c.body.topic === topicB && c.body.title === "Money received");
    expect(got.body).toMatchObject({ message: `@${a.user.handle} sent you USD 25.50: Dinner`, click: "http://localhost:5173/app/wallet", priority: 3 });

    const req = await B.post("/api/payments/requests", { from: `@${a.user.handle}`, amount: "5", currency: "USD", memo: "Taxi" });
    expect(req.status).toBe(201);
    const asked = await waitFor(push.calls, (c) => c.body.topic === topicA && c.body.title === "Payment request");
    expect(asked.body.message).toBe(`@${b.user.handle} asked you for USD 5.00: Taxi`);
    expect((await A.post(`/api/payments/requests/${req.body.request.id}/pay`)).status).toBe(200);
    const paid = await waitFor(push.calls, (c) => c.body.topic === topicB && c.body.title === "Request paid");
    expect(paid.body.message).toBe(`@${a.user.handle} paid your request for USD 5.00.`);

    const dest = { type: "bank_account", name: "My bank", accountNumber: "12345678" };
    expect((await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "20", currency: "USD", destination: dest })).status).toBe(201);
    await waitFor(push.calls, (c) => c.body.topic === topicA && c.body.title === "Withdrawal sent");
    // A new payout destination is also a security alert, which is pushed as one.
    const security = await waitFor(push.calls, (c) => c.body.topic === topicA && c.body.title === "Aurex security alert");
    expect(security.body.priority).toBe(4);
    expect(security.body.click).toBe("http://localhost:5173/app/settings#security");

    const failed = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "10", currency: "USD", destination: { ...dest, accountNumber: "99990000" } });
    expect(failed.status).toBe(422);
    await waitFor(push.calls, (c) => c.body.topic === topicA && c.body.title === "Withdrawal returned");
  });

  it("respects what people want to hear about, and never lets a push failure break a payment", async () => {
    const push = await ntfy(500);
    const { app } = makeApp({ PUSH_NTFY_URL: push.url });
    const a = await signup(app, "payer");
    const b = await signup(app, "quiet");
    const A = api(a.agent);
    const B = api(b.agent);
    const topicB = (await B.post("/api/account/push/enable")).body.topic;
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "50", currency: "USD" });

    // ntfy is down: the payment still goes through.
    expect((await A.post("/api/payments/send", { to: b.user.email, amount: "1", currency: "USD" })).status).toBe(201);
    await waitFor(push.calls, (c) => c.body.topic === topicB && c.body.title === "Money received");

    expect((await B.put("/api/account/push/prefs", { payments: false })).body.prefs).toEqual({ payments: false, account: true });
    expect((await B.put("/api/account/push/prefs", { payments: "no" })).status).toBe(400);
    const before = push.calls.length;
    expect((await A.post("/api/payments/send", { to: b.user.email, amount: "1", currency: "USD" })).status).toBe(201);
    await settle();
    expect(push.calls.length).toBe(before);
    // Account messages still come through.
    expect((await B.post("/api/account/push/test")).status).toBe(200);
    await waitFor(push.calls.slice(before), (c) => c.body.topic === topicB);
  });

  it("changes the channel when someone signs out everywhere, and stops when switched off or the account closes", async () => {
    const push = await ntfy();
    const { app, ctx } = makeApp({ PUSH_NTFY_URL: push.url });
    const u = await signup(app, "rotator");
    const A = api(u.agent);
    const first = (await A.post("/api/account/push/enable")).body.topic;

    await A.post("/api/settings/sessions/revoke-others");
    const bye = await waitFor(push.calls, (c) => c.body.topic === first && c.body.title === "Set up Aurex notifications again");
    expect(bye.body.message).toContain("Settings → Notifications");
    const second = (await A.get("/api/account/push")).body.topic;
    expect(second).toMatch(/^aurex-/);
    expect(second).not.toBe(first);

    // A new link on request, too.
    const third = (await A.post("/api/account/push/reset")).body.topic;
    expect(third).not.toBe(second);
    await waitFor(push.calls, (c) => c.body.topic === second);

    const off = await A.post("/api/account/push/disable");
    expect(off.body).toMatchObject({ enabled: false, topic: null, subscribeLink: null });
    const before = push.calls.length;
    await A.post("/api/payments/deposits", { rail: "sandbox", amount: "5", currency: "USD" });
    await settle();
    expect(push.calls.length).toBe(before);

    await A.post("/api/account/push/enable");
    await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "5", currency: "USD", destination: { type: "bank_account", name: "Bank", accountNumber: "12345678" } });
    expect((await A.post("/api/account/close", { confirmHandle: u.user.handle })).status).toBe(200);
    const row = one<{ push_topic_enc: string | null; push_enabled_at: string | null }>(ctx.db, "SELECT push_topic_enc, push_enabled_at FROM users WHERE id = ?", u.user.id)!;
    expect(row).toEqual({ push_topic_enc: null, push_enabled_at: null });
  });

  it("opens the Aurex app when notifications were turned on in the app", async () => {
    const push = await ntfy();
    const { app } = makeApp({ PUSH_NTFY_URL: push.url });
    const { user } = await signup(app, "appuser");
    const IOS = "capacitor://localhost";
    const login = await request(app).post("/api/auth/login").set("Origin", IOS).set("Sec-Fetch-Site", "cross-site").set("x-aurex-csrf", "1").send({ email: user.email, password: "correct-horse-42" });
    const auth = { Authorization: `Bearer ${login.body.token}`, Origin: IOS, "Sec-Fetch-Site": "cross-site", "x-aurex-csrf": "1" };
    const on = await request(app).post("/api/account/push/enable").set(auth).send({});
    expect(on.body.opens).toBe("app");
    await request(app).post("/api/account/push/test").set(auth).send({});
    const sent = await waitFor(push.calls, (c) => c.body.topic === on.body.topic);
    expect(sent.body.click).toBe("aurex://app");
  });
});
