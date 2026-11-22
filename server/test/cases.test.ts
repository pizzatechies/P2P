import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { hasOpenSeriousAlert, openAlert } from "../src/services/monitoring.js";
import { api, makeApp, signup } from "./helpers.js";

async function makeAdmin(env: ReturnType<typeof makeApp>, name = "admin") {
  const { agent, user } = await signup(env.app, name);
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

const alertId = (env: ReturnType<typeof makeApp>, ref: string) => (env.ctx.db.prepare("SELECT id FROM compliance_alerts WHERE ref = ?").get(ref) as { id: string }).id;

describe("compliance case files", () => {
  it("keeps notes that can't be changed, and records the reporting decision on escalated cases", async () => {
    const env = makeApp();
    const mlro = await makeAdmin(env, "mlro");
    const customer = await signup(env.app, "kamau");
    openAlert(env.ctx, customer.user.id, "large_amount", "case-1", "Sent 9,500 USD to a new recipient", { amount: "9500" });
    openAlert(env.ctx, customer.user.id, "rapid_in_out", "case-2", "Money in and straight out", {});
    const first = alertId(env, "case-1");
    const second = alertId(env, "case-2");

    // Notes, with who wrote them; the database refuses edits and deletions.
    let file = (await mlro.A.get(`/api/admin/compliance/${first}`)).body;
    expect(file).toMatchObject({ notes: [], canDecide: false, alert: { status: "open", report: null } });
    expect((await mlro.A.post(`/api/admin/compliance/${first}/notes`, { body: "x" })).status).toBe(400);
    file = (await mlro.A.post(`/api/admin/compliance/${first}/notes`, { body: "Called the customer: says it's a car purchase. Asked for the sale agreement." })).body;
    expect(file.notes).toEqual([expect.objectContaining({ body: expect.stringMatching(/car purchase/), author: expect.objectContaining({ handle: mlro.user.handle }) })]);
    expect(() => env.ctx.db.prepare("UPDATE compliance_notes SET body = 'nothing to see'").run()).toThrow(/cannot be changed/);
    expect(() => env.ctx.db.prepare("DELETE FROM compliance_notes").run()).toThrow(/cannot be deleted/);

    // The decision only follows an escalation.
    expect((await mlro.A.post(`/api/admin/compliance/${first}/decision`, { decision: "no_report", reason: "Sale agreement checks out and matches the amount." })).body.error.code).toBe("not_escalated");
    await mlro.A.post(`/api/admin/compliance/${first}`, { action: "escalate", note: "No documents after 5 days" });
    const escalated = (await mlro.A.get("/api/admin/compliance?status=escalated")).body.alerts;
    expect(escalated).toEqual([expect.objectContaining({ id: first, notes: 1, report: null })]);

    const report = (body: object) => mlro.A.post(`/api/admin/compliance/${first}/decision`, { decision: "report", ...body });
    expect((await report({ reason: "too short" })).status).toBe(400);
    expect((await report({ reason: "Unexplained large payment, no documents provided after two requests." })).body.error.message).toMatch(/reference/);
    expect((await report({ reason: "Unexplained large payment, no documents provided after two requests.", reference: "STR-2026-0042", reportedOn: "2999-01-01" })).body.error.message).toMatch(/date/);
    file = (await report({ reason: "Unexplained large payment, no documents provided after two requests.", reference: "STR-2026-0042", reportedOn: "2026-11-20" })).body;
    expect(file).toMatchObject({ canDecide: false, decidedBy: { handle: mlro.user.handle }, alert: { status: "escalated", report: { decision: "report", reference: "STR-2026-0042", reportedOn: "2026-11-20" } } });
    // Final: later information goes in a note.
    expect((await report({ reason: "Changing my mind about the earlier decision here.", reference: "X", reportedOn: "2026-11-21" })).body.error.code).toBe("already_decided");

    // Not reporting closes the case and releases the payout hold.
    await mlro.A.post(`/api/admin/compliance/${second}`, { action: "escalate", note: "Pattern looks like layering" });
    expect(hasOpenSeriousAlert(env.ctx, customer.user.id)).toBe(true);
    await mlro.A.post(`/api/admin/compliance/${first}`, { action: "clear", note: "Reported; relationship continues under watch" });
    file = (await mlro.A.post(`/api/admin/compliance/${second}/decision`, { decision: "no_report", reason: "Salary arriving and rent going out the same day: explained by payslips." })).body;
    expect(file.alert).toMatchObject({ status: "cleared", report: { decision: "no_report", reference: null } });
    expect(hasOpenSeriousAlert(env.ctx, customer.user.id)).toBe(false);

    // The register lists every decision; exporting it is audited.
    const csv = await mlro.A.get("/api/admin/compliance/register.csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/Reported to the FIU.*STR-2026-0042.*2026-11-20/);
    expect(lines[2]).toMatch(/Not reported.*payslips/);
    const actions = (env.ctx.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'compliance.%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["compliance.note_added", "compliance.case_viewed", "compliance.report_decided", "compliance.register_exported"]));
  });

  it("can't be read by customers, or worked on by an admin about their own account", async () => {
    const env = makeApp();
    const admin = await makeAdmin(env);
    const customer = await signup(env.app, "wanjiru");
    openAlert(env.ctx, admin.user.id, "large_amount", "self-1", "Admin's own large payment", {});
    openAlert(env.ctx, customer.user.id, "large_amount", "cust-1", "Large payment", {});
    expect((await admin.A.get(`/api/admin/compliance/${alertId(env, "self-1")}`)).status).toBe(403);
    expect((await admin.A.post(`/api/admin/compliance/${alertId(env, "self-1")}/notes`, { body: "Looks fine to me" })).status).toBe(403);
    expect((await api(customer.agent).get(`/api/admin/compliance/${alertId(env, "cust-1")}`)).status).toBe(403);
  });
});
