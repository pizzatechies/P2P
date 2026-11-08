import { Router } from "express";
import type { Ctx } from "../context.js";
import { CURRENCIES } from "../lib/money.js";
import { getRates } from "../services/fx.js";
import { describeRails } from "../services/rails/index.js";

export function metaRoutes(ctx: Ctx) {
  const r = Router();
  r.get("/meta", async (_req, res) => {
    const rates = await getRates(ctx);
    res.json({
      appName: "P2P Hub",
      currencies: Object.values(CURRENCIES),
      rails: describeRails(ctx),
      fees: {
        p2pBps: ctx.config.P2P_FEE_BPS,
        fxSpreadBps: ctx.config.FX_SPREAD_BPS,
        withdrawalBps: ctx.config.WITHDRAWAL_FEE_BPS,
      },
      limits: { maxTxUsd: ctx.config.MAX_TX_USD, dailyUsd: ctx.config.DAILY_LIMIT_USD },
      fx: { source: rates.source, asOf: rates.asOf },
      trading: { liveTradingAllowed: ctx.config.ALLOW_LIVE_TRADING, paperStartingCash: ctx.config.PAPER_STARTING_CASH },
    });
  });
  return r;
}
