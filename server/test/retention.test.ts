import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { verifyChain } from "../src/services/integrity.js";
import { verifyLedger } from "../src/services/ledger.js";
import { openAlert } from "../src/services/monitoring.js";
import { api, makeApp, signup } from "./helpers.js";

type Env = ReturnType<typeof makeApp>;
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);

async function makeAdmin(env: Env) {
  const { agent, user } = await signup(env.app, "admin");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

const count = (env: Env, sql: string, ...args: string[]) => (env.ctx.db.prepare(sql).get(...args) as { n: number }).n;

/** A verified customer with money history, a support case and a payout, who then closes their account. */
async function closedCustomer(env: Env) {
  const u = await signup(env.app, "leaving");
  const A = api(u.agent);
  await A.put("/api/account/verification/1", {
    legalName: "Peter Mwale Banda",
    dateOfBirth: "1984-08-08",
    nationality: "ZM",
    phone: "+260 977 000 111",
    address: { line1: "Plot 9, Cairo Road", city: "Lusaka", country: "ZM" },
    idType: "passport",
    idNumber: "ZN998877",
    idCountry: "ZM",
    idExpiry: "2034-01-01",
  });
  for (const kind of ["id_front", "selfie"]) await u.agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", "image/jpeg").send(jpeg());
  await A.post("/api/account/verification/1/submit");
  await A.post("/api/support/cases", { category: "account", subject: "Closing my account", message: "I'm moving abroad; my phone is +260 977 000 111." });
  await A.post("/api/payments/deposits", { rail: "sandbox", amount: "20", currency: "USD" });
  const w = await A.post("/api/payments/withdrawals", { rail: "sandbox", amount: "20", currency: "USD", destination: { type: "bank_account", name: "Peter Banda", accountNumber: "0099887766" } });
  expect(w.status).toBe(201);
  expect((await A.post("/api/account/close", { confirmHandle: u.user.handle })).status).toBe(200);
  return u;
}

describe("record retention", () => {
  it("deletes a closed account's personal data after the retention period, unless it's on hold, and keeps the books", async () => {
    const env = makeApp({ RECORD_RETENTION_YEARS: "7", KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const gone = await closedCustomer(env);
    const id = gone.user.id;

    // Money in and straight out raised alerts; a reviewer clears them first.
    for (const al of (await admin.get(`/api/admin/compliance?user=${id}`)).body.alerts) await admin.post(`/api/admin/compliance/${al.id}`, { action: "clear", note: "Closing balance paid out" });

    // Not yet: closed today.
    expect((await admin.post("/api/admin/retention/run", {})).body).toEqual({ purged: 0, kept: 0 });
    env.ctx.db.prepare("UPDATE users SET closed_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * 365 * 86_400_000).toISOString(), id);
    expect((await admin.get("/api/admin/retention")).body.accounts).toEqual([expect.objectContaining({ id, due: true, hold: null })]);

    // A legal hold keeps everything; so does an open compliance case.
    expect((await admin.post(`/api/admin/users/${id}/legal-hold`, { hold: true })).status).toBe(400);
    await admin.post(`/api/admin/users/${id}/legal-hold`, { hold: true, reason: "Court order 2026/114" });
    expect((await admin.post("/api/admin/retention/run", {})).body).toEqual({ purged: 0, kept: 1 });
    await admin.post(`/api/admin/users/${id}/legal-hold`, { hold: false });
    openAlert(env.ctx, id, "large_amount", "ret-1", "Large payment", {});
    expect((await admin.get("/api/admin/retention")).body.accounts[0].hold).toMatch(/compliance case/);
    expect((await admin.post("/api/admin/retention/run", {})).body.kept).toBe(1);
    const alert = env.ctx.db.prepare("SELECT id FROM compliance_alerts WHERE ref = 'ret-1'").get() as { id: string };
    await admin.post(`/api/admin/compliance/${alert.id}`, { action: "clear", note: "Explained" });

    // Now it goes.
    expect((await admin.post("/api/admin/retention/run", {})).body).toEqual({ purged: 1, kept: 0 });
    expect(count(env, "SELECT COUNT(*) AS n FROM kyc_documents WHERE user_id = ?", id)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM kyc_submissions WHERE user_id = ? AND data_enc IS NOT NULL", id)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM external_transfers WHERE user_id = ? AND destination IS NOT NULL", id)).toBe(0);
    const messages = env.ctx.db.prepare("SELECT m.body FROM support_messages m JOIN support_cases c ON c.id = m.case_id WHERE c.user_id = ?").all(id) as { body: string }[];
    expect(messages.every((m) => m.body.startsWith("[Removed"))).toBe(true);
    const row = env.ctx.db.prepare("SELECT email, handle, display_name, purged_at FROM users WHERE id = ?").get(id) as { email: string; handle: string; display_name: string; purged_at: string };
    expect(row).toMatchObject({ email: `deleted-${id}@deleted.invalid`, display_name: "Deleted customer", handle: expect.stringMatching(/^deleted_[0-9a-f]{8}$/) });
    expect(row.purged_at).toBeTruthy();

    // The books and the audit trail are untouched and still verify.
    expect(count(env, "SELECT COUNT(*) AS n FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?", id)).toBeGreaterThan(0);
    expect(verifyLedger(env.ctx).ok).toBe(true);
    expect(verifyChain(env.ctx, "audit").ok).toBe(true);
    const audited = env.ctx.db.prepare("SELECT details FROM audit_events WHERE action = 'retention.purged'").get() as { details: string };
    expect(JSON.parse(audited.details).removed).toMatchObject({ identityDocuments: 2, supportMessages: expect.any(Number), payoutDestinations: 1 });

    // It can't be reopened or signed in to.
    expect((await admin.post(`/api/admin/users/${id}/status`, { status: "active" })).body.error.code).toBe("purged");
    expect((await request(env.app).post("/api/auth/login").set("x-aurex-csrf", "1").send({ email: gone.user.email, password: "correct-horse-42" })).status).toBe(401);
  });

  it("keeps everything by default (RECORD_RETENTION_YEARS=0)", async () => {
    const env = makeApp({ KYC_AUTO_APPROVE: "true" });
    const admin = await makeAdmin(env);
    const gone = await closedCustomer(env);
    env.ctx.db.prepare("UPDATE users SET closed_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 365 * 86_400_000).toISOString(), gone.user.id);
    expect((await admin.post("/api/admin/retention/run", {})).status).toBe(400);
    expect((await admin.get("/api/admin/retention")).body.accounts).toEqual([]);
    expect(count(env, "SELECT COUNT(*) AS n FROM kyc_documents WHERE user_id = ?", gone.user.id)).toBe(2);
  });
});
