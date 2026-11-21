import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { totp } from "../src/lib/crypto.js";
import { api, makeApp, signup } from "./helpers.js";
import { stub } from "./stub.js";

describe("database upgrades", () => {
  it("rebuilds the safeguarding accounts table without losing accounts or their immutable balance history", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aurex-mig-")), "aurex.db");
    // A database as it was before migration 23, with an account and a recorded balance pointing to it.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 22; v++) {
      const m = migrations[v];
      old.exec(typeof m === "string" ? m : m.sql);
    }
    old.exec("PRAGMA user_version = 22");
    old.exec(`INSERT INTO users (id, email, handle, display_name, password_hash, created_at) VALUES ('usr_admin', 'a@example.com', 'boss', 'Boss', 'x', '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO safeguarding_accounts (id, name, kind, institution, currency, purpose, source, active, created_by, created_at, updated_at)
              VALUES ('sga_1', 'Trust account', 'bank', 'Equity Bank', 'KES', 'safeguarding', 'manual', 1, 'usr_admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    old.exec(`INSERT INTO safeguarding_balances (account_id, balance_minor, as_of, source, recorded_by, note, created_at)
              VALUES ('sga_1', 12500000, '2026-01-02T00:00:00.000Z', 'manual', 'usr_admin', 'statement', '2026-01-02T00:00:00.000Z')`);
    old.close();

    const db = openDb(path);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(migrations.length);
    expect(db.prepare("SELECT id, name, source FROM safeguarding_accounts").all()).toEqual([{ id: "sga_1", name: "Trust account", source: "manual" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM safeguarding_balances WHERE account_id = 'sga_1'").get() as { n: number }).n).toBe(1);
    // Airtel is now allowed, links are still enforced, and the balance history is still immutable.
    db.exec(`UPDATE safeguarding_accounts SET source = 'airtel' WHERE id = 'sga_1'`);
    expect(() => db.exec("INSERT INTO safeguarding_balances (account_id) VALUES ('missing')")).toThrow();
    expect(() => db.exec("DELETE FROM safeguarding_balances")).toThrow(/immutable/);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it("reads an Airtel Money wallet balance into the safeguarding check", async () => {
    const airtel = await stub((r) => {
      if (r.route === "/auth/oauth2/token") return { body: { access_token: "air-token", expires_in: 180 } };
      if (r.route === "/standard/v1/users/balance" && r.headers.authorization === "Bearer air-token" && r.headers["x-country"] === "KE") {
        return { body: { data: { balance: "84210.50", currency: "KES", account_status: "Active" }, status: { success: true } } };
      }
      return { status: 404, body: {} };
    });
    const env = makeApp({ AIRTEL_CLIENT_ID: "id", AIRTEL_CLIENT_SECRET: "secret", AIRTEL_BASE_URL: airtel.url, AIRTEL_COUNTRY: "KE", AIRTEL_CURRENCY: "KES" });
    const { agent, user } = await signup(env.app, "treasurer");
    env.ctx.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const A = api(agent);
    const setup = await A.post("/api/settings/2fa/setup");
    await A.post("/api/settings/2fa/confirm", { code: totp(setup.body.secret) });

    const acct = (await A.post("/api/admin/safeguarding/accounts", { name: "Airtel KES", kind: "mobile_money", institution: "Airtel Money", currency: "KES", source: "airtel" })).body.account;
    expect(acct.source).toBe("airtel");
    const r = (await A.post("/api/admin/safeguarding/refresh")).body.results;
    expect(r).toEqual([{ account: "Airtel KES", ok: true, message: "KES 84210.50" }]);
    const hist = (await A.get(`/api/admin/safeguarding/accounts/${acct.id}/balances`)).body.balances;
    expect(hist[0]).toMatchObject({ balance: "84210.50", source: "api" });
  });
});
