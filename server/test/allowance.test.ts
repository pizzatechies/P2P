import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeApp, signup } from "./helpers.js";

/** A tiny OpenAI-compatible server standing in for a self-hosted model (Ollama), so no real AI is called. */
let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const word of ["Hello", " from", " the", " stub"]) {
        res.write(`data: ${JSON.stringify({ model: "llama3.2", choices: [{ delta: { content: word } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const events = (text: string) => text.split("\n\n").filter((b) => b.startsWith("event:")).map((b) => b.split("\n")[0].slice(7));

describe("free AI allowance", () => {
  it("counts requests on server-provided models and stops at the daily limit", async () => {
    const { app } = makeApp({ OLLAMA_BASE_URL: baseUrl, AI_FREE_DAILY_REQUESTS: "2" });
    const { agent } = await signup(app, "freebie");
    const A = api(agent);

    const providers = (await A.get("/api/ai/providers")).body;
    expect(providers.providers.find((p: { id: string }) => p.id === "ollama")).toMatchObject({ available: true, free: true });
    expect(providers.freeAllowance).toMatchObject({ limit: 2, used: 0, remaining: 2 });

    for (let i = 0; i < 2; i++) {
      const res = await A.post("/api/ai/chat", { provider: "ollama", model: "llama3.2", message: `hi ${i}` });
      expect(res.status).toBe(200);
      expect(events(res.text)).toEqual(["meta", "delta", "delta", "delta", "delta", "done"]);
    }
    const third = await A.post("/api/ai/chat", { provider: "ollama", model: "llama3.2", message: "one more" });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("ai_quota_exceeded");
    expect((await A.get("/api/ai/providers")).body.freeAllowance).toMatchObject({ used: 2, remaining: 0 });

    // The offline demo assistant is never counted.
    expect((await A.post("/api/ai/chat", { provider: "demo", model: "demo", message: "still here?" })).status).toBe(200);
  });

  it("limits the server's keys to the free model list when one is set", async () => {
    const { app } = makeApp({ OLLAMA_BASE_URL: baseUrl, AI_FREE_MODELS: "ollama:llama3.2" });
    const { agent } = await signup(app, "picky");
    const A = api(agent);
    const blocked = await A.post("/api/ai/chat", { provider: "ollama", model: "huge-model", message: "hi" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("model_not_free");
    expect((await A.post("/api/ai/chat", { provider: "ollama", model: "llama3.2", message: "hi" })).status).toBe(200);
  });

  it("is unlimited when AI_FREE_DAILY_REQUESTS is 0", async () => {
    const { app } = makeApp({ OLLAMA_BASE_URL: baseUrl, AI_FREE_DAILY_REQUESTS: "0" });
    const { agent } = await signup(app, "unlimited");
    const A = api(agent);
    for (let i = 0; i < 3; i++) {
      expect((await A.post("/api/ai/chat", { provider: "ollama", model: "llama3.2", message: `hi ${i}` })).status).toBe(200);
    }
    expect((await A.get("/api/ai/providers")).body.freeAllowance.limit).toBeNull();
  });
});
