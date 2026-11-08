import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all, one, run } from "../db/index.js";
import { notFound } from "../lib/errors.js";
import { fromMinor } from "../lib/money.js";
import { parse } from "../lib/validate.js";
import { requireAdmin } from "../middleware/auth.js";
import { verifyLedger } from "../services/ledger.js";
import { audit } from "../services/users.js";

export function adminRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAdmin);

  r.get("/overview", (_req, res) => {
    const users = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM users")!.n;
    const journals = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM journals")!.n;
    const system = all<{ code: string; currency: string; balance: number }>(
      ctx.db,
      "SELECT code, currency, balance FROM accounts WHERE owner_type = 'system' ORDER BY code, currency",
    ).map((a) => ({ ...a, balance: fromMinor(a.balance, a.currency) }));
    const customerFunds = all<{ currency: string; total: number }>(
      ctx.db,
      "SELECT currency, SUM(balance) AS total FROM accounts WHERE owner_type = 'user' GROUP BY currency",
    ).map((a) => ({ currency: a.currency, total: fromMinor(a.total, a.currency) }));
    res.json({ users, journals, systemAccounts: system, customerFunds, ledger: verifyLedger(ctx) });
  });

  r.get("/users", (_req, res) => {
    res.json({
      users: all(
        ctx.db,
        "SELECT id, email, handle, display_name AS displayName, role, status, kyc_level AS kycLevel, created_at AS createdAt FROM users ORDER BY created_at DESC LIMIT 200",
      ),
    });
  });

  r.post("/users/:id/status", (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["active", "frozen"]) }), req.body);
    const changed = run(ctx.db, "UPDATE users SET status = ? WHERE id = ?", status, req.params.id);
    if (Number(changed.changes) === 0) throw notFound("User not found");
    if (status === "frozen") run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", req.params.id);
    audit(ctx, req.user!.id, "admin.user_status", { target: req.params.id, status }, req.ip);
    res.json({ ok: true });
  });

  return r;
}
