import request from "supertest";
import { describe, expect, it } from "vitest";
import { totp } from "../src/lib/crypto.js";
import { luhnDigit, validAccountNumber } from "../src/services/users.js";
import { verifyLedger } from "../src/services/ledger.js";
import { statementCsv } from "../src/services/account.js";
import { api, makeApp, signup } from "./helpers.js";

type App = ReturnType<typeof makeApp>;

/** A fake photo: a JPEG header followed by enough bytes to pass the size check. */
const jpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, fill)]);
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3000, 32)]);

async function fund(A: ReturnType<typeof api>, amount: string, currency = "USD") {
  const res = await A.post("/api/payments/deposits", { rail: "sandbox", amount, currency });
  expect(res.status).toBe(201);
}

function upload(agent: ReturnType<typeof request.agent>, kind: string, body: Buffer, type = "image/jpeg") {
  return agent.post(`/api/account/documents/${kind}`).set("x-aurex-csrf", "1").set("Content-Type", type).send(body);
}

/** An admin with two-factor turned on (required for admin tools). */
async function makeAdmin({ app, ctx }: App) {
  const { agent, user } = await signup(app, "admin");
  ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const A = api(agent);
  const setup = await A.post("/api/settings/2fa/setup");
  await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });
  return { A, agent, user };
}

const identity = {
  legalName: "Amara Okafor",
  dateOfBirth: "1990-04-12",
  nationality: "ng",
  phone: "+234 803 555 0101",
  address: { line1: "12 Marina Road", city: "Lagos", country: "NG" },
  idType: "national_id",
  idNumber: "NIN 12345678901",
  idCountry: "NG",
  idExpiry: "2031-01-01",
};

describe("account numbers", () => {
  it("gives every account a unique, checkable number and lets people pay by it", async () => {
    const env = makeApp();
    const a = await signup(env.app, "payer");
    const b = await signup(env.app, "payee");
    const A = api(a.agent);
    const mine = (await A.get("/api/account")).body.account;
    expect(validAccountNumber(mine.accountNumber)).toBe(true);
    expect(mine.accountNumberFormatted).toMatch(/^\d{4} \d{3} \d{3}$/);
    const theirs = (env.ctx.db.prepare("SELECT account_number FROM users WHERE id = ?").get(b.user.id) as { account_number: string }).account_number;
    expect(theirs).not.toBe(mine.accountNumber);

    await fund(A, "50");
    const spaced = `${theirs.slice(0, 4)} ${theirs.slice(4, 7)} ${theirs.slice(7)}`;
    const sent = await A.post("/api/payments/send", { to: spaced, amount: "10", currency: "USD" });
    expect(sent.status).toBe(201);
    // One wrong digit fails the check digit, so it can't reach a stranger.
    const typo = theirs.slice(0, 9) + String((Number(theirs[9]) + 1) % 10);
    expect((await A.post("/api/payments/send", { to: typo, amount: "1", currency: "USD" })).status).toBe(404);
    expect(luhnDigit("7992739871")).toBe("3"); // the textbook Luhn example, 79927398713
  });

  it("numbers accounts that existed before account numbers", async () => {
    const { app, ctx } = makeApp();
    const { user } = await signup(app, "legacy");
    ctx.db.prepare("UPDATE users SET account_number = NULL WHERE id = ?").run(user.id);
    const { assignMissingAccountNumbers } = await import("../src/services/users.js");
    expect(assignMissingAccountNumbers(ctx)).toBe(1);
    const n = (ctx.db.prepare("SELECT account_number FROM users WHERE id = ?").get(user.id) as { account_number: string }).account_number;
    expect(validAccountNumber(n)).toBe(true);
  });
});

