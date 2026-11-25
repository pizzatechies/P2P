import { afterEach, describe, expect, it, vi } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { one } from "../src/db/index.js";
import { api, makeApp, signup } from "./helpers.js";

/** An admin with two-factor turned on (required for admin tools). */
async function makeAdmin({ app, ctx }: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(app, "admin");
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

/** Answers Groq's model list for one key, and refuses any other. */
function fakeGroq(goodKey: string) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.groq.com/")) return real(input, init);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${goodKey}`) return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), { headers: { "Content-Type": "application/json" } });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("AI for everyone (keys set by an admin in the app)", () => {
  it("switches a provider on for every customer, checks the key first, and keeps it encrypted", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const customer = api((await signup(env.app, "customer")).agent);
    const groq = async () => (await customer.get("/api/ai/providers")).body.providers.find((p: { id: string }) => p.id === "groq");
    expect(await groq()).toMatchObject({ available: false });

    fakeGroq("gsk_good_key_123456");
    expect((await admin.put("/api/admin/ai-keys/groq", { apiKey: "gsk_wrong_key_000000" })).body.error.code).toBe("key_rejected");
    const saved = await admin.put("/api/admin/ai-keys/groq", { apiKey: "gsk_good_key_123456" });
    expect(saved.status).toBe(200);
    expect(saved.body.providers.find((p: { id: string }) => p.id === "groq")).toMatchObject({ source: "app", hint: "3456" });
    expect(JSON.stringify(saved.body)).not.toContain("gsk_good_key_123456");
    const row = one<{ key_enc: string }>(env.ctx.db, "SELECT key_enc FROM server_api_keys WHERE provider = 'groq'")!;
    expect(row.key_enc).not.toContain("gsk_good_key");

    // Every customer can now use it, on the free daily allowance.
    expect(await groq()).toMatchObject({ available: true, source: "server", free: true });

    // Only admins can see or change it.
    expect((await customer.get("/api/admin/ai-keys")).status).toBe(403);
    expect((await customer.put("/api/admin/ai-keys/groq", { apiKey: "gsk_good_key_123456" })).status).toBe(403);
    expect((await admin.put("/api/admin/ai-keys/nope", { apiKey: "gsk_good_key_123456" })).status).toBe(400);

    expect((await admin.del("/api/admin/ai-keys/groq")).status).toBe(200);
    expect(await groq()).toMatchObject({ available: false });
  });
});
