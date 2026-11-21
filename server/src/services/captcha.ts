import type { Ctx } from "../context.js";
import { HttpError } from "../lib/errors.js";

/**
 * Bot protection with Cloudflare Turnstile (optional): sign-up, sign-in, password reset and the
 * waitlist need a fresh token from the widget, which the server checks with Cloudflare. Off until
 * TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set.
 */
export function captchaEnabled(ctx: Ctx) {
  return Boolean(ctx.config.TURNSTILE_SITE_KEY && ctx.config.TURNSTILE_SECRET_KEY);
}

export async function verifyCaptcha(ctx: Ctx, token: unknown, ip?: string) {
  if (!captchaEnabled(ctx)) return;
  if (typeof token !== "string" || !token || token.length > 2048) {
    throw new HttpError(400, "captcha_required", "Please complete the check that you're a person");
  }
  let result: { success?: boolean; hostname?: string; "error-codes"?: string[] };
  try {
    const res = await fetch(ctx.config.TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: ctx.config.TURNSTILE_SECRET_KEY!, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    result = (await res.json()) as typeof result;
  } catch {
    // Fail closed: without the check, bots could get through while Cloudflare is unreachable.
    throw new HttpError(503, "captcha_unavailable", "We couldn't run the check that you're a person. Try again in a minute.");
  }
  if (!result.success) throw new HttpError(400, "captcha_failed", "The check that you're a person didn't pass. Please try it again.");
  // In production the token must have been issued for this site.
  if (ctx.config.isProd && result.hostname && result.hostname !== new URL(ctx.config.APP_URL).hostname) {
    throw new HttpError(400, "captcha_failed", "The check that you're a person didn't pass. Please try it again.");
  }
}
