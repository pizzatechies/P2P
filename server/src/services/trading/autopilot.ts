import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { badRequest, forbidden, HttpError, unprocessable } from "../../lib/errors.js";
import { getProvider } from "../ai/providers.js";
import { audit } from "../users.js";
import { analyze } from "./analyst.js";
import { ALPACA_LIVE, ALPACA_PAPER, alpacaRequest } from "./brokers/alpaca.js";
import type { AccountView } from "./brokers/types.js";
import { brokerFor, placeOrder } from "./index.js";
import { alpacaCredentials, normalizeSymbol } from "./market.js";

/**
 * AI Autopilot: on a schedule, the AI analyst reviews the user's chosen symbols and trades for
 * them, strictly inside limits the user sets. Guardrails, all enforced here on the server:
 *  - off until the user switches it on and acknowledges the risks
 *  - per-position and total-exposure caps (never above the server's AI_MAX_POSITION_PCT)
 *  - a maximum number of trades per day, and a minimum confidence to act
 *  - a daily loss limit that pauses the autopilot until the user resumes it
 *  - stop-loss / take-profit exits for positions it opened
 *  - "approve" mode that only proposes trades, never places them
 *  - live (real-money) accounts need ALLOW_LIVE_AUTOPILOT on the server AND the user's opt-in
 *  - pauses itself after repeated errors
 */

