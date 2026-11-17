import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { openDb, type DB } from "./db/index.js";
import { HttpError } from "./lib/errors.js";
import { rateLimit } from "./lib/rateLimit.js";
import { csrfGuard, loadSession, originGuard } from "./middleware/auth.js";
import { accountRoutes } from "./routes/account.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { learnRoutes } from "./routes/learn.js";
import { metaRoutes } from "./routes/meta.js";
import { paymentRoutes } from "./routes/payments.js";
import { publicRoutes } from "./routes/public.js";
import { settingsRoutes } from "./routes/settings.js";
import { tradingRoutes } from "./routes/trading.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { rekeySecrets } from "./services/rekey.js";
import { assignMissingAccountNumbers } from "./services/users.js";

/** Strips secrets that can appear in URLs (the M-Pesa callback token) before anything is logged. */
export function redactUrl(url: string) {
  return url.replace(/(\/api\/webhooks\/mpesa\/)[^/?#]+/, "$1[redacted]");
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
  "interest-cohort=()",
  "browsing-topics=()",
].join(", ");

export interface App {
  app: express.Express;
  ctx: Ctx;
}

export function createApp(config: Config, db: DB = openDb(config.DATABASE_PATH)): App {
  const ctx: Ctx = { config, db };
  const app = express();

  const rekey = rekeySecrets(ctx);
  assignMissingAccountNumbers(ctx);
  if (rekey.rekeyed || rekey.unreadable) {
    console.warn(`[security] re-encrypted ${rekey.rekeyed} secret(s) with the current MASTER_KEY; ${rekey.unreadable} could not be read with any configured key`);
  }

  app.disable("x-powered-by");
  if (config.TRUST_PROXY) app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "script-src-attr": ["'none'"],
          "connect-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "media-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "font-src": ["'self'", "https://fonts.gstatic.com"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          "frame-src": ["'none'"],
          "worker-src": ["'self'"],
          "manifest-src": ["'self'"],
          // Only force HTTPS sub-requests in production; in development it breaks plain-HTTP access
          // from other devices on the network (e.g. testing on a phone via http://192.168.x.x).
          "upgrade-insecure-requests": config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      // Two years, every subdomain, and eligible for browsers' built-in HTTPS-only list.
      strictTransportSecurity: config.isProd ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: "no-referrer" },
      xFrameOptions: { action: "deny" },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
    next();
  });

  // Vulnerability disclosure contact (RFC 9116).
  app.get("/.well-known/security.txt", (_req, res) => {
    const expires = new Date(Date.now() + 180 * 86_400_000).toISOString();
    res
      .type("text/plain")
      .send(
        `Contact: ${new URL("/security", config.APP_URL).toString()}\nContact: https://github.com/pizzatechies/P2P/security/advisories/new\nExpires: ${expires}\nPreferred-Languages: en\nPolicy: https://github.com/pizzatechies/P2P/blob/claude/gifted-ritchie-8xzdk9/SECURITY.md\n`,
      );
  });

  // Webhooks need the exact raw bytes for signature verification, so they're mounted before the
  // JSON parser and don't go through session/CSRF middleware.
  // Nothing from the API may be stored by browsers or shared caches (balances, keys, sessions).
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use(
    "/api/webhooks",
    rateLimit({ name: "webhooks", windowMs: 60_000, max: config.isTest ? 100_000 : 120 }),
    express.raw({ type: "*/*", limit: "1mb" }),
    webhookRoutes(ctx),
  );

  app.use(express.json({ limit: "256kb", strict: true }));
  app.use("/api", rateLimit({ name: "api", windowMs: 60_000, max: config.isTest ? 100_000 : 600 }));
  app.use("/api", originGuard(ctx), loadSession(ctx), csrfGuard);

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use("/api", metaRoutes(ctx));
  app.use("/api/auth", authRoutes(ctx));
  app.use("/api/public", publicRoutes(ctx));
  app.use("/api/settings", settingsRoutes(ctx));
  app.use("/api/account", accountRoutes(ctx));
  app.use("/api/payments", paymentRoutes(ctx));
  app.use("/api/connections", connectionRoutes(ctx));
  app.use("/api/ai", aiRoutes(ctx));
  app.use("/api/trading", tradingRoutes(ctx));
  app.use("/api/learn", learnRoutes(ctx));
  app.use("/api/admin", adminRoutes(ctx));

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "No such endpoint")));

  // In production the API also serves the built web app.
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [resolve(here, "../../web/dist"), resolve(process.cwd(), "web/dist")].find((p) =>
    existsSync(join(p, "index.html")),
  );
  if (webDist) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: "bad_request", message: "Invalid request", details: err.issues } });
    }
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (status && status >= 400 && status < 500) {
      // e.g. malformed JSON from express.json()
      return res.status(status).json({ error: { code: "bad_request", message: (err as Error).message } });
    }
    console.error(`[error] ${req.method} ${redactUrl(req.originalUrl)}`, err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side" } });
  });

  return { app, ctx };
}
