import { Router } from "express";
import type { Ctx } from "../context.js";
import { CURRENCIES } from "../lib/money.js";
import { getRates } from "../services/fx.js";
import { describeRails } from "../services/rails/index.js";
import { captchaEnabled } from "../services/captcha.js";

export function metaRoutes(ctx: Ctx) {
  const r = Router();
  r.get("/meta", async (_req, res) => {
    const rates = await getRates(ctx);
    res.json({
      appName: "Aurex",
      currencies: Object.values(CURRENCIES),
      rails: describeRails(ctx),
      fees: {
        p2pBps: ctx.config.P2P_FEE_BPS,
        fxSpreadBps: ctx.config.FX_SPREAD_BPS,
        withdrawalBps: ctx.config.WITHDRAWAL_FEE_BPS,
        merchantBps: ctx.config.MERCHANT_FEE_BPS,
      },
      limits: {
        maxTxUsd: ctx.config.MAX_TX_USD,
        dailyUsd: ctx.config.DAILY_LIMIT_USD,
        byLevel: ctx.config.KYC_LIMITS
          ? [
              { level: 0, txUsd: ctx.config.TIER0_TX_USD, dailyUsd: ctx.config.TIER0_DAILY_USD },
              { level: 1, txUsd: ctx.config.TIER1_TX_USD, dailyUsd: ctx.config.TIER1_DAILY_USD },
              { level: 2, txUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD },
            ]
          : null,
        payoutReviewUsd: ctx.config.PAYOUT_REVIEW ? ctx.config.PAYOUT_REVIEW_USD : null,
      },
      fx: { source: rates.source, asOf: rates.asOf },
      captcha: captchaEnabled(ctx) ? { provider: "turnstile", siteKey: ctx.config.TURNSTILE_SITE_KEY } : null,
      ai: { freeDailyRequests: ctx.config.AI_FREE_DAILY_REQUESTS, freeModels: [...ctx.config.freeModels] },
      pro: ctx.config.PRO_ENABLED
        ? { price: ctx.config.PRO_PRICE, currency: ctx.config.PRO_CURRENCY, aiDailyRequests: ctx.config.PRO_AI_DAILY_REQUESTS, freeWeb3Wallets: ctx.config.FREE_WEB3_WALLETS }
        : null,
      autopilot: { enabled: ctx.config.AUTOPILOT_ENABLED, liveAllowed: ctx.config.ALLOW_LIVE_AUTOPILOT },
      trading: {
        liveTradingAllowed: ctx.config.ALLOW_LIVE_TRADING,
        paperStartingCash: ctx.config.PAPER_STARTING_CASH,
        aiMaxPositionPct: ctx.config.AI_MAX_POSITION_PCT,
      },
    });
  });
  return r;
}
