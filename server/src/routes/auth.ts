import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { clearSessionCookie, requireAuth, setSessionCookie } from "../middleware/auth.js";
import {
  audit,
  authenticate,
  createSession,
  destroySession,
  registerUser,
  toAuthUser,
} from "../services/users.js";

const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Include at least one letter and one number");

const RegisterBody = z.object({
  email: z.string().email().max(200),
  handle: z
    .string()
    .trim()
    .transform((h) => h.replace(/^@/, ""))
    .pipe(z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, "3-20 letters, numbers or underscores")),
  displayName: z.string().trim().min(1).max(60),
  password,
  defaultCurrency: z.string().length(3).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totpCode: z.string().max(10).optional(),
});

export function authRoutes(ctx: Ctx) {
  const r = Router();
  const limiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: ctx.config.isTest ? 1000 : 20 });

  r.post("/register", limiter, async (req, res) => {
    const body = parse(RegisterBody, req.body);
    const user = await registerUser(ctx, body);
    const session = createSession(ctx, user.id, { ip: req.ip, userAgent: req.get("user-agent") });
    audit(ctx, user.id, "auth.register", {}, req.ip);
    setSessionCookie(ctx, res, session.token, session.expiresAt);
    res.status(201).json({ user: toAuthUser(user) });
  });

  r.post("/login", limiter, async (req, res) => {
    const body = parse(LoginBody, req.body);
    try {
      const user = await authenticate(ctx, body);
      const session = createSession(ctx, user.id, { ip: req.ip, userAgent: req.get("user-agent") });
      audit(ctx, user.id, "auth.login", {}, req.ip);
      setSessionCookie(ctx, res, session.token, session.expiresAt);
      res.json({ user: toAuthUser(user) });
    } catch (err) {
      audit(ctx, null, "auth.login_failed", { email: body.email.toLowerCase() }, req.ip);
      throw err;
    }
  });

  r.post("/logout", (req, res) => {
    if (req.sessionId) destroySession(ctx, req.sessionId);
    clearSessionCookie(ctx, res);
    res.json({ ok: true });
  });

  r.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return r;
}
