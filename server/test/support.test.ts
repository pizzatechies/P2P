import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { addBusinessDays } from "../src/services/support.js";
import { api, makeApp, signup } from "./helpers.js";

async function makeAdmin(env: ReturnType<typeof makeApp>) {
  const { agent, user } = await signup(env.app, "agent");
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

describe("help and complaints", () => {
  it("gives each case a reference, keeps staff notes internal, and reopens when the customer replies", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const c = await signup(env.app, "asker");
    const C = api(c.agent);
    const opened = await C.post("/api/support/cases", { category: "payment", subject: "Where is my deposit?", message: "I paid 500 KES by M-Pesa an hour ago." });
    expect(opened.status).toBe(201);
    expect(opened.body.case).toMatchObject({ reference: expect.stringMatching(/^AX-\d{4}-0001$/), status: "open", complaint: false });
    expect(opened.body.messages.map((m: { from: string }) => m.from)).toEqual(["customer", "system"]);
    const id = opened.body.case.id;

    // Nobody else can see it.
    const other = await signup(env.app, "nosy");
    expect((await api(other.agent).get(`/api/support/cases/${id}`)).status).toBe(404);

    // Staff see it in the queue, leave a note, and reply.
    const queue = (await admin.A.get("/api/admin/support/cases")).body;
    expect(queue.cases[0]).toMatchObject({ id, customer: { handle: c.user.handle } });
    await admin.A.post(`/api/admin/support/cases/${id}/messages`, { body: "Checked M-Pesa: callback arrived late.", internal: true });
    const replied = await admin.A.post(`/api/admin/support/cases/${id}/messages`, { body: "Found it: it's in your wallet now." });
    expect(replied.body.case.status).toBe("waiting_customer");

    const seen = (await C.get(`/api/support/cases/${id}`)).body;
    expect(seen.messages.map((m: { body: string }) => m.body)).not.toContain("Checked M-Pesa: callback arrived late.");
    expect(seen.messages.at(-1)).toMatchObject({ from: "staff", author: "Aurex support" }); // no staff names for customers
    const alerts = (await C.get("/api/settings/security")).body.alerts;
    expect(alerts.some((a: { kind: string; message: string }) => a.kind === "support" && a.message.includes(opened.body.case.reference))).toBe(true);

    await admin.A.post(`/api/admin/support/cases/${id}/resolve`, { resolution: "Deposit credited." });
    expect((await C.post(`/api/support/cases/${id}/messages`, { body: "It's there, thanks. One more question though." })).body.case.status).toBe("open");

    // The data download has the case, without the staff note.
    const exported = (await C.get("/api/account/export")).body;
    expect(exported.support[0].reference).toBe(opened.body.case.reference);
    expect(JSON.stringify(exported.support)).not.toContain("callback arrived late");
  });

  it("tracks complaints against the deadline, needs an outcome, and reports them", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const c = await signup(env.app, "unhappy");
    const C = api(c.agent);
    const complaint = (await C.post("/api/support/cases", { category: "complaint", subject: "Withdrawal held too long", message: "My withdrawal was held for three days." })).body;
    expect(complaint.case.complaint).toBe(true);
    expect(complaint.case.dueAt.slice(0, 10)).toBe(addBusinessDays(new Date(), 15).toISOString().slice(0, 10));
    expect(complaint.messages[1].body).toMatch(/business days/);

    // An ordinary case can be turned into a formal complaint.
    const q = (await C.post("/api/support/cases", { category: "account", subject: "Name change", message: "Please update my surname." })).body;
    expect((await C.post(`/api/support/cases/${q.case.id}/complaint`)).body.case.complaint).toBe(true);
    expect((await admin.A.get("/api/admin/support/cases?complaints=1")).body.cases).toHaveLength(2);

    const id = complaint.case.id;
    expect((await admin.A.post(`/api/admin/support/cases/${id}/resolve`, { resolution: "We reviewed the hold." })).status).toBe(400);
    const done = await admin.A.post(`/api/admin/support/cases/${id}/resolve`, { resolution: "The hold was longer than our standard; we've refunded the fee.", outcome: "partly_upheld" });
    expect(done.body.case).toMatchObject({ status: "resolved", outcome: "partly_upheld" });
    expect((await C.get(`/api/support/cases/${id}`)).body.messages.at(-1).body).toMatch(/partly upheld.*regulator or ombudsman/s);

    const today = new Date().toISOString().slice(0, 10);
    const report = (await admin.A.get(`/api/admin/support/report?from=${today}&to=${today}`)).body.report;
    expect(report).toMatchObject({ received: 2, resolved: 1, open: 1, outcomes: { partly_upheld: 1 }, resolvedLate: 0 });
    const csv = await admin.A.get(`/api/admin/support/report?from=${today}&to=${today}&format=csv`);
    expect(csv.text.split("\r\n")[0]).toContain('"Reference","Received"');
    expect(csv.text).toContain('"partly_upheld"');
  });

  it("doesn't let an admin handle their own case, and counts business days", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const mine = (await admin.A.post("/api/support/cases", { category: "question", subject: "Testing", message: "My own case" })).body;
    expect((await admin.A.post(`/api/admin/support/cases/${mine.case.id}/resolve`, { resolution: "Done here." })).status).toBe(403);
    // Friday + 1 business day = Monday.
    expect(addBusinessDays(new Date("2026-11-20T10:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-11-23");
  });
});
