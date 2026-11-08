import { describe, expect, it } from "vitest";
import { api, makeApp, signup } from "./helpers.js";

function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((block) => {
      const [evLine, dataLine] = block.split("\n");
      return { event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
}

describe("AI hub", () => {
  it("lists providers and marks only configured ones available", async () => {
    const { app } = makeApp({ OPENAI_API_KEY: "sk-test-server" });
    const { agent } = await signup(app, "ai");
    const res = await api(agent).get("/api/ai/providers");
    const byId = Object.fromEntries(res.body.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.demo.available).toBe(true);
    expect(byId.openai.available).toBe(true);
    expect(byId.openai.source).toBe("server");
    expect(byId.anthropic.available).toBe(false);
  });

  it("streams a chat reply over SSE and stores the conversation", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "chatter");
    const res = await api(agent).post("/api/ai/chat", { provider: "demo", model: "demo", message: "How do I send money?" });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events[0].event).toBe("meta");
    expect(events.some((e) => e.event === "delta")).toBe(true);
    expect(events[events.length - 1].event).toBe("done");

    const convs = (await api(agent).get("/api/ai/conversations")).body.conversations;
    expect(convs).toHaveLength(1);
    const conv = (await api(agent).get(`/api/ai/conversations/${convs[0].id}`)).body.conversation;
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("explains how to connect a provider that has no key", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "nokey");
    const res = await api(agent).post("/api/ai/chat", { provider: "anthropic", model: "claude-opus-5-5", message: "hi" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("provider_not_configured");
  });

  it("never returns stored API keys", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "byok");
    const save = await api(agent).put("/api/settings/api-keys/openai", { apiKey: "sk-user-supersecret-1234", verify: false });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain("supersecret");
    expect(save.body.keys[0]).toMatchObject({ provider: "openai", hint: "1234" });
    const providers = (await api(agent).get("/api/ai/providers")).body.providers;
    expect(providers.find((p: { id: string }) => p.id === "openai").source).toBe("user");
  });
});

describe("trading (paper + simulated market)", () => {
  it("opens a paper account, buys and sells", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "trader");
    const T = api(agent);
    const acct = (await T.get("/api/trading/account")).body;
    expect(acct.settings).toMatchObject({ broker: "paper", dataSource: "simulated" });
    expect(acct.account.cash).toBe(100000);

    const buy = await T.post("/api/trading/orders", { symbol: "AAPL", side: "buy", type: "market", qty: 10 });
    expect(buy.status).toBe(201);
    expect(buy.body.order.status).toBe("filled");

    const after = (await T.get("/api/trading/account")).body.account;
    expect(after.positions[0]).toMatchObject({ symbol: "AAPL", qty: 10 });
    expect(after.cash).toBeCloseTo(100000 - 10 * buy.body.order.filledAvgPrice, 1);

    expect((await T.post("/api/trading/orders", { symbol: "AAPL", side: "sell", qty: 11 })).status).toBe(422);
    const sell = await T.post("/api/trading/orders", { symbol: "AAPL", side: "sell", qty: 10 });
    expect(sell.body.order.status).toBe("filled");
    expect((await T.get("/api/trading/account")).body.account.positions).toHaveLength(0);
  });

  it("rests limit orders that aren't marketable and lets you cancel them", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "limiter");
    const T = api(agent);
    const q = (await T.get("/api/trading/quote/MSFT")).body.quote;
    const order = await T.post("/api/trading/orders", { symbol: "MSFT", side: "buy", type: "limit", qty: 1, limitPrice: Math.round(q.price * 0.5) });
    expect(order.body.order.status).toBe("new");
    const canceled = await T.post(`/api/trading/orders/${order.body.order.id}/cancel`);
    expect(canceled.body.order.status).toBe("canceled");
  });

  it("produces a rule-based AI signal and executes it only with confirmation and within the cap", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "quant");
    const T = api(agent);
    const res = await T.post("/api/trading/analyze", { symbol: "NVDA", provider: "rules" });
    expect(res.status).toBe(201);
    const signal = res.body.signal;
    expect(["buy", "sell", "hold"]).toContain(signal.action);
    expect(signal.action).not.toBe("sell"); // no position, so the guardrail converts sells to hold
    expect(signal.indicators.price).toBeGreaterThan(0);

    if (signal.action === "buy") {
      expect((await T.post(`/api/trading/signals/${signal.id}/execute`, {})).body.error.code).toBe("confirmation_required");
      const tooBig = await T.post(`/api/trading/signals/${signal.id}/execute`, { confirm: true, qty: 100000 });
      expect(["ai_position_cap", "insufficient_buying_power"]).toContain(tooBig.body.error.code);
      const ok = await T.post(`/api/trading/signals/${signal.id}/execute`, { confirm: true });
      expect(ok.status).toBe(201);
      expect(ok.body.order.source).toBe("ai");
      expect((await T.post(`/api/trading/signals/${signal.id}/execute`, { confirm: true })).body.error.code).toBe("signal_used");
    } else {
      expect((await T.post(`/api/trading/signals/${signal.id}/execute`, { confirm: true })).body.error.code).toBe("nothing_to_execute");
    }
  });

  it("manages the watchlist and rejects unknown symbols", async () => {
    const { app } = makeApp();
    const { agent } = await signup(app, "watcher");
    const T = api(agent);
    const wl = (await T.get("/api/trading/watchlist")).body;
    expect(wl.items.map((i: { symbol: string }) => i.symbol)).toContain("SPY");
    expect((await T.post("/api/trading/watchlist", { symbol: "TSLA" })).status).toBe(201);
    expect((await T.post("/api/trading/watchlist", { symbol: "NOPE1" })).status).toBe(404);
  });
});