describe("identity verification and limits", () => {
  it("limits unverified accounts, then raises the limits once an admin approves their identity", async () => {
    const env = makeApp({ KYC_LIMITS: "true" });
    const { app, ctx } = env;
    const u = await signup(app, "kyc");
    const A = api(u.agent);
    const other = await signup(app, "friend");

    // Level 0: $200 per payment.
    expect((await A.get("/api/account")).body.account.limits).toMatchObject({ level: 0, txUsd: 200, dailyUsd: 500, tiered: true });
    const bigDeposit = await A.post("/api/payments/deposits", { rail: "sandbox", amount: "250", currency: "USD" });
    expect(bigDeposit.status).toBe(422);
    expect(bigDeposit.body.error.message).toMatch(/Verify your identity/);
    await fund(A, "200");
    await fund(A, "200");
    expect((await A.post("/api/payments/send", { to: other.user.handle, amount: "201", currency: "USD" })).body.error.code).toBe("limit_exceeded");

    // Details are checked: adults only, and the ID must be valid.
    expect((await A.put("/api/account/verification/1", { ...identity, dateOfBirth: "2012-01-01" })).body.error.message).toMatch(/18 or older/);
    expect((await A.put("/api/account/verification/1", { ...identity, idExpiry: "2020-01-01" })).body.error.message).toMatch(/expired/);
    expect((await A.put("/api/account/verification/2", {})).body.error.code).toBe("identity_first");
    const saved = await A.put("/api/account/verification/1", identity);
    expect(saved.status).toBe(200);
    expect(saved.body.identity.documents.map((d: { kind: string }) => d.kind)).toEqual(["id_front", "id_back", "selfie"]);

    // Documents: real images or PDFs only, and the selfie must be a photo.
    expect((await upload(u.agent, "id_front", Buffer.from("x".repeat(4000)), "image/jpeg")).body.error.message).toMatch(/JPEG, PNG/);
    expect((await upload(u.agent, "selfie", pdf(), "application/pdf")).body.error.message).toMatch(/photo/);
    expect((await upload(u.agent, "id_front", jpeg(1))).status).toBe(201);
    expect((await A.post("/api/account/verification/1/submit")).body.error.message).toMatch(/ID document \(back\).*Selfie/);
    expect((await upload(u.agent, "id_back", pdf(), "application/pdf")).status).toBe(201);
    const selfie = await upload(u.agent, "selfie", jpeg(2));
    expect(selfie.status).toBe(201);
    const submitted = await A.post("/api/account/verification/1/submit");
    expect(submitted.body.identity.submission.status).toBe("submitted");
    expect((await A.put("/api/account/verification/1", identity)).body.error.code).toBe("under_review");

    // Stored encrypted; the user can fetch their own document back.
    const stored = ctx.db.prepare("SELECT data_enc FROM kyc_submissions WHERE user_id = ?").get(u.user.id) as { data_enc: string };
    expect(stored.data_enc).toMatch(/^v1\./);
    expect(stored.data_enc).not.toContain("Okafor");
    const own = await u.agent.get(`/api/account/documents/${selfie.body.document.id}`);
    expect(own.headers["content-type"]).toBe("image/jpeg");
    expect(own.headers["cache-control"]).toBe("private, no-store");
    expect(own.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(Buffer.compare(own.body, jpeg(2))).toBe(0);
    expect((await other.agent.get(`/api/account/documents/${selfie.body.document.id}`)).status).toBe(404);

    // An admin reviews: sees details and documents (audited), can't review themselves.
    const admin = await makeAdmin(env);
    const queue = (await admin.A.get("/api/admin/kyc")).body.submissions;
    expect(queue).toHaveLength(1);
    expect(queue[0].data.legalName).toBe("Amara Okafor");
    const doc = await admin.agent.get(`/api/admin/kyc/documents/${queue[0].documents[0].id}`);
    expect(doc.status).toBe(200);
    const viewed = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.kyc_document_viewed'").get() as { n: number };
    expect(viewed.n).toBe(1);
    expect((await admin.A.post(`/api/admin/kyc/${queue[0].id}/review`, { decision: "reject" })).body.error.message).toMatch(/Say why/);
    expect((await admin.A.post(`/api/admin/kyc/${queue[0].id}/review`, { decision: "approve" })).status).toBe(200);

    const after = (await A.get("/api/account")).body.account;
    expect(after.limits).toMatchObject({ level: 1, txUsd: 2000, dailyUsd: 5000 });
    expect((await A.post("/api/payments/send", { to: other.user.handle, amount: "300", currency: "USD" })).status).toBe(201);
    const alerts = (await A.get("/api/settings/security")).body.alerts.map((a: { message: string }) => a.message);
    expect(alerts.some((m: string) => /identity verification was approved/.test(m))).toBe(true);

    // Level 2 can be rejected with a reason, then fixed and resubmitted.
    const enhanced = { occupation: "Engineer", sourceOfFunds: "salary", sourceDetails: "Monthly salary from my employer", expectedMonthlyUsd: "1k_5k", pep: false, proofOfAddressDate: new Date().toISOString().slice(0, 10) };
    expect((await A.put("/api/account/verification/2", { ...enhanced, pep: true })).body.error.message).toMatch(/public role/);
    await A.put("/api/account/verification/2", enhanced);
    await upload(u.agent, "proof_of_address", pdf(), "application/pdf");
    await A.post("/api/account/verification/2/submit");
    const l2 = (await admin.A.get("/api/admin/kyc")).body.submissions[0];
    await admin.A.post(`/api/admin/kyc/${l2.id}/review`, { decision: "reject", note: "The bill is too blurry" });
    const rejected = (await A.get("/api/account/verification")).body.enhanced.submission;
    expect(rejected).toMatchObject({ status: "rejected", reviewNote: "The bill is too blurry" });
    expect((await A.put("/api/account/verification/2", enhanced)).status).toBe(200);
  });

  it("lets admins set limits and levels for others, but not for themselves", async () => {
    const env = makeApp({ KYC_LIMITS: "true" });
    const u = await signup(env.app, "limited");
    const A = api(u.agent);
    const admin = await makeAdmin(env);
    expect((await admin.A.post(`/api/admin/users/${u.user.id}/limits`, { txUsd: 1000, dailyUsd: 3000 })).status).toBe(200);
    expect((await A.get("/api/account")).body.account.limits).toMatchObject({ txUsd: 1000, dailyUsd: 3000, overridden: true });
    await fund(A, "900");
    expect((await admin.A.post(`/api/admin/users/${u.user.id}/kyc-level`, { level: 2, note: "Checked in branch" })).status).toBe(200);
    expect((await A.get("/api/account")).body.account.limits.level).toBe(2);
    expect((await admin.A.post(`/api/admin/users/${admin.user.id}/kyc-level`, { level: 2, note: "myself" })).status).toBe(403);
    expect((await admin.A.post(`/api/admin/users/${admin.user.id}/limits`, { txUsd: null, dailyUsd: null })).status).toBe(400);
    // Staff accounts aren't tiered.
    expect((await admin.A.get("/api/account")).body.account.limits.tiered).toBe(false);
  });
});

describe("statements", () => {
  it("builds a monthly statement with opening, running and closing balances, as JSON and CSV", async () => {
    const { app, ctx } = makeApp();
    const a = await signup(app, "stmt");
    const b = await signup(app, "stmtb");
    const A = api(a.agent);
    await fund(A, "100");
    await A.post("/api/payments/send", { to: b.user.handle, amount: "30", currency: "USD", memo: "=HYPERLINK(\"x\")" });
    const period = new Date().toISOString().slice(0, 7);
    const periods = (await A.get("/api/account/statements")).body;
    expect(periods.periods[0]).toBe(period);
    expect(periods.currencies).toContain("USD");

    const st = (await A.get(`/api/account/statements/${period}?currency=USD`)).body.statement;
    expect(st).toMatchObject({ currency: "USD", openingBalance: "0.00", moneyIn: "100.00", closingBalance: "70.00" });
    expect(st.lines.map((l: { balance: string }) => l.balance)).toEqual(["100.00", "70.00"]);
    expect(st.lines[1].description).toBe(`Payment to @${b.user.handle} · =HYPERLINK("x")`);

    const csv = await a.agent.get(`/api/account/statements/${period}?currency=USD&format=csv`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["content-disposition"]).toContain(`aurex-statement-${period}-USD.csv`);
    expect(csv.text).toContain('"Closing balance","70.00"');
    expect(csv.text).toContain(`"Payment to @${b.user.handle}`);
    // A cell that starts like a formula is neutralised, so it can't run in a spreadsheet.
    const crafted = statementCsv({ ...st, lines: [{ ...st.lines[0], description: '=HYPERLINK("http://evil")' }] });
    expect(crafted).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(crafted).not.toMatch(/,"=/);
    expect((await A.get("/api/account/statements/2999-01?currency=USD")).status).toBe(400);
    expect((await A.get(`/api/account/statements/${period}?currency=JPY`)).status).toBe(404);
    expect(verifyLedger(ctx).ok).toBe(true);
  });
});

describe("your data and closing the account", () => {
  it("exports the user's data without secrets", async () => {
    const { app } = makeApp();
    const u = await signup(app, "exporter");
    const A = api(u.agent);
    await fund(A, "20");
    await A.put("/api/account/verification/1", identity);
    const res = await A.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="aurex-data-/);
    const data = res.body;
    expect(data.profile).toMatchObject({ handle: u.user.handle, email: u.user.email });
    expect(data.wallets[0]).toMatchObject({ currency: "USD", balance: "20.00" });
    expect(data.transactions).toHaveLength(1);
    expect(data.verification.submissions[0].details.legalName).toBe("Amara Okafor");
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/password_hash|\$scrypt|totp_secret|key_enc/);
  });

  it("closes an account only when nothing is outstanding, and admins can reopen it", async () => {
    const env = makeApp();
    const u = await signup(env.app, "leaver");
    const friend = await signup(env.app, "keeper");
    const A = api(u.agent);
    await fund(A, "15");
    const blocked = await A.post("/api/account/close", { confirmHandle: u.user.handle });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/USD 15.00/);
    expect((await A.get("/api/account")).body.closureBlockers).toHaveLength(1);

    await A.post("/api/payments/send", { to: friend.user.handle, amount: "15", currency: "USD" });
    expect((await A.post("/api/account/close", { confirmHandle: "someone-else" })).status).toBe(400);
    const closed = await A.post("/api/account/close", { confirmHandle: `@${u.user.handle}` });
    expect(closed.status).toBe(200);

    // Signed out everywhere, can't sign in, can't be paid, but the ledger is intact.
    expect((await u.agent.get("/api/account")).status).toBe(401);
    const login = await request(env.app).post("/api/auth/login").set("x-aurex-csrf", "1").send({ email: u.user.email, password: "correct-horse-42" });
    expect(login.body.error.code).toBe("account_closed");
    expect((await api(friend.agent).post("/api/payments/send", { to: u.user.handle, amount: "1", currency: "USD" })).status).toBe(422);
    expect(verifyLedger(env.ctx).ok).toBe(true);

    const admin = await makeAdmin(env);
    const found = (await admin.A.get(`/api/admin/users?q=${u.user.handle}`)).body.users;
    expect(found[0]).toMatchObject({ handle: u.user.handle, closedAt: expect.any(String) });
    const detail = (await admin.A.get(`/api/admin/users/${u.user.id}`)).body;
    expect(detail.user.status).toBe("closed");
    expect(detail.activity).toHaveLength(2);
    await admin.A.post(`/api/admin/users/${u.user.id}/notes`, { note: "Closed at the customer's request" });
    expect((await admin.A.get(`/api/admin/users/${u.user.id}`)).body.notes[0].note).toMatch(/customer's request/);
    expect((await admin.A.post(`/api/admin/users/${u.user.id}/status`, { status: "active" })).status).toBe(200);
    const again = await request(env.app).post("/api/auth/login").set("x-aurex-csrf", "1").send({ email: u.user.email, password: "correct-horse-42" });
    expect(again.status).toBe(200);
  });

  it("finds accounts by account number in admin search", async () => {
    const env = makeApp();
    const u = await signup(env.app, "findme");
    const n = (env.ctx.db.prepare("SELECT account_number FROM users WHERE id = ?").get(u.user.id) as { account_number: string }).account_number;
    const admin = await makeAdmin(env);
    const found = (await admin.A.get(`/api/admin/users?q=${n.slice(0, 4)}%20${n.slice(4)}`)).body.users;
    expect(found.map((x: { id: string }) => x.id)).toEqual([u.user.id]);
  });
});
