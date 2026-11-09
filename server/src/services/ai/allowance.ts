import type { Ctx } from "../../context.js";
import { one, run, tx } from "../../db/index.js";
import { HttpError, unprocessable } from "../../lib/errors.js";

/**
 * Free AI allowance: requests that run on the server's own provider keys are counted per user per
 * UTC day and capped at AI_FREE_DAILY_REQUESTS. Users' own keys (BYOK) and the offline demo are never
 * counted. AI_FREE_MODELS can restrict which models the server's keys may be used with.
 */
const today = () => new Date().toISOString().slice(0, 10);

export function freeUsage(ctx: Ctx, userId: string) {
  const limit = ctx.config.AI_FREE_DAILY_REQUESTS;
  const used = one<{ requests: number }>(ctx.db, "SELECT requests FROM ai_usage WHERE user_id = ? AND day = ?", userId, today())?.requests ?? 0;
  const resetsAt = new Date(`${today()}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return {
    limit: limit || null,
    used,
    remaining: limit ? Math.max(0, limit - used) : null,
    resetsAt: resetsAt.toISOString(),
    models: [...ctx.config.freeModels],
  };
}

export function assertFreeModel(ctx: Ctx, provider: string, model: string) {
  if (ctx.config.freeModels.size === 0 || ctx.config.freeModels.has(`${provider}:${model}`)) return;
  const allowed = [...ctx.config.freeModels].filter((m) => m.startsWith(`${provider}:`)).map((m) => m.split(":").slice(1).join(":"));
  throw unprocessable(
    "model_not_free",
    allowed.length
      ? `On the free allowance this provider offers: ${allowed.join(", ")}. Add your own API key in Settings to use other models.`
      : "This model isn't included in the free allowance. Add your own API key in Settings to use it.",
  );
}

/** Counts one request against today's allowance, or throws 429 when it's used up. */
export function chargeFreeRequest(ctx: Ctx, userId: string) {
  const limit = ctx.config.AI_FREE_DAILY_REQUESTS;
  if (!limit) return;
  tx(ctx.db, () => {
    const used = one<{ requests: number }>(ctx.db, "SELECT requests FROM ai_usage WHERE user_id = ? AND day = ?", userId, today())?.requests ?? 0;
    if (used >= limit) {
      throw new HttpError(
        429,
        "ai_quota_exceeded",
        `You've used today's ${limit} free AI requests. They reset at midnight UTC, or add your own API key in Settings for unlimited use.`,
      );
    }
    run(
      ctx.db,
      `INSERT INTO ai_usage (user_id, day, requests) VALUES (?, ?, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1`,
      userId,
      today(),
    );
  });
}
