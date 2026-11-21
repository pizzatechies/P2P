import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { api, makeApp, signup } from "./helpers.js";

type Env = ReturnType<typeof makeApp>;

async function makeAdmin(env: Env, name: string) {
  const { agent, user } = await signup(env.app, name);
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, user };
}

const limitsOf = (env: Env, id: string) => env.ctx.db.prepare("SELECT limit_tx_usd AS tx, limit_daily_usd AS daily, kyc_level AS level FROM users WHERE id = ?").get(id) as { tx: number | null; daily: number | null; level: number };

describe("two-person approval", () => {
  it("applies straight away with one admin, and waits for a second admin when there is one", async () => {
    const env = makeApp();
    const first = await makeAdmin(env, "first");
    const c = await signup(env.app, "customer");
    // Only one admin: nobody else could approve, so the change applies.
    expect((await first.A.post(`/api/admin/users/${c.user.id}/limits`, { txUsd: 300, dailyUsd: 900 })).body).toMatchObject({ applied: true });
    expect(limitsOf(env, c.user.id)).toMatchObject({ tx: 300, daily: 900 });

    const second = await makeAdmin(env, "second");
    const asked = await first.A.post(`/api/admin/users/${c.user.id}/limits`, { txUsd: 50000, dailyUsd: 100000 });
    expect(asked.status).toBe(202);
    expect(asked.body.request).toMatchObject({ kind: "limits", status: "pending", requestedBy: { handle: expect.stringMatching(/^first/) } });
    expect(limitsOf(env, c.user.id)).toMatchObject({ tx: 300, daily: 900 }); // nothing changed yet
    const id = asked.body.request.id;

    // The asker can't approve their own request; the second admin is told and approves.
    expect((await first.A.post(`/api/admin/approvals/${id}/approve`)).status).toBe(403);
    const pending = (await second.A.get("/api/admin/approvals")).body.requests;
    expect(pending).toEqual([expect.objectContaining({ id, summary: "limits to $50,000 per payment and $100,000 a day" })]);
    const alerts = (await second.A.get("/api/settings/security")).body.alerts;
    expect(alerts.some((a: { message: string }) => /asks to set .*limits/.test(a.message))).toBe(true);
    expect((await second.A.post(`/api/admin/approvals/${id}/approve`)).body.request.status).toBe("approved");
    expect(limitsOf(env, c.user.id)).toMatchObject({ tx: 50000, daily: 100000 });
    expect((await second.A.post(`/api/admin/approvals/${id}/approve`)).status).toBe(422); // already decided

    // Identity levels too; turning one down needs a reason.
    const level = await second.A.post(`/api/admin/users/${c.user.id}/kyc-level`, { level: 2, note: "Seen in branch" });
    expect(level.status).toBe(202);
    expect((await first.A.post(`/api/admin/approvals/${level.body.request.id}/reject`)).status).toBe(400);
    expect((await first.A.post(`/api/admin/approvals/${level.body.request.id}/reject`, { note: "No branch visit on record" })).body.request.status).toBe("rejected");
    expect(limitsOf(env, c.user.id).level).toBe(0);
  });

  it("can be forced on or off, can't touch the approver's own account, and shows on the checklist", async () => {
    const env = makeApp({ TWO_PERSON_APPROVAL: "on" });
    const solo = await makeAdmin(env, "solo");
    const c = await signup(env.app, "client");
    // "on" with one admin: the request waits (and only another admin could approve it).
    expect((await solo.A.post(`/api/admin/users/${c.user.id}/limits`, { txUsd: 10, dailyUsd: 20 })).status).toBe(202);
    const checks = (await solo.A.get("/api/admin/security")).body.checks as { id: string; status: string }[];
    expect(checks.find((x) => x.id === "two_person")?.status).toBe("pass");

    // A request about an admin can't be approved by that admin.
    const other = await makeAdmin(env, "other");
    const aboutOther = await solo.A.post(`/api/admin/users/${other.user.id}/limits`, { txUsd: 10, dailyUsd: 20 });
    expect((await other.A.post(`/api/admin/approvals/${aboutOther.body.request.id}/approve`)).status).toBe(403);
    // The asker can withdraw it.
    expect((await solo.A.post(`/api/admin/approvals/${aboutOther.body.request.id}/cancel`)).status).toBe(200);

    const off = makeApp({ TWO_PERSON_APPROVAL: "off" });
    const a = await makeAdmin(off, "a1");
    await makeAdmin(off, "a2");
    const cust = await signup(off.app, "cust");
    expect((await a.A.post(`/api/admin/users/${cust.user.id}/limits`, { txUsd: 10, dailyUsd: 20 })).status).toBe(200);
    expect(((await a.A.get("/api/admin/security")).body.checks as { id: string; status: string }[]).find((x) => x.id === "two_person")?.status).toBe("fail");
  });
});
