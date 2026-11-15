import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all, one, run } from "../db/index.js";
import { HttpError, notFound } from "../lib/errors.js";
import { fromMinor } from "../lib/money.js";
import { parse } from "../lib/validate.js";
import { requireAdmin, requireRecentAuth } from "../middleware/auth.js";
import { verifyLedger } from "../services/ledger.js";
import { audit } from "../services/users.js";

export function adminRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAdmin(ctx));

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

  r.post("/users/:id/status", requireRecentAuth(ctx), (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["active", "frozen"]) }), req.body);
    const target = String(req.params.id);
    if (target === req.user!.id) throw new HttpError(400, "bad_request", "You can't change your own account's status");
    const changed = run(ctx.db, "UPDATE users SET status = ? WHERE id = ?", status, target);
    if (Number(changed.changes) === 0) throw notFound("User not found");
    if (status === "frozen") run(ctx.db, "DELETE FROM sessions WHERE user_id = ?", target);
    audit(ctx, req.user!.id, "admin.user_status", { target, status }, req.ip);
    res.json({ ok: true });
  });

  return r;
}
