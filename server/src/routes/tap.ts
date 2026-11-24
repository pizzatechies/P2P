import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { toMinor } from "../lib/money.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { cancelTapPayment, connectionToken, refreshTapPayment, startTapPayment, tapOverview } from "../services/tapToPay.js";

const Start = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().length(3),
  note: z.string().max(140).optional(),
});

/** Tap to Pay for approved businesses: take contactless payments on this phone. */
export function tapRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  r.get("/", (req, res) => {
    res.json(tapOverview(ctx, req.user!.id));
  });
  r.post("/connection-token", async (req, res) => {
    res.json(await connectionToken(ctx, req.user!.id));
  });
  r.post("/payments", async (req, res) => {
    const body = parse(Start, req.body);
    res.status(201).json(await startTapPayment(ctx, req.user!.id, { amountMinor: toMinor(body.amount, body.currency), currency: body.currency, note: body.note }, req.ip));
  });
  r.get("/payments/:id", async (req, res) => {
    res.json(await refreshTapPayment(ctx, req.user!.id, String(req.params.id)));
  });
  r.post("/payments/:id/cancel", async (req, res) => {
    res.json(await cancelTapPayment(ctx, req.user!.id, String(req.params.id)));
  });
  return r;
}
