import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { verifyLedger } from "../src/services/ledger.js";
import { api, makeApp, signup } from "./helpers.js";

/**
 * Each provider is replaced by a local stub that answers with the shapes from its public API docs
 * and records what Aurex sent, so both directions of every integration are exercised.
 */
interface Recorded { method: string; path: string; headers: IncomingMessage["headers"]; body: any }
type Handler = (req: Recorded) => { status?: number; body: unknown } | undefined;

const servers: Server[] = [];
async function stub(handler: Handler) {
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      calls.push(rec);
      const out = handler(rec);
      if (!out) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: `stub: no route ${req.method} ${req.url}` }));
        return;
      }
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const usd = (balances: { currency: string; balance: string }[]) => balances.find((b) => b.currency === "USD")?.balance;

describe("connections hub", () => {
  it("links a demo bank, shows balances and net worth, syncs and disconnects", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "linker");
    const A = api(agent);

    const providers = (await A.get("/api/connections/providers")).body.providers;
    const byId = Object.fromEntries(providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.sandbox.configured).toBe(true);
    expect(byId.plaid.configured).toBe(false);
    expect(byId.flutterwave.kind).toBe("rail");
    expect(byId.mpesa.kind).toBe("planned");
    expect((await A.post("/api/connections/plaid/start")).body.error.code).toBe("provider_not_configured");

    const start = await A.post("/api/connections/sandbox/start");
    expect(start.status).toBe(201);
    const redirect = new URL(start.body.redirectUrl);
    expect(redirect.pathname).toBe("/connect/sandbox");
    const ret = new URL(redirect.searchParams.get("return")!);
    expect(ret.searchParams.get("callback")).toBe("sandbox");

    // Declining throws the attempt away.
    const declined = await A.post(`/api/connections/links/${start.body.linkId}/complete`, { params: { sandbox_consent: "denied" } });
    expect(declined.status).toBe(422);

    const again = await A.post("/api/connections/sandbox/start");
    const done = await A.post(`/api/connections/links/${again.body.linkId}/complete`, { params: { sandbox_bank: "zambia", sandbox_consent: "granted" } });
    expect(done.body.status).toBe("active");

    const ov = (await A.get("/api/connections")).body;
    expect(ov.connections).toHaveLength(1);
    expect(ov.connections[0]).toMatchObject({ provider: "sandbox", institution: "Demo Bank Zambia", status: "active" });
    expect(ov.connections[0].accounts).toHaveLength(3);
    expect(ov.totals).toEqual([{ currency: "ZMW", total: 43510.75 }]);
    expect(ov.baseCurrency).toBe("USD");
    expect(ov.netWorth).toBeGreaterThan(1600); // ~43,510 ZMW at the indicative 26.5 ZMW/USD
    expect(ov.netWorth).toBeLessThan(1700);
    expect(ov.pending).toHaveLength(0);

    const synced = await A.post(`/api/connections/${ov.connections[0].id}/sync`);
    expect(synced.body.accounts).toBe(3);
    const removed = await A.del(`/api/connections/${ov.connections[0].id}`);
    expect(removed.body.connections).toHaveLength(0);
  });

  it("keeps other users out of a connection", async () => {
    const { app } = makeApp();
    const a = await signup(app, "owner");
    const b = await signup(app, "snoop");
    const start = await api(a.agent).post("/api/connections/sandbox/start");
    await api(a.agent).post(`/api/connections/links/${start.body.linkId}/complete`, { params: { sandbox_bank: "us", sandbox_consent: "granted" } });
    const id = (await api(a.agent).get("/api/connections")).body.connections[0].id;
    expect((await api(b.agent).post(`/api/connections/${id}/sync`)).status).toBe(404);
    expect((await api(b.agent).del(`/api/connections/${id}`)).status).toBe(404);
    expect((await api(b.agent).post(`/api/connections/links/${start.body.linkId}/complete`, { params: {} })).status).toBe(404);
  });

  it("links a bank through Plaid Hosted Link, confirmed by the SESSION_FINISHED webhook", async () => {
    let finished = false;
    const plaid = await stub((r) => {
      if (r.path === "/link/token/create") return { body: { link_token: "link-sandbox-123", hosted_link_url: "https://hosted.plaid.test/abc", expiration: "2030-01-01T00:00:00Z", request_id: "r1" } };
      if (r.path === "/link/token/get") {
        return {
          body: {
            link_token: r.body.link_token, created_at: null, expiration: null, metadata: {}, request_id: "r2",
            link_sessions: finished
              ? [{ link_session_id: "s1", started_at: "2030-01-01T00:00:00Z", finished_at: "2030-01-01T00:01:00Z",
                  results: { item_add_results: [{ public_token: "public-sandbox-1", accounts: [], institution: { name: "Chase", institution_id: "ins_3" } }],
                    cra_item_add_results: [], cra_update_results: [], bank_income_results: [], payroll_income_results: [], document_income_results: null, cra_report_results: null } }]
              : [],
          },
        };
      }
      if (r.path === "/item/public_token/exchange") return { body: { access_token: "access-sandbox-1", item_id: "item-1", request_id: "r3" } };
      if (r.path === "/accounts/balance/get") {
        return {
          body: {
            request_id: "r4", item: { item_id: "item-1" },
            accounts: [
              { account_id: "acc-chk", name: "Plaid Checking", official_name: "Plaid Gold Standard Checking", type: "depository", subtype: "checking", mask: "0000",
                balances: { available: 100, current: 110, limit: null, iso_currency_code: "USD", unofficial_currency_code: null } },
              { account_id: "acc-cc", name: "Plaid Credit Card", official_name: null, type: "credit", subtype: "credit card", mask: "3333",
                balances: { available: null, current: 410, limit: 2000, iso_currency_code: "USD", unofficial_currency_code: null } },
            ],
          },
        };
      }
      if (r.path === "/item/remove") return { body: { request_id: "r5" } };
      return undefined;
    });
    const { app } = makeApp({ PLAID_CLIENT_ID: "client-1", PLAID_SECRET: "secret-1", PLAID_BASE_URL: plaid.url });
    const { agent, user } = await signup(app, "plaidy");
    const A = api(agent);

    const start = await A.post("/api/connections/plaid/start");
    expect(start.body.redirectUrl).toBe("https://hosted.plaid.test/abc");
    const create = plaid.calls.find((c) => c.path === "/link/token/create")!;
    expect(create.headers["plaid-client-id"]).toBe("client-1");
    expect(create.headers["plaid-secret"]).toBe("secret-1");
    expect(create.body).toMatchObject({ client_name: "Aurex", user: { client_user_id: user.id }, products: ["transactions"] });
    expect(create.body.hosted_link.completion_redirect_uri).toContain(`link=${start.body.linkId}`);
    expect(create.body.webhook).toMatch(/\/api\/webhooks\/plaid$/);

    // Back from Plaid before the session result is ready: stays pending.
    expect((await A.post(`/api/connections/links/${start.body.linkId}/complete`, { params: {} })).body.status).toBe("pending");

    finished = true;
    const hook = await request(app).post("/api/webhooks/plaid").set("content-type", "application/json")
      .send(JSON.stringify({ webhook_type: "LINK", webhook_code: "SESSION_FINISHED", link_token: "link-sandbox-123", status: "SUCCESS" }));
    expect(hook.status).toBe(200);

    const ov = (await A.get("/api/connections")).body;
    expect(ov.connections[0]).toMatchObject({ provider: "plaid", institution: "Chase", status: "active" });
    const accts = Object.fromEntries(ov.connections[0].accounts.map((a: { mask: string }) => [a.mask, a]));
    expect(accts["0000"]).toMatchObject({ name: "Plaid Gold Standard Checking", kind: "bank", balance: 110, currency: "USD" });
    expect(accts["3333"]).toMatchObject({ kind: "credit", balance: -410 }); // what's owed counts against net worth
    expect(ov.netWorth).toBe(-300);
    expect(plaid.calls.find((c) => c.path === "/item/public_token/exchange")!.body).toEqual({ public_token: "public-sandbox-1" });

    await A.del(`/api/connections/${ov.connections[0].id}`);
    expect(plaid.calls.find((c) => c.path === "/item/remove")!.body).toEqual({ access_token: "access-sandbox-1" });
  });

  it("links a bank through Salt Edge Connect", async () => {
    const se = await stub((r) => {
      if (r.method === "POST" && r.path === "/customers") return { status: 201, body: { data: { customer_id: "cust-9", identifier: r.body.data.identifier } } };
      if (r.method === "POST" && r.path === "/connections/connect") return { body: { data: { connect_url: "https://www.saltedge.test/connect?token=t", expires_at: "2030-01-01T00:00:00Z", customer_id: "cust-9" } } };
      if (r.method === "GET" && r.path === "/connections/conn-1") return { body: { data: { id: "conn-1", provider_name: "Fake Bank Simple", country_code: "XF", customer_id: "cust-9", status: "active" } } };
      if (r.method === "GET" && r.path.startsWith("/accounts?")) {
        return { body: { data: [{ id: "acc-1", connection_id: "conn-1", name: "Main account", nature: "account", balance: 1500.5, currency_code: "EUR", extra: { iban: "XF00000000001234" }, created_at: "", updated_at: "" }], meta: {} } };
      }
      if (r.method === "DELETE" && r.path === "/connections/conn-1") return { body: { data: { removed: true, id: "conn-1" } } };
      return undefined;
    });
    const { app } = makeApp({ SALTEDGE_APP_ID: "app-1", SALTEDGE_SECRET: "sec-1", SALTEDGE_BASE_URL: se.url });
    const { agent, user } = await signup(app, "salty");
    const A = api(agent);

    const start = await A.post("/api/connections/saltedge/start");
    expect(start.body.redirectUrl).toBe("https://www.saltedge.test/connect?token=t");
    const connect = se.calls.find((c) => c.path === "/connections/connect")!;
    expect(connect.headers["app-id"]).toBe("app-1");
    expect(connect.headers["secret"]).toBe("sec-1");
    expect(connect.body.data).toMatchObject({ customer_id: "cust-9", consent: { scopes: ["accounts", "transactions"] }, return_connection_id: true });
    expect(connect.body.data.attempt.return_to).toContain(`link=${start.body.linkId}`);
    expect(se.calls[0].body).toEqual({ data: { identifier: `aurex-${user.id}` } });

    const done = await A.post(`/api/connections/links/${start.body.linkId}/complete`, { params: { connection_id: "conn-1" } });
    expect(done.body.status).toBe("active");
    const ov = (await A.get("/api/connections")).body;
    expect(ov.connections[0]).toMatchObject({ institution: "Fake Bank Simple", country: "XF" });
    expect(ov.connections[0].accounts[0]).toMatchObject({ name: "Main account", balance: 1500.5, currency: "EUR", mask: "1234" });
    expect(se.calls.find((c) => c.path.startsWith("/accounts?"))!.path).toContain("customer_id=cust-9");

    // A second link reuses the same Salt Edge customer.
    await A.post("/api/connections/saltedge/start");
    expect(se.calls.filter((c) => c.path === "/customers")).toHaveLength(1);

    // An error from the widget is reported, not linked.
    const failed = await A.post("/api/connections/saltedge/start");
    const err = await A.post(`/api/connections/links/${failed.body.linkId}/complete`, { params: { error_class: "InvalidCredentials" } });
    expect(err.status).toBe(502);
    expect(err.body.error.message).toContain("InvalidCredentials");
  });

  it("links brokerages through SnapTrade", async () => {
    const snap = await stub((r) => {
      const path = r.path.split("?")[0];
      if (path === "/api/v1/snapTrade/registerUser") return { body: { userId: r.body.userId, userSecret: "user-secret-1" } };
      if (path === "/api/v1/snapTrade/login") return { body: { redirectURI: "https://app.snaptrade.test/portal?x=1", sessionId: "s1" } };
      if (path === "/api/v1/accounts") {
        return { body: [{ id: "acct-1", brokerage_authorization: "auth-1", name: "Individual", number: "12345678", institution_name: "Robinhood", created_date: "2030-01-01T00:00:00Z", sync_status: {}, balance: { total: { amount: 5230.5, currency: "USD" } } }] };
      }
      if (path === "/api/v1/snapTrade/deleteUser") return { body: { status: "deleted", detail: "ok", userId: "x" } };
      return undefined;
    });
    const { app } = makeApp({ SNAPTRADE_CLIENT_ID: "cid", SNAPTRADE_CONSUMER_KEY: "ckey", SNAPTRADE_BASE_URL: `${snap.url}/api/v1` });
    const { agent, user } = await signup(app, "brokered");
    const A = api(agent);

    const start = await A.post("/api/connections/snaptrade/start");
    expect(start.status).toBe(201);
    expect(start.body.redirectUrl).toBe("https://app.snaptrade.test/portal?x=1");
    const login = snap.calls.find((c) => c.path.startsWith("/api/v1/snapTrade/login"))!;
    expect(login.body).toMatchObject({ connectionType: "read" });
    expect(login.body.customRedirect).toContain(`link=${start.body.linkId}`);
    expect(login.path).toContain(`userId=aurex-${user.id}`);

    expect((await A.post(`/api/connections/links/${start.body.linkId}/complete`, { params: { status: "SUCCESS" } })).body.status).toBe("active");
    const ov = (await A.get("/api/connections")).body;
    expect(ov.connections[0].accounts[0]).toMatchObject({ name: "Robinhood · Individual", kind: "investment", balance: 5230.5, mask: "5678" });

    // Linking another brokerage refreshes the same SnapTrade connection instead of duplicating it.
    const second = await A.post("/api/connections/snaptrade/start");
    await A.post(`/api/connections/links/${second.body.linkId}/complete`, { params: { status: "SUCCESS" } });
    expect((await A.get("/api/connections")).body.connections).toHaveLength(1);
    expect(snap.calls.filter((c) => c.path.startsWith("/api/v1/snapTrade/registerUser"))).toHaveLength(1);
  });
});

