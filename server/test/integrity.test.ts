import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { sealAtStartup, verifyIntegrity } from "../src/services/integrity.js";
import { api, makeApp, signup } from "./helpers.js";

async function someActivity(env: ReturnType<typeof makeApp>) {
  const a = await signup(env.app, "sealer");
  const b = await signup(env.app, "sealee");
  const A = api(a.agent);
  await A.post("/api/payments/deposits", { rail: "sandbox", amount: "100", currency: "USD" });
  await A.post("/api/payments/send", { to: `@${b.user.handle}`, amount: "25", currency: "USD", memo: "rent" });
  return { a, b };
}

describe("tamper evidence", () => {
  it("seals every journal and audit event in a chain that verifies", async () => {
    const env = makeApp();
    await someActivity(env);
    const unsealed = env.ctx.db.prepare("SELECT (SELECT COUNT(*) FROM journals WHERE seal IS NULL) + (SELECT COUNT(*) FROM audit_events WHERE seal IS NULL) AS n").get() as { n: number };
    expect(unsealed.n).toBe(0);
    const r = verifyIntegrity(env.ctx);
    expect(r.ok).toBe(true);
    expect(r.journals.checked).toBe(2);
    expect(r.audit.checked).toBeGreaterThanOrEqual(3);
  });

  it("refuses edits and deletions of journals and the audit log", async () => {
    const env = makeApp();
    await someActivity(env);
    const db = env.ctx.db;
    expect(() => db.prepare("UPDATE journals SET memo = 'gift'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM journals").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE audit_events SET action = 'nothing'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });

  it("detects changes made by someone who gets past the database's own guards", async () => {
    const env = makeApp();
    await someActivity(env);
    const db = env.ctx.db;
    // An attacker with the database file drops the triggers and edits a payment.
    db.exec("DROP TRIGGER journals_no_update; DROP TRIGGER entries_no_update; DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete");
    const transfer = db.prepare("SELECT id FROM journals WHERE kind = 'transfer'").get() as { id: string };
    db.prepare("UPDATE entries SET amount = amount * 2 WHERE journal_id = ?").run(transfer.id);
    let r = verifyIntegrity(env.ctx);
    expect(r.journals).toMatchObject({ ok: false, brokenAt: transfer.id });
    expect(r.audit.ok).toBe(true);

    // Deleting an audit event, or slipping in an unsealed one, breaks the audit chain too.
    db.prepare("DELETE FROM audit_events WHERE id = (SELECT MIN(id) + 1 FROM audit_events)").run();
    r = verifyIntegrity(env.ctx);
    expect(r.audit.ok).toBe(false);
    // Startup refuses to paper over it.
    expect(sealAtStartup(env.ctx)).toEqual({ journals: "broken", audit: "broken" });
  });

  it("spots an unsealed row slipped into the audit log", async () => {
    const env = makeApp();
    await someActivity(env);
    env.ctx.db.prepare("INSERT INTO audit_events (user_id, action, ip, details, created_at) VALUES (NULL, 'admin.user_status', NULL, '{}', ?)").run(new Date().toISOString());
    expect(verifyIntegrity(env.ctx).audit.ok).toBe(false);
  });

  it("seals records made before sealing existed, and reseals after a MASTER_KEY rotation", async () => {
    const db = openDb(":memory:");
    const base = { NODE_ENV: "test", DATABASE_PATH: ":memory:", PAYMENT_RAILS: "sandbox", APP_URL: "http://localhost:5173", REQUIRE_EMAIL_VERIFICATION: "false" } as const;
    const oldKey = "old-master-key-0123456789abcdef0123456789";
    const first = createApp(loadConfig({ ...base, MASTER_KEY: oldKey }), db);
    const agent = request.agent(first.app);
    await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "seal@example.com", handle: "sealtest", displayName: "S", password: "correct-horse-42" });
    await api(agent).post("/api/payments/deposits", { rail: "sandbox", amount: "10", currency: "USD" });
    expect(verifyIntegrity(first.ctx).ok).toBe(true);

    // A database from before sealing: no seals at all. The next start seals it.
    db.exec("DROP TRIGGER journals_no_update; DROP TRIGGER audit_no_update");
    db.exec("UPDATE journals SET seal = NULL; UPDATE audit_events SET seal = NULL");
    expect(sealAtStartup(first.ctx)).toEqual({ journals: "sealed", audit: "sealed" });
    expect(verifyIntegrity(first.ctx).ok).toBe(true);

    // Rotating MASTER_KEY: the chain verified under the old key is resealed with the new one.
    const second = createApp(loadConfig({ ...base, MASTER_KEY: "new-master-key-0123456789abcdef0123456789", MASTER_KEY_PREVIOUS: oldKey }), db);
    expect(verifyIntegrity(second.ctx).ok).toBe(true);
    expect(verifyIntegrity(first.ctx).ok).toBe(false); // the old key no longer verifies
  });

  it("lets admins run the check, and shows it on the overview", async () => {
    const env = makeApp({ REQUIRE_ADMIN_2FA: "false" });
    const { a } = await someActivity(env);
    env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(a.user.id);
    const A = api(a.agent);
    expect((await A.get("/api/admin/overview")).body.integrity.ok).toBe(true);
    expect((await A.post("/api/admin/integrity/verify")).body.integrity).toMatchObject({ ok: true });
  });
});
