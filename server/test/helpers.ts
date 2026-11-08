import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";

export function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    MASTER_KEY: "test-master-key-0123456789abcdef0123456789",
    APP_URL: "http://localhost:5173",
    PAYMENT_RAILS: "sandbox",
    ...env,
  });
  return createApp(config, openDb(":memory:"));
}

let seq = 0;

/** A logged-in test client (supertest agent keeps the session cookie). */
export async function signup(app: ReturnType<typeof makeApp>["app"], name = "user") {
  seq++;
  const agent = request.agent(app);
  const handle = `${name}${seq}`.slice(0, 20);
  const res = await agent
    .post("/api/auth/register")
    .set("x-p2p-csrf", "1")
    .send({ email: `${handle}@example.com`, handle, displayName: name, password: "correct-horse-42" });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; handle: string; email: string } };
}

/** Wraps an agent so every call carries the CSRF header. */
export function api(agent: ReturnType<typeof request.agent>) {
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set("x-p2p-csrf", "1").send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set("x-p2p-csrf", "1").send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set("x-p2p-csrf", "1").send(body ?? {}),
    del: (url: string) => agent.delete(url).set("x-p2p-csrf", "1"),
  };
}
