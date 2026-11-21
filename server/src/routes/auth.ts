import { Router } from "express";
import { screenForCustomer } from "../services/sanctions.js";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { HttpError } from "../lib/errors.js";
import { verifyPassword } from "../lib/crypto.js";
import { clearSessionCookie, requireAuth, setSessionCookie } from "../middleware/auth.js";
import {
  addAlert,
  assertNotLocked,
  checkSecondFactor,
  describeDevice,
  isNewDevice,
  markReauthenticated,
  reauthValidUntil,
  recordFailedAttempt,
  recordSuccessfulAttempt,
} from "../services/security.js";
import { sendVerificationCode, verifyEmailCode } from "../services/email.js";
import { checkResetLink, requestPasswordReset, resetPassword } from "../services/passwordReset.js";
import { verifyCaptcha } from "../services/captcha.js";
import { audit, authenticate, createSession, destroySession, getUserRow, registerUser, toAuthUser } from "../services/users.js";

// Full strength rules (length, common and breached passwords) are checked in the service.
const password = z.string().min(1).max(200);

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
  inviteCode: z.string().trim().max(40).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totpCode: z.string().max(20).optional(),
});

export function authRoutes(ctx: Ctx) {
  const r = Router();
  const limiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: ctx.config.isTest ? 1000 : 20 });
  const signupLimiter = rateLimit({ name: "signup", windowMs: 60 * 60_000, max: ctx.config.isTest ? 1000 : 10 });
  const emailLimiter = rateLimit({ name: "email-verify", windowMs: 60 * 60_000, max: ctx.config.isTest ? 1000 : 20, key: (req) => req.user?.id ?? req.ip ?? "" });
  const reauthLimiter = rateLimit({ name: "reauth", windowMs: 15 * 60_000, max: ctx.config.isTest ? 1000 : 15, key: (req) => req.user?.id ?? req.ip ?? "" });

  r.post("/register", signupLimiter, limiter, async (req, res) => {
    const body = parse(RegisterBody, req.body);
    await verifyCaptcha(ctx, req.body?.captchaToken, req.ip);
    const user = await registerUser(ctx, body);
    const ua = req.get("user-agent")?.slice(0, 300) ?? "";
    const session = createSession(ctx, user.id, { ip: req.ip, userAgent: ua });
    audit(ctx, user.id, "auth.register", { ua }, req.ip);
    screenForCustomer(ctx, user.id, user.display_name, "display_name");
    setSessionCookie(ctx, res, session.token, session.expiresAt);
    const emailVerification = ctx.config.emailDelivery === "none" ? null : await sendVerificationCode(ctx, user).catch(() => null);
    res.status(201).json({ user: toAuthUser(user), emailVerification });
  });

  r.post("/login", limiter, async (req, res) => {
    const body = parse(LoginBody, req.body);
    await verifyCaptcha(ctx, req.body?.captchaToken, req.ip);
    try {
      const { user } = await authenticate(ctx, body, req.ip);
      const ua = req.get("user-agent")?.slice(0, 300) ?? "";
      const session = createSession(ctx, user.id, { ip: req.ip, userAgent: ua });
      if (isNewDevice(ctx, user.id, ua, session.sessionId)) {
        addAlert(ctx, user.id, "new_device", `New sign-in from ${describeDevice(ua)}${req.ip ? ` (IP ${req.ip})` : ""}. If this wasn't you, change your password and sign out other devices.`, req.ip);
      }
      audit(ctx, user.id, "auth.login", { ua }, req.ip);
      setSessionCookie(ctx, res, session.token, session.expiresAt);
      res.json({ user: toAuthUser(user) });
    } catch (err) {
      if (err instanceof HttpError && err.code !== "totp_required") audit(ctx, null, "auth.login_failed", { email: body.email.toLowerCase(), reason: err.code }, req.ip);
      throw err;
    }
  });

  /**
   * Step-up check: confirms the password (and 2FA) again inside an existing session, unlocking
   * sensitive actions such as withdrawals for REAUTH_WINDOW_MINUTES.
   */
  r.post("/reauth", requireAuth, reauthLimiter, async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().max(20).optional() }), req.body);
    const user = getUserRow(ctx, req.user!.id);
    assertNotLocked(user);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      recordFailedAttempt(ctx, user, req.ip);
      throw new HttpError(401, "bad_password", "That password is incorrect");
    }
    if (user.totp_enabled) {
      if (!body.code) throw new HttpError(401, "totp_required", "Enter the code from your authenticator app");
      if (!checkSecondFactor(ctx, user, body.code)) {
        recordFailedAttempt(ctx, user, req.ip);
        throw new HttpError(401, "totp_invalid", "That code is not valid (each code works only once)");
      }
    }
    recordSuccessfulAttempt(ctx, user.id);
    markReauthenticated(ctx, req.sessionId!);
    audit(ctx, user.id, "auth.reauth", {}, req.ip);
    res.json({ ok: true, until: reauthValidUntil(ctx, new Date().toISOString()) });
  });

  /** Sends (or re-sends) the 6-digit email verification code. */
  r.post("/email/send", requireAuth, emailLimiter, async (req, res) => {
    res.json(await sendVerificationCode(ctx, getUserRow(ctx, req.user!.id)));
  });

  r.post("/email/verify", requireAuth, emailLimiter, (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }), req.body);
    verifyEmailCode(ctx, req.user!.id, code);
    audit(ctx, req.user!.id, "security.email_verified", {}, req.ip);
    res.json({ user: toAuthUser(getUserRow(ctx, req.user!.id)) });
  });

  // ---- Forgot password: a single-use link to the confirmed email address ----
  const resetLimiter = rateLimit({ name: "password-reset", windowMs: 60 * 60_000, max: ctx.config.isTest ? 1000 : 10 });
  r.post("/password/forgot", resetLimiter, async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().max(200) }), req.body);
    await verifyCaptcha(ctx, req.body?.captchaToken, req.ip);
    res.json(await requestPasswordReset(ctx, email, req.ip));
  });

  // The token travels in the request body, never in a URL the server might log.
  r.post("/password/reset/check", resetLimiter, (req, res) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.body);
    res.json(checkResetLink(ctx, token));
  });

  r.post("/password/reset", resetLimiter, async (req, res) => {
    const body = parse(z.object({ token: z.string().max(200), password, code: z.string().max(20).optional() }), req.body);
    res.json(await resetPassword(ctx, body.token, body.password, body.code, req.ip));
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
