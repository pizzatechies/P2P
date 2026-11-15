import type { NextFunction, Request, Response } from "express";
import type { Ctx } from "../context.js";
import { forbidden, HttpError, unauthorized } from "../lib/errors.js";
import { assertRecentAuth } from "../services/security.js";
import { toAuthUser, userForSessionToken } from "../services/users.js";

export const SESSION_COOKIE = "aurex_session";
export const CSRF_HEADER = "x-aurex-csrf";

/**
 * In production the cookie uses the __Host- prefix: browsers then only accept it over HTTPS, for
 * this exact host, on path "/", so a sibling subdomain can't set or overwrite it.
 */
export const sessionCookieName = (ctx: Ctx) => (ctx.config.isProd ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE);

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
  res.cookie(sessionCookieName(ctx), token, {
    httpOnly: true,
    secure: ctx.config.isProd,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(ctx: Ctx, res: Response) {
  res.clearCookie(sessionCookieName(ctx), { httpOnly: true, secure: ctx.config.isProd, sameSite: "lax", path: "/" });
}

/** Resolves the session cookie (if any) into req.user. Never rejects; use requireAuth for that. */
export function loadSession(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[sessionCookieName(ctx)];
    if (token) {
      const found = userForSessionToken(ctx, token);
      if (found) {
        req.user = toAuthUser(found.user);
        req.sessionId = found.sessionId;
        req.reauthAt = found.reauthAt;
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

export function requireAdmin(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== "admin") return next(forbidden("Admins only"));
    if (req.user.status !== "active") return next(new HttpError(403, "account_frozen", "This account is frozen"));
    if (ctx.config.REQUIRE_ADMIN_2FA && !req.user.totpEnabled) {
      return next(new HttpError(403, "admin_2fa_required", "Turn on two-factor authentication to use admin tools"));
    }
    next();
  };
}

/** Sensitive actions (withdrawals, keys, admin changes) need a password/2FA check within the last few minutes. */
export function requireRecentAuth(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      assertRecentAuth(ctx, req.reauthAt);
      next();
    } catch (err) {
      next(err);
    }
  };
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * Second CSRF layer: state-changing requests must not come from another site. Browsers send
 * Sec-Fetch-Site and Origin on such requests; anything cross-site, or from an origin other than
 * APP_URL (or ALLOWED_ORIGINS), is refused. Requests without these headers (server-to-server, tests)
 * still need the custom CSRF header below.
 */
export function originGuard(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.headers["sec-fetch-site"] === "cross-site") return next(new HttpError(403, "csrf", "Cross-site request refused"));
    const origin = req.headers.origin;
    if (origin && origin !== "null" && !ctx.config.allowedOrigins.has(origin)) {
      let host = "";
      try {
        host = new URL(origin).hostname;
      } catch {
        /* malformed */
      }
      // In development, phones and other devices on the local network may use a LAN address.
      if (ctx.config.isProd || !PRIVATE_HOST.test(host)) return next(new HttpError(403, "csrf", "Request origin not allowed"));
    }
    next();
  };
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
