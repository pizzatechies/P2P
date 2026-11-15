import { Router } from "express";
import { z } from "zod";
import type { Ctx } from "../context.js";
import { all } from "../db/index.js";
import { badRequest, unprocessable } from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { requireAuth, requireRecentAuth } from "../middleware/auth.js";
import { testCredentials } from "../services/ai/gateway.js";
import { BYOK_PROVIDERS } from "../services/ai/providers.js";
import { deleteUserKey, listUserKeys, saveUserKey } from "../services/keys.js";
import {
  addAlert,
  issueRecoveryCodes,
  listAlerts,
  listSessions,
  markAlertsRead,
  reauthValidUntil,
  recoveryCodesLeft,
  revokeSession,
  securityHoldUntil,
} from "../services/security.js";
import {
  audit,
  beginTotpSetup,
  changePassword,
  claimAdmin,
  confirmTotpSetup,
  destroyOtherSessions,
  disableTotp,
  getUserRow,
  toAuthUser,
  updateProfile,
} from "../services/users.js";

const ProfileBody = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  defaultCurrency: z.string().length(3).optional(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200), // strength rules are enforced by the service
  code: z.string().max(20).optional(),
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
    await changePassword(ctx, req.user!.id, { current: body.currentPassword, next: body.newPassword, code: body.code }, req.sessionId!, req.ip);
    audit(ctx, req.user!.id, "security.password_changed", {}, req.ip);
    res.json({ ok: true });
  });

  /** Everything the Security center shows: alerts, devices, 2FA backup codes and any active hold. */
  r.get("/security", (req, res) => {
    const user = getUserRow(ctx, req.user!.id);
    res.json({
      totpEnabled: user.totp_enabled === 1,
      recoveryCodesLeft: user.totp_enabled ? recoveryCodesLeft(ctx, user.id) : 0,
      securityHoldUntil: securityHoldUntil(user),
      reauthUntil: reauthValidUntil(ctx, req.reauthAt),
      reauthWindowMinutes: ctx.config.REAUTH_WINDOW_MINUTES,
      stepUpSendUsd: ctx.config.STEP_UP_SEND_USD,
      sessions: listSessions(ctx, user.id, req.sessionId),
      alerts: listAlerts(ctx, user.id),
      passwordChangedAt: user.password_changed_at,
      admin: {
        canClaim: Boolean(ctx.config.ADMIN_SETUP_CODE && ctx.config.adminEmails.has(user.email.toLowerCase()) && user.role !== "admin"),
        requires2fa: ctx.config.REQUIRE_ADMIN_2FA,
      },
    });
  });

  r.post("/security/alerts/read", (req, res) => {
    markAlertsRead(ctx, req.user!.id);
    res.json({ ok: true });
  });

  r.delete("/sessions/:id", (req, res) => {
    const ok = revokeSession(ctx, req.user!.id, String(req.params.id));
    if (ok) audit(ctx, req.user!.id, "security.session_revoked", {}, req.ip);
    res.json({ ok, sessions: listSessions(ctx, req.user!.id, req.sessionId) });
  });

  r.post("/sessions/revoke-others", (req, res) => {
    destroyOtherSessions(ctx, req.user!.id, req.sessionId!);
    audit(ctx, req.user!.id, "security.sessions_revoked", {}, req.ip);
    res.json({ ok: true, sessions: listSessions(ctx, req.user!.id, req.sessionId) });
  });

  /** New one-time recovery codes; the old ones stop working. */
  r.post("/2fa/recovery-codes", sensitive, requireRecentAuth(ctx), (req, res) => {
    const user = getUserRow(ctx, req.user!.id);
    if (!user.totp_enabled) throw badRequest("Turn on two-factor authentication first");
    const codes = issueRecoveryCodes(ctx, user.id);
    audit(ctx, user.id, "security.recovery_codes_regenerated", {}, req.ip);
    addAlert(ctx, user.id, "recovery_codes", "New recovery codes were created; the old ones no longer work.", req.ip);
    res.json({ recoveryCodes: codes });
  });

  /** Production admin access for ADMIN_EMAILS accounts, proven with ADMIN_SETUP_CODE. */
  r.post("/admin/claim", sensitive, requireRecentAuth(ctx), (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(1).max(200) }), req.body);
    const user = claimAdmin(ctx, req.user!.id, code);
    audit(ctx, user.id, "admin.claimed", {}, req.ip);
    addAlert(ctx, user.id, "admin", "This account now has admin access.", req.ip);
    res.json({ user: toAuthUser(user) });
  });

  r.post("/2fa/setup", sensitive, (req, res) => {
    res.json(beginTotpSetup(ctx, req.user!.id));
  });

  r.post("/2fa/confirm", sensitive, (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    const recoveryCodes = confirmTotpSetup(ctx, req.user!.id, code);
    audit(ctx, req.user!.id, "security.2fa_enabled", {}, req.ip);
    res.json({ ok: true, recoveryCodes });
  });

  r.post("/2fa/disable", sensitive, async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(20) }), req.body);
    await disableTotp(ctx, req.user!.id, body.password, body.code, req.ip);
    audit(ctx, req.user!.id, "security.2fa_disabled", {}, req.ip);
    res.json({ ok: true });
  });

  r.get("/api-keys", (req, res) => {
    res.json({ keys: listUserKeys(ctx, req.user!.id).filter((k) => BYOK_PROVIDERS.includes(k.provider)) });
  });

  r.put("/api-keys/:provider", sensitive, requireRecentAuth(ctx), async (req, res) => {
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
      "SELECT id, action, ip, created_at FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 50",
      req.user!.id,
    );
    res.json({ events: events.map((e) => ({ id: e.id, action: e.action, ip: e.ip, createdAt: e.created_at })) });
  });

  return r;
}