describe("Flutterwave payment rail", () => {
  async function setup() {
    const state: { deposit: { status: string; amount: number; currency: string } | null; transfer: string; nextId: number } = { deposit: null, transfer: "NEW", nextId: 777 };
    const fw = await stub((r) => {
      const path = r.path.split("?")[0];
      if (r.method === "POST" && path === "/payments") return { body: { status: "success", message: "Hosted Link", data: { link: "https://checkout.flutterwave.test/pay/abc" } } };
      if (path === "/transactions/verify_by_reference") {
        const txRef = new URL(r.path, "http://x").searchParams.get("tx_ref");
        if (!state.deposit) return { status: 404, body: { status: "error", message: "No transaction was found for this id" } };
        return { body: { status: "success", data: { id: 1, tx_ref: txRef, ...state.deposit } } };
      }
      if (r.method === "POST" && path === "/transfers") return { body: { status: "success", message: "Transfer Queued Successfully", data: { id: state.nextId++, status: "NEW", reference: r.body.reference } } };
      const t = /^\/transfers\/(\d+)$/.exec(path);
      if (t) return { body: { status: "success", data: { id: Number(t[1]), status: state.transfer } } };
      return undefined;
    });
    const made = makeApp({ PAYMENT_RAILS: "sandbox,flutterwave", FLUTTERWAVE_SECRET_KEY: "FLWSECK_TEST-abc", FLUTTERWAVE_WEBHOOK_HASH: "hook-hash", FLUTTERWAVE_BASE_URL: fw.url });
    const { agent } = await signup(made.app, "flutter");
    return { ...made, A: api(agent), fw, state };
  }
  const kes = (b: { currency: string; balance: string }[]) => b.find((x) => x.currency === "KES")?.balance;

  it("credits a deposit only after Flutterwave confirms the full amount", async () => {
    const { A, fw, state, ctx } = await setup();
    const dep = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "100", currency: "KES" });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBe("https://checkout.flutterwave.test/pay/abc");
    expect(dep.body.transfer.status).toBe("pending");
    const sent = fw.calls.find((c) => c.path === "/payments")!;
    expect(sent.headers.authorization).toBe("Bearer FLWSECK_TEST-abc");
    expect(sent.body).toMatchObject({ tx_ref: dep.body.transfer.id, amount: 100, currency: "KES" });
    expect(sent.body.redirect_url).toContain(`ref=${dep.body.transfer.id}`);

    // User comes back before paying: still pending, nothing credited.
    expect((await A.post(`/api/payments/transfers/${dep.body.transfer.id}/refresh`)).body.transfer.status).toBe("pending");

    state.deposit = { status: "successful", amount: 100, currency: "KES" };
    expect((await A.post(`/api/payments/transfers/${dep.body.transfer.id}/refresh`)).body.transfer.status).toBe("completed");
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("100.00");

    // An underpayment is refused.
    const dep2 = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "500", currency: "KES" });
    state.deposit = { status: "successful", amount: 50, currency: "KES" };
    expect((await A.post(`/api/payments/transfers/${dep2.body.transfer.id}/refresh`)).body.transfer.status).toBe("failed");
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("100.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });

  it("verifies webhooks with verif-hash and settles from Flutterwave's own record", async () => {
    const { app, A, state } = await setup();
    const dep = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "250", currency: "KES" });
    const payload = JSON.stringify({ event: "charge.completed", data: { tx_ref: dep.body.transfer.id, status: "successful", amount: 250, currency: "KES" } });

    const forged = await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "wrong").set("content-type", "application/json").send(payload);
    expect(forged.status).toBe(401);

    // A genuine webhook arrives before Flutterwave's record says paid: nothing is credited on the webhook's word.
    const early = await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "hook-hash").set("content-type", "application/json").send(payload);
    expect(early.status).toBe(200);
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBeUndefined();

    state.deposit = { status: "successful", amount: 250, currency: "KES" };
    await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "hook-hash").set("content-type", "application/json").send(payload);
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("250.00");
  });

  it("pays out to M-Pesa, and refunds when a payout fails", async () => {
    const { app, A, fw, state, ctx } = await setup();
    state.deposit = { status: "successful", amount: 300, currency: "KES" };
    const dep = await A.post("/api/payments/deposits", { rail: "flutterwave", amount: "300", currency: "KES" });
    await A.post(`/api/payments/transfers/${dep.body.transfer.id}/refresh`);

    const dest = { type: "mobile_money", name: "Amara K", accountNumber: "254712345678", bankCode: "MPS" };
    const w = await A.post("/api/payments/withdrawals", { rail: "flutterwave", amount: "100", currency: "KES", destination: dest });
    expect(w.status).toBe(201);
    expect(w.body.transfer.status).toBe("pending");
    expect(fw.calls.find((c) => c.path === "/transfers")!.body).toMatchObject({ account_bank: "MPS", account_number: "254712345678", amount: 100, currency: "KES", reference: w.body.transfer.id });
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("200.00"); // held while in flight

    state.transfer = "SUCCESSFUL";
    await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "hook-hash").set("content-type", "application/json")
      .send(JSON.stringify({ event: "transfer.completed", data: { id: 777, reference: w.body.transfer.id, status: "SUCCESSFUL" } }));
    expect((await A.get(`/api/payments/transfers/${w.body.transfer.id}`)).body.transfer.status).toBe("completed");

    state.transfer = "FAILED";
    const w2 = await A.post("/api/payments/withdrawals", { rail: "flutterwave", amount: "50", currency: "KES", destination: dest });
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("150.00");
    const refreshed = await A.post(`/api/payments/transfers/${w2.body.transfer.id}/refresh`);
    expect(refreshed.body.transfer.status).toBe("failed");
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("200.00"); // refunded

    // Missing network code: refused before any money leaves, and refunded immediately.
    const bad = await A.post("/api/payments/withdrawals", { rail: "flutterwave", amount: "10", currency: "KES", destination: { ...dest, bankCode: undefined } });
    expect(bad.body.error.code).toBe("payout_failed");
    expect(kes((await A.get("/api/payments/balances")).body.balances)).toBe("200.00");
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});