interface SettingsRow {
  user_id: string;
  enabled: number;
  mode: "auto" | "approve";
  provider: string;
  model: string | null;
  symbols: string;
  interval_min: number;
  max_position_pct: number;
  max_exposure_pct: number;
  max_trades_per_day: number;
  max_daily_loss_pct: number;
  min_confidence: number;
  use_exits: number;
  allow_live: number;
  acknowledged_at: string | null;
  paused_reason: string | null;
  consecutive_errors: number;
  day_date: string | null;
  day_start_equity: number | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface AutopilotSettings {
  enabled: boolean;
  mode: "auto" | "approve";
  provider: string;
  model: string | null;
  symbols: string[];
  intervalMin: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  minConfidence: number;
  useExits: boolean;
  allowLive: boolean;
  acknowledged: boolean;
  pausedReason: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

const view = (r: SettingsRow): AutopilotSettings => ({
  enabled: r.enabled === 1,
  mode: r.mode,
  provider: r.provider,
  model: r.model,
  symbols: JSON.parse(r.symbols) as string[],
  intervalMin: r.interval_min,
  maxPositionPct: r.max_position_pct,
  maxExposurePct: r.max_exposure_pct,
  maxTradesPerDay: r.max_trades_per_day,
  maxDailyLossPct: r.max_daily_loss_pct,
  minConfidence: r.min_confidence,
  useExits: r.use_exits === 1,
  allowLive: r.allow_live === 1,
  acknowledged: !!r.acknowledged_at,
  pausedReason: r.paused_reason,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
});

const PAUSE_TEXT: Record<string, string> = {
  daily_loss_limit: "Paused: today's loss reached your daily limit",
  errors: "Paused after repeated errors",
  live_not_allowed: "Paused: this is a live account and live autopilot isn't allowed",
  user: "Paused by you",
};

function row(ctx: Ctx, userId: string): SettingsRow {
  let r = one<SettingsRow>(ctx.db, "SELECT * FROM autopilot_settings WHERE user_id = ?", userId);
  if (!r) {
    // Default position size starts at half the server cap, so a new user is conservative by default.
    const defaultPosition = Math.min(5, Math.round(ctx.config.AI_MAX_POSITION_PCT * 100));
    run(
      ctx.db,
      "INSERT INTO autopilot_settings (user_id, max_position_pct, interval_min, updated_at) VALUES (?, ?, ?, ?)",
      userId,
      defaultPosition,
      Math.max(30, ctx.config.AUTOPILOT_MIN_INTERVAL_MIN),
      nowIso(),
    );
    r = one<SettingsRow>(ctx.db, "SELECT * FROM autopilot_settings WHERE user_id = ?", userId)!;
  }
  return r;
}

export function getAutopilotSettings(ctx: Ctx, userId: string) {
  return view(row(ctx, userId));
}

function logEvent(
  ctx: Ctx,
  userId: string,
  e: { kind: string; message: string; symbol?: string; detail?: Record<string, unknown>; orderId?: string; signalId?: string },
) {
  run(
    ctx.db,
    "INSERT INTO autopilot_events (user_id, kind, symbol, message, detail, order_id, signal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    userId,
    e.kind,
    e.symbol ?? null,
    e.message,
    JSON.stringify(e.detail ?? {}),
    e.orderId ?? null,
    e.signalId ?? null,
    nowIso(),
  );
}

function pause(ctx: Ctx, userId: string, reason: keyof typeof PAUSE_TEXT) {
  run(ctx.db, "UPDATE autopilot_settings SET paused_reason = ?, updated_at = ? WHERE user_id = ?", reason, nowIso(), userId);
  logEvent(ctx, userId, { kind: "pause", message: PAUSE_TEXT[reason] });
}

export interface AutopilotPatch {
  enabled?: boolean;
  acknowledge?: boolean;
  mode?: "auto" | "approve";
  provider?: string;
  model?: string | null;
  symbols?: string[];
  intervalMin?: number;
  maxPositionPct?: number;
  maxExposurePct?: number;
  maxTradesPerDay?: number;
  maxDailyLossPct?: number;
  minConfidence?: number;
  useExits?: boolean;
  allowLive?: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function updateAutopilotSettings(ctx: Ctx, userId: string, patch: AutopilotPatch, ip?: string) {
  const current = row(ctx, userId);
  const next = { ...current };
  const cap = Math.round(ctx.config.AI_MAX_POSITION_PCT * 1000) / 10;

  if (patch.mode) next.mode = patch.mode;
  if (patch.provider !== undefined) {
    if (patch.provider !== "rules" && (!getProvider(patch.provider) || patch.provider === "demo")) {
      throw badRequest("Pick the rule-based model or a connected AI provider");
    }
    next.provider = patch.provider;
    next.model = patch.provider === "rules" ? null : (patch.model ?? getProvider(patch.provider)?.models[0]?.id ?? null);
  } else if (patch.model !== undefined) next.model = patch.model;
  if (patch.symbols) {
    const symbols = [...new Set(patch.symbols.map(normalizeSymbol))];
    if (symbols.length > 20) throw badRequest("The autopilot can watch up to 20 symbols");
    next.symbols = JSON.stringify(symbols);
  }
  if (patch.intervalMin !== undefined) next.interval_min = Math.round(clamp(patch.intervalMin, ctx.config.AUTOPILOT_MIN_INTERVAL_MIN, 1440));
  if (patch.maxPositionPct !== undefined) next.max_position_pct = clamp(patch.maxPositionPct, 0.5, cap);
  if (patch.maxExposurePct !== undefined) next.max_exposure_pct = clamp(patch.maxExposurePct, 5, 100);
  if (patch.maxTradesPerDay !== undefined) next.max_trades_per_day = Math.round(clamp(patch.maxTradesPerDay, 1, 50));
  if (patch.maxDailyLossPct !== undefined) next.max_daily_loss_pct = clamp(patch.maxDailyLossPct, 0.5, 50);
  if (patch.minConfidence !== undefined) next.min_confidence = clamp(patch.minConfidence, 0.5, 0.95);
  if (patch.useExits !== undefined) next.use_exits = patch.useExits ? 1 : 0;
  if (patch.allowLive !== undefined) {
    if (patch.allowLive && !ctx.config.ALLOW_LIVE_AUTOPILOT) {
      throw forbidden("Live (real-money) autopilot is disabled on this server");
    }
    next.allow_live = patch.allowLive ? 1 : 0;
  }
  next.max_position_pct = Math.min(next.max_position_pct, cap);

  if (patch.enabled === true) {
    if (!ctx.config.AUTOPILOT_ENABLED) throw forbidden("The AI autopilot is turned off on this server");
    if (!current.acknowledged_at && !patch.acknowledge) {
      throw unprocessable("acknowledgement_required", "Review and accept how the autopilot works before turning it on");
    }
    if (!current.acknowledged_at) next.acknowledged_at = nowIso();
    next.enabled = 1;
    next.paused_reason = null;
    next.consecutive_errors = 0;
    next.next_run_at = nowIso();
  } else if (patch.enabled === false) {
    next.enabled = 0;
  }

  run(
    ctx.db,
    `UPDATE autopilot_settings SET enabled = ?, mode = ?, provider = ?, model = ?, symbols = ?, interval_min = ?,
       max_position_pct = ?, max_exposure_pct = ?, max_trades_per_day = ?, max_daily_loss_pct = ?, min_confidence = ?,
       use_exits = ?, allow_live = ?, acknowledged_at = ?, paused_reason = ?, consecutive_errors = ?, next_run_at = ?, updated_at = ?
     WHERE user_id = ?`,
    next.enabled,
    next.mode,
    next.provider,
    next.model,
    next.symbols,
    next.interval_min,
    next.max_position_pct,
    next.max_exposure_pct,
    next.max_trades_per_day,
    next.max_daily_loss_pct,
    next.min_confidence,
    next.use_exits,
    next.allow_live,
    next.acknowledged_at,
    next.paused_reason,
    next.consecutive_errors,
    next.next_run_at,
    nowIso(),
    userId,
  );
  if (patch.enabled !== undefined && (patch.enabled ? 1 : 0) !== current.enabled) {
    audit(ctx, userId, patch.enabled ? "autopilot.enabled" : "autopilot.disabled", { mode: next.mode }, ip);
    logEvent(ctx, userId, { kind: patch.enabled ? "run" : "pause", message: patch.enabled ? "Autopilot switched on" : "Autopilot switched off" });
  }
  return getAutopilotSettings(ctx, userId);
}

export function resumeAutopilot(ctx: Ctx, userId: string) {
  const r = row(ctx, userId);
  if (!r.enabled) throw unprocessable("autopilot_off", "Turn the autopilot on first");
  run(
    ctx.db,
    "UPDATE autopilot_settings SET paused_reason = NULL, consecutive_errors = 0, next_run_at = ?, updated_at = ? WHERE user_id = ?",
    nowIso(),
    nowIso(),
    userId,
  );
  logEvent(ctx, userId, { kind: "run", message: "Autopilot resumed" });
  return getAutopilotSettings(ctx, userId);
}

export function pauseAutopilot(ctx: Ctx, userId: string) {
  row(ctx, userId);
  pause(ctx, userId, "user");
  return getAutopilotSettings(ctx, userId);
}

const startOfUtcDay = () => new Date().toISOString().slice(0, 10);

function tradesToday(ctx: Ctx, userId: string) {
  return one<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND placed_by = 'autopilot' AND created_at >= ? AND status <> 'rejected'",
    userId,
    `${startOfUtcDay()}T00:00:00.000Z`,
  )!.n;
}

export function autopilotStatus(ctx: Ctx, userId: string) {
  const r = row(ctx, userId);
  const events = all<{
    id: number;
    kind: string;
    symbol: string | null;
    message: string;
    detail: string;
    order_id: string | null;
    signal_id: string | null;
    created_at: string;
    executed: string | null;
  }>(
    ctx.db,
    `SELECT e.*, s.executed_order_id AS executed FROM autopilot_events e
     LEFT JOIN ai_signals s ON s.id = e.signal_id
     WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 60`,
    userId,
  ).map((e) => ({
    id: e.id,
    kind: e.kind,
    symbol: e.symbol,
    message: e.message,
    detail: JSON.parse(e.detail) as Record<string, unknown>,
    orderId: e.order_id,
    signalId: e.signal_id,
    executed: !!e.executed,
    createdAt: e.created_at,
  }));
  return {
    settings: view(r),
    stats: { tradesToday: tradesToday(ctx, userId), dayStartEquity: r.day_date === startOfUtcDay() ? r.day_start_equity : null },
    limits: {
      maxPositionPctCap: Math.round(ctx.config.AI_MAX_POSITION_PCT * 1000) / 10,
      minIntervalMin: ctx.config.AUTOPILOT_MIN_INTERVAL_MIN,
      liveAutopilotAllowed: ctx.config.ALLOW_LIVE_AUTOPILOT,
      serverEnabled: ctx.config.AUTOPILOT_ENABLED,
    },
    events,
  };
}

const running = new Set<string>();

/**
 * One autopilot pass for one user. Returns a short summary. Safe to call concurrently: a user's
 * second call while one is in flight is ignored.
 */
export async function runAutopilot(ctx: Ctx, userId: string, opts: { manual?: boolean } = {}) {
  const s = row(ctx, userId);
  if (!s.enabled) {
    if (opts.manual) throw unprocessable("autopilot_off", "Turn the autopilot on first");
    return { skipped: "off" as const };
  }
  if (s.paused_reason) {
    if (opts.manual) throw unprocessable("autopilot_paused", `${PAUSE_TEXT[s.paused_reason] ?? "Paused"}. Resume it to run again.`);
    return { skipped: "paused" as const };
  }
  if (running.has(userId)) return { skipped: "busy" as const };
  running.add(userId);

  const finish = (errored: boolean) => {
    const errors = errored ? s.consecutive_errors + 1 : 0;
    run(
      ctx.db,
      "UPDATE autopilot_settings SET last_run_at = ?, next_run_at = ?, consecutive_errors = ?, updated_at = ? WHERE user_id = ?",
      nowIso(),
      new Date(Date.now() + s.interval_min * 60_000).toISOString(),
      errors,
      nowIso(),
      userId,
    );
    if (errors >= 3) pause(ctx, userId, "errors");
    // Keep the activity log bounded.
    run(
      ctx.db,
      "DELETE FROM autopilot_events WHERE user_id = ? AND id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM autopilot_events WHERE user_id = ? ORDER BY id DESC LIMIT 500))",
      userId,
      userId,
    );
  };

  const summary = { buys: 0, sells: 0, exits: 0, holds: 0, approvals: 0, errors: 0 };
  try {
    const { broker, market } = brokerFor(ctx, userId);
    let account: AccountView = await broker.account();

    if (account.live && !(ctx.config.ALLOW_LIVE_AUTOPILOT && s.allow_live)) {
      pause(ctx, userId, "live_not_allowed");
      return { skipped: "live_not_allowed" as const };
    }

    // Real brokerage: only trade while the market is open.
    if (broker.id === "alpaca") {
      const creds = alpacaCredentials(ctx, userId)!;
      const clock = await alpacaRequest<{ is_open: boolean; next_open: string }>(
        creds.env === "live" ? ALPACA_LIVE : ALPACA_PAPER,
        creds,
        "/v2/clock",
      );
      if (!clock.is_open) {
        logEvent(ctx, userId, { kind: "skip", message: `Market closed. Next open ${new Date(clock.next_open).toUTCString()}` });
        finish(false);
        return { skipped: "market_closed" as const };
      }
    }

    // Daily loss limit, measured from the first run of the UTC day.
    const today = startOfUtcDay();
    let dayStart = s.day_start_equity;
    if (s.day_date !== today || !dayStart) {
      dayStart = account.equity;
      run(ctx.db, "UPDATE autopilot_settings SET day_date = ?, day_start_equity = ? WHERE user_id = ?", today, dayStart, userId);
    }
    const lossPct = ((dayStart - account.equity) / dayStart) * 100;
    if (lossPct >= s.max_daily_loss_pct) {
      pause(ctx, userId, "daily_loss_limit");
      finish(false);
      return { skipped: "daily_loss_limit" as const };
    }

    // 1) Exits: stop-loss and take-profit on positions the autopilot opened. Always allowed.
    if (s.use_exits) {
      const guards = all<{ symbol: string; stop_loss: number | null; take_profit: number | null }>(
        ctx.db,
        "SELECT symbol, stop_loss, take_profit FROM autopilot_guards WHERE user_id = ?",
        userId,
      );
      for (const g of guards) {
        const pos = account.positions.find((p) => p.symbol === g.symbol);
        if (!pos) {
          run(ctx.db, "DELETE FROM autopilot_guards WHERE user_id = ? AND symbol = ?", userId, g.symbol);
          continue;
        }
        const hitStop = g.stop_loss !== null && pos.price <= g.stop_loss;
        const hitTarget = g.take_profit !== null && pos.price >= g.take_profit;
        if (!hitStop && !hitTarget) continue;
        try {
          const { order } = await placeOrder(ctx, userId, { symbol: g.symbol, side: "sell", type: "market", qty: pos.qty, placedBy: "autopilot" });
          run(ctx.db, "DELETE FROM autopilot_guards WHERE user_id = ? AND symbol = ?", userId, g.symbol);
          logEvent(ctx, userId, {
            kind: "exit",
            symbol: g.symbol,
            message: `${hitStop ? "Stop-loss" : "Take-profit"} hit at ${pos.price.toFixed(2)}: sold ${pos.qty} ${g.symbol}`,
            detail: { price: pos.price, qty: pos.qty, stopLoss: g.stop_loss, takeProfit: g.take_profit },
            orderId: order.id,
          });
          summary.exits++;
        } catch (err) {
          summary.errors++;
          logEvent(ctx, userId, { kind: "error", symbol: g.symbol, message: `Couldn't exit ${g.symbol}: ${(err as Error).message}` });
        }
      }
      if (summary.exits) account = await broker.account();
    }

    // 2) Entries and AI sells across the universe.
    let universe = JSON.parse(s.symbols) as string[];
    if (universe.length === 0) {
      universe = all<{ symbol: string }>(ctx.db, "SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY created_at", userId).map((w) => w.symbol);
    }
    universe = universe.slice(0, 10);
    if (universe.length === 0) {
      logEvent(ctx, userId, { kind: "skip", message: "Nothing to watch. Add symbols to your watchlist or autopilot list." });
    }

    let trades = tradesToday(ctx, userId);
    for (const symbol of universe) {
      if (trades >= s.max_trades_per_day) {
        logEvent(ctx, userId, { kind: "skip", message: `Daily trade limit reached (${s.max_trades_per_day}). Watching only.` });
        break;
      }
      let signal;
      try {
        ({ signal } = await analyze(ctx, userId, { symbol, provider: s.provider, model: s.model ?? undefined }));
      } catch (err) {
        summary.errors++;
        logEvent(ctx, userId, { kind: "error", symbol, message: `Analysis failed: ${(err as Error).message}` });
        if (err instanceof HttpError && (err.code === "provider_not_configured" || err.code === "ai_quota_exceeded")) break;
        continue;
      }
      const pct = Math.round(signal.confidence * 100);
      const held = account.positions.find((p) => p.symbol === symbol);

      if (signal.action === "buy" && signal.confidence >= s.min_confidence) {
        const exposure = account.positions.reduce((sum, p) => sum + p.marketValue, 0);
        const roomPosition = (account.equity * s.max_position_pct) / 100 - (held?.marketValue ?? 0);
        const roomExposure = (account.equity * s.max_exposure_pct) / 100 - exposure;
        const budget = Math.min(roomPosition, roomExposure, account.buyingPower);
        let qty = budget >= signal.price ? Math.floor(budget / signal.price) : 0;
        if (signal.suggestedQty > 0) qty = Math.min(qty, Math.floor(signal.suggestedQty) || qty);
        if (qty < 1) {
          summary.holds++;
          logEvent(ctx, userId, {
            kind: "hold",
            symbol,
            message: `BUY signal (${pct}%) but no room within your limits`,
            signalId: signal.id,
            detail: { confidence: signal.confidence },
          });
          continue;
        }
        if (s.mode === "approve") {
          summary.approvals++;
          logEvent(ctx, userId, {
            kind: "approval",
            symbol,
            message: `Suggests buying ${qty} ${symbol} at ~${signal.price.toFixed(2)} (${pct}% confidence)`,
            signalId: signal.id,
            detail: { side: "buy", qty, price: signal.price, confidence: signal.confidence, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit },
          });
          continue;
        }
        try {
          const { order } = await placeOrder(ctx, userId, {
            symbol,
            side: "buy",
            type: "market",
            qty,
            signalId: signal.id,
            placedBy: "autopilot",
          });
          if (signal.stopLoss !== null || signal.takeProfit !== null) {
            run(
              ctx.db,
              `INSERT INTO autopilot_guards (user_id, symbol, stop_loss, take_profit, signal_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id, symbol) DO UPDATE SET stop_loss = excluded.stop_loss, take_profit = excluded.take_profit,
                 signal_id = excluded.signal_id, updated_at = excluded.updated_at`,
              userId,
              symbol,
              signal.stopLoss,
              signal.takeProfit,
              signal.id,
              nowIso(),
            );
          }
          trades++;
          summary.buys++;
          logEvent(ctx, userId, {
            kind: "buy",
            symbol,
            message: `Bought ${qty} ${symbol} at ${order.filledAvgPrice?.toFixed(2) ?? "market"} (${pct}% confidence)`,
            orderId: order.id,
            signalId: signal.id,
            detail: { qty, price: order.filledAvgPrice ?? signal.price, confidence: signal.confidence, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, rationale: signal.rationale },
          });
          account = await broker.account();
        } catch (err) {
          summary.errors++;
          logEvent(ctx, userId, { kind: "error", symbol, message: `Buy ${symbol} failed: ${(err as Error).message}`, signalId: signal.id });
        }
      } else if (signal.action === "sell" && held && signal.confidence >= s.min_confidence) {
        if (s.mode === "approve") {
          summary.approvals++;
          logEvent(ctx, userId, {
            kind: "approval",
            symbol,
            message: `Suggests selling ${held.qty} ${symbol} at ~${signal.price.toFixed(2)} (${pct}% confidence)`,
            signalId: signal.id,
            detail: { side: "sell", qty: held.qty, price: signal.price, confidence: signal.confidence },
          });
          continue;
        }
        try {
          const { order } = await placeOrder(ctx, userId, {
            symbol,
            side: "sell",
            type: "market",
            qty: held.qty,
            signalId: signal.id,
            placedBy: "autopilot",
          });
          run(ctx.db, "DELETE FROM autopilot_guards WHERE user_id = ? AND symbol = ?", userId, symbol);
          trades++;
          summary.sells++;
          logEvent(ctx, userId, {
            kind: "sell",
            symbol,
            message: `Sold ${held.qty} ${symbol} at ${order.filledAvgPrice?.toFixed(2) ?? "market"} (${pct}% confidence)`,
            orderId: order.id,
            signalId: signal.id,
            detail: { qty: held.qty, price: order.filledAvgPrice ?? signal.price, confidence: signal.confidence, rationale: signal.rationale },
          });
          account = await broker.account();
        } catch (err) {
          summary.errors++;
          logEvent(ctx, userId, { kind: "error", symbol, message: `Sell ${symbol} failed: ${(err as Error).message}`, signalId: signal.id });
        }
      } else {
        summary.holds++;
        const why =
          signal.action === "hold"
            ? `HOLD (${pct}% confidence)`
            : `${signal.action.toUpperCase()} at ${pct}% is below your ${Math.round(s.min_confidence * 100)}% threshold`;
        logEvent(ctx, userId, { kind: "hold", symbol, message: why, signalId: signal.id, detail: { confidence: signal.confidence } });
      }
    }

    logEvent(ctx, userId, {
      kind: "run",
      message: `Checked ${universe.length} symbol${universe.length === 1 ? "" : "s"}: ${summary.buys} bought, ${summary.sells + summary.exits} sold, ${summary.approvals} to approve, ${summary.holds} held${summary.errors ? `, ${summary.errors} errors` : ""}`,
      detail: { ...summary, equity: account.equity },
    });
    finish(summary.errors > 0 && summary.buys + summary.sells + summary.exits + summary.holds + summary.approvals === 0);
    return { skipped: null, ...summary };
  } catch (err) {
    logEvent(ctx, userId, { kind: "error", message: `Run failed: ${(err as Error).message}` });
    finish(true);
    if (opts.manual) throw err;
    return { skipped: "error" as const };
  } finally {
    running.delete(userId);
  }
}

/** Runs every user whose autopilot is due. Started from index.ts (not in tests). */
export function startAutopilotScheduler(ctx: Ctx, everyMs = 60_000) {
  if (!ctx.config.AUTOPILOT_ENABLED) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = all<{ user_id: string }>(
        ctx.db,
        `SELECT user_id FROM autopilot_settings
         WHERE enabled = 1 AND paused_reason IS NULL AND (next_run_at IS NULL OR next_run_at <= ?)
         ORDER BY next_run_at LIMIT 25`,
        nowIso(),
      );
      for (const { user_id } of due) {
        await runAutopilot(ctx, user_id).catch((err) => console.error(`[autopilot] ${user_id}:`, err));
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
