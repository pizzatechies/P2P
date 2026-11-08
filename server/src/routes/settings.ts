import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all } from "../db/index.js";
import { badRequest, unprocessable } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { testCredentials } from "../services/ai/gateway.js";
import { BYOK_PROVIDERS } from "../services/ai/providers.js";
import { deleteUserKey, listUserKeys, saveUserKey } from "../services/keys.js";
import {
  audit,
  beginTotpSetup,
  changePassword,
  confirmTotpSetup,
  disableTotp,
  toAuthUser,
  updateProfile,
} from "../services/users.js";

const ProfileBody = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  defaultCurrency: z.string().length(3).optional(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(10, "Use at least 10 characters")
    .max(200)
    .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Include at least one letter and one number"),
});

const KeyBody = z.object({
  apiKey: z.string().trim().min(8).max(500),
  verify: z.boolean().default(true),
});

export function settingsRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  const sensitive = rateLimit({ name: "settings", windowMs: 15 * 60_000, max: ctx.config.isTest ? 1000 : 30, key: (req) => req.user!.id });

  r.patch("/profile", (req, res) => {
    const body = parse(ProfileBody, req.body);
    res.json({ user: toAuthUser(updateProfile(ctx, req.user!.id, body)) });
  });

  r.post("/password", sensitive, async (req, res) => {
    const body = parse(PasswordBody, req.body);
    await changePassword(ctx, req.user!.id, body.currentPassword, body.newPassword, req.sessionId!);
    audit(ctx, req.user!.id, "security.password_changed", {}, req.ip);
    res.json({ ok: true });
  });

  r.post("/2fa/setup", sensitive, (req, res) => {
    res.json(beginTotpSetup(ctx, req.user!.id));
  });

  r.post("/2fa/confirm", sensitive, (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    confirmTotpSetup(ctx, req.user!.id, code);
    audit(ctx, req.user!.id, "security.2fa_enabled", {}, req.ip);
    res.json({ ok: true });
  });

  r.post("/2fa/disable", sensitive, async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1), code: z.string().min(6).max(10) }), req.body);
    await disableTotp(ctx, req.user!.id, body.password, body.code);
    audit(ctx, req.user!.id, "security.2fa_disabled", {}, req.ip);
    res.json({ ok: true });
  });

  r.get("/api-keys", (req, res) => {
    res.json({ keys: listUserKeys(ctx, req.user!.id).filter((k) => BYOK_PROVIDERS.includes(k.provider)) });
  });

  r.put("/api-keys/:provider", sensitive, async (req, res) => {
    const provider = String(req.params.provider);
    if (!BYOK_PROVIDERS.includes(provider)) throw badRequest("Unknown AI provider");
    const body = parse(KeyBody, req.body);
    if (body.verify) {
      try {
        await testCredentials(ctx, provider, body.apiKey);
      } catch (err) {
        throw unprocessable("key_rejected", (err as Error).message);
      }
    }
    saveUserKey(ctx, req.user!.id, provider, body.apiKey);
    audit(ctx, req.user!.id, "settings.api_key_saved", { provider }, req.ip);
    res.json({ keys: listUserKeys(ctx, req.user!.id).filter((k) => BYOK_PROVIDERS.includes(k.provider)) });
  });

  r.delete("/api-keys/:provider", (req, res) => {
    deleteUserKey(ctx, req.user!.id, String(req.params.provider));
    audit(ctx, req.user!.id, "settings.api_key_deleted", { provider: String(req.params.provider) }, req.ip);
    res.json({ ok: true });
  });

  r.get("/security-log", (req, res) => {
    const events = all<{ id: number; action: string; ip: string | null; created_at: string }>(
      ctx.db,
      "SELECT id, action, ip, created_at FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 30",
      req.user!.id,
    );
    res.json({ events: events.map((e) => ({ id: e.id, action: e.action, ip: e.ip, createdAt: e.created_at })) });
  });

  return r;
}
