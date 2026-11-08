import type { NextFunction, Request, Response } from "express";
import type { Ctx } from "../context.js";
import { forbidden, HttpError, unauthorized } from "../lib/errors.js";
import { toAuthUser, userForSessionToken } from "../services/users.js";

export const SESSION_COOKIE = "p2p_session";
export const CSRF_HEADER = "x-p2p-csrf";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function setSessionCookie(ctx: Ctx, res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.isProd,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(ctx: Ctx, res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: ctx.config.isProd, sameSite: "lax", path: "/" });
}

/** Resolves the session cookie (if any) into req.user. Never rejects; use requireAuth for that. */
export function loadSession(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const found = userForSessionToken(ctx, token);
      if (found) {
        req.user = toAuthUser(found.user);
        req.sessionId = found.sessionId;
      }
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.status !== "active") return next(new HttpError(403, "account_frozen", "This account is frozen"));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "admin") return next(forbidden("Admins only"));
  next();
}

/**
 * CSRF defence for cookie-authenticated requests: every state-changing call must carry a custom
 * header. Browsers can't add custom headers cross-origin without a CORS preflight, which this
 * server never approves, so a forged form post from another site is rejected.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.headers[CSRF_HEADER] !== "1") {
    return next(new HttpError(403, "csrf", "Missing CSRF header"));
  }
  next();
}
