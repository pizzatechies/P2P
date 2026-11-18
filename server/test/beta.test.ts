import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { api, makeApp } from "./helpers.js";

type App = ReturnType<typeof makeApp>;
let n = 0;
const register = (app: App["app"], extra: Record<string, string> = {}) => {
  n++;
  return request
    .agent(app)
    .post("/api/auth/register")
    .set("x-aurex-csrf", "1")
    .send({ email: `beta${n}@example.com`, handle: `beta${n}`, displayName: `Beta Tester ${n}`, password: "correct-horse-42", ...extra });
};

async function admin(env: App, email = "boss@example.com") {
  const agent = request.agent(env.app);
  const res = await agent.post("/api/auth/register").set("x-aurex-csrf", "1").send({ email, handle: "boss", displayName: "Boss", password: "correct-horse-42" });
  expect(res.status).toBe(201); // admin addresses can always sign up
  env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return A;
}

describe("invite-only beta", () => {
  it("needs an invite code to sign up, and each code works only as often as allowed", async () => {
    const env = makeApp({ REGISTRATION_MODE: "invite", ADMIN_EMAILS: "boss@example.com" });
    expect((await request(env.app).get("/api/public/signup")).body).toEqual({ mode: "invite", full: false, waitlist: true });
    const A = await admin(env);

    const noCode = await register(env.app);
    expect(noCode.status).toBe(403);
    expect(noCode.body.error.code).toBe("invite_required");
    expect((await register(env.app, { inviteCode: "NOPE-NOPE" })).body.error.code).toBe("invite_invalid");

    const created = await A.post("/api/admin/beta/invites", { label: "Pilot group", maxUses: 2, expiresInDays: 7 });
    expect(created.status).toBe(201);
    const code: string = created.body.code;
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // Typed loosely (lower case, no dash) still works.
    expect((await register(env.app, { inviteCode: code.toLowerCase().replace("-", "") })).status).toBe(201);
    expect((await register(env.app, { inviteCode: code })).status).toBe(201);
    expect((await register(env.app, { inviteCode: code })).body.error.code).toBe("invite_invalid"); // used up

    // Stored only as a hash.
    const row = env.ctx.db.prepare("SELECT * FROM invite_codes").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(code.replace("-", "").slice(4));
    const beta = (await A.get("/api/admin/beta")).body;
    expect(beta.invites[0]).toMatchObject({ label: "Pilot group", uses: 2, maxUses: 2, status: "used up", hint: code.slice(0, 4) });

    // Revoked codes stop working.
    const another = (await A.post("/api/admin/beta/invites", {})).body;
    await A.post(`/api/admin/beta/invites/${another.invite.id}/revoke`);
    expect((await register(env.app, { inviteCode: another.code })).body.error.code).toBe("invite_invalid");
  });

  it("runs a waitlist that admins invite from", async () => {
    const env = makeApp({ REGISTRATION_MODE: "closed", ADMIN_EMAILS: "boss@example.com" });
    const A = await admin(env);
    expect((await register(env.app)).body.error.code).toBe("signups_closed");

    const joined = await request(env.app).post("/api/public/waitlist").set("x-aurex-csrf", "1").send({ email: "Hopeful@Example.com", name: "Hope" });
    expect(joined.status).toBe(201);
    // Joining twice answers the same way (so the list can't be probed).
    expect((await request(env.app).post("/api/public/waitlist").set("x-aurex-csrf", "1").send({ email: "hopeful@example.com" })).body).toEqual({ ok: true });
    const list = (await A.get("/api/admin/beta")).body.waitlist;
    expect(list).toEqual([expect.objectContaining({ email: "hopeful@example.com", name: "Hope", invitedAt: null })]);

    const inv = await A.post(`/api/admin/beta/waitlist/${list[0].id}/invite`);
    expect(inv.body).toMatchObject({ emailed: true, link: expect.stringContaining(`/register?invite=${inv.body.code}`) });
    // Closed means closed, even with an invite: switch to invite mode to let invitees in.
    expect((await register(env.app, { inviteCode: inv.body.code })).body.error.code).toBe("signups_closed");

    const reopened = makeApp({ REGISTRATION_MODE: "invite", ADMIN_EMAILS: "boss@example.com" });
    const B = await admin(reopened);
    const w = (await request(reopened.app).post("/api/public/waitlist").set("x-aurex-csrf", "1").send({ email: "hope2@example.com" })).body;
    expect(w.ok).toBe(true);
    const id = (await B.get("/api/admin/beta")).body.waitlist[0].id;
    const code = (await B.post(`/api/admin/beta/waitlist/${id}/invite`)).body.code;
    const signed = await request.agent(reopened.app).post("/api/auth/register").set("x-aurex-csrf", "1").send({ email: "hope2@example.com", handle: "hope2", displayName: "Hope Two", password: "correct-horse-42", inviteCode: code });
    expect(signed.status).toBe(201);
    expect((await B.get("/api/admin/beta")).body.waitlist[0].joinedAt).toBeTruthy();
  });

  it("caps the number of customers", async () => {
    const env = makeApp({ MAX_USERS: "2", ADMIN_EMAILS: "boss@example.com" });
    await admin(env); // admins don't count
    expect((await register(env.app)).status).toBe(201);
    expect((await register(env.app)).status).toBe(201);
    const third = await register(env.app);
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe("signups_full");
    expect((await request(env.app).get("/api/public/signup")).body).toMatchObject({ mode: "open", full: true, waitlist: true });
  });

  it("stays open by default", async () => {
    const env = makeApp();
    expect((await register(env.app)).status).toBe(201);
    expect((await register(env.app, { inviteCode: "WHATEVER" })).status).toBe(201); // a stray code doesn't block an open sign-up
  });
});
