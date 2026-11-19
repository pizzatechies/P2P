import { Router } from "express";
import { businessName } from "../services/business.js";
import { joinWaitlist, signupStatus } from "../services/beta.js";
import { parse } from "../lib/validate.js";
import { rateLimit } from "../lib/rateLimit.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { notFound } from "../lib/errors.js";
import { findUserByIdentifier, publicProfile } from "../services/users.js";

/** Unauthenticated endpoints used by shareable pages (e.g. /pay/@handle links). */
export function publicRoutes(ctx: Ctx) {
  const r = Router();
  /** Who can sign up right now (the sign-up page shows an invite field or the waitlist). */
  r.get("/signup", (_req, res) => {
    res.json(signupStatus(ctx));
  });

  const waitlistLimiter = rateLimit({ name: "waitlist", windowMs: 60 * 60_000, max: ctx.config.isTest ? 10_000 : 10 });
  r.post("/waitlist", waitlistLimiter, (req, res) => {
    const body = parse(z.object({ email: z.string().max(200), name: z.string().max(80).optional(), country: z.string().max(2).optional() }), req.body);
    res.status(201).json(joinWaitlist(ctx, body.email, body.name, body.country));
  });

  r.get("/users/:handle", (req, res) => {
    const handle = String(req.params.handle).replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) throw notFound("No one with that handle");
    const user = findUserByIdentifier(ctx, `@${handle}`);
    if (!user || user.status !== "active") throw notFound("No one with that handle");
    const business = businessName(ctx, user.id);
    res.json({ user: { ...publicProfile(user), business: business ? { name: business } : null } });
  });
  return r;
}
