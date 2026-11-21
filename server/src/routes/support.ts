import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { CATEGORIES, caseDetail, customerReply, listOwnCases, makeComplaint, openCase } from "../services/support.js";

/** Help: a customer's own support cases and complaints. */
export function supportRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const openLimiter = rateLimit({ name: "support-open", windowMs: 60 * 60_000, max: ctx.config.isTest ? 10_000 : 10, key: (req) => req.user!.id });
  const replyLimiter = rateLimit({ name: "support-reply", windowMs: 60 * 60_000, max: ctx.config.isTest ? 10_000 : 60, key: (req) => req.user!.id });
  const body = z.string().trim().min(2).max(5000);

  r.get("/cases", (req, res) => {
    res.json({ cases: listOwnCases(ctx, req.user!.id) });
  });

  r.post("/cases", openLimiter, (req, res) => {
    const input = parse(z.object({ category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(120), message: body }), req.body);
    res.status(201).json(openCase(ctx, req.user!.id, input, req.ip));
  });

  r.get("/cases/:id", (req, res) => {
    res.json(caseDetail(ctx, req.user!.id, String(req.params.id)));
  });

  r.post("/cases/:id/messages", replyLimiter, (req, res) => {
    const input = parse(z.object({ body }), req.body);
    res.json(customerReply(ctx, req.user!.id, String(req.params.id), input.body, req.ip));
  });

  r.post("/cases/:id/complaint", openLimiter, (req, res) => {
    res.json(makeComplaint(ctx, req.user!.id, String(req.params.id), req.ip));
  });

  return r;
}
