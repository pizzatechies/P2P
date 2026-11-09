import { Router } from "express";
import type { Ctx } from "../context.js";
import { notFound } from "../lib/errors.js";
import { findUserByIdentifier, publicProfile } from "../services/users.js";

/** Unauthenticated endpoints used by shareable pages (e.g. /pay/@handle links). */
export function publicRoutes(ctx: Ctx) {
  const r = Router();
  r.get("/users/:handle", (req, res) => {
    const handle = String(req.params.handle).replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) throw notFound("No one with that handle");
    const user = findUserByIdentifier(ctx, `@${handle}`);
    if (!user || user.status !== "active") throw notFound("No one with that handle");
    res.json({ user: publicProfile(user) });
  });
  return r;
}
