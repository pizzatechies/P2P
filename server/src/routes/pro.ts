import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { cancel, proOverview, resume, subscribe } from "../services/pro.js";

export function proRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const limiter = rateLimit({ name: "pro", windowMs: 60_000, max: ctx.config.isTest ? 10_000 : 10, key: (req) => req.user!.id });

  r.get("/", async (req, res) => {
    res.json(await proOverview(ctx, req.user!.id));
  });
  r.post("/subscribe", limiter, async (req, res) => {
    const { currency } = parse(z.object({ currency: z.string().length(3).optional() }), req.body ?? {});
    res.status(201).json(await subscribe(ctx, req.user!.id, currency, req.ip));
  });
  r.post("/cancel", limiter, async (req, res) => {
    res.json(await cancel(ctx, req.user!.id, req.ip));
  });
  r.post("/resume", limiter, async (req, res) => {
    res.json(await resume(ctx, req.user!.id, req.ip));
  });
  return r;
}
