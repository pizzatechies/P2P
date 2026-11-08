import { z } from "zod";
import type { Ctx } from "../../context.js";
import { all, nowIso, one, run } from "../../db/index.js";
import { newId } from "../../lib/ids.js";
import { completeStructured, tryResolve } from "../ai/gateway.js";
import { getProvider } from "../ai/providers.js";
import { brokerFor } from "./index.js";
import { summarize, type IndicatorSummary } from "./indicators.js";
import { normalizeSymbol } from "./market.js";

/** What the model must return. Ranges are enforced after parsing (clamped), not in the schema. */
export const SignalSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  confidence: z.number().describe("0 to 1"),
  position_pct: z.number().describe("Percent of total portfolio value to allocate for a buy (0 for hold/sell)"),
  stop_loss: z.number().nullable().describe("Suggested stop-loss price, or null"),
  take_profit: z.number().nullable().describe("Suggested take-profit price, or null"),
  horizon: z.enum(["days", "weeks", "months"]),
  rationale: z.string().describe("2-5 sentences explaining the call, citing the indicators"),
  risks: z.array(z.string()).describe("The main risks to this view, 2-4 short items"),
});
type SignalOutput = z.infer<typeof SignalSchema>;

interface SignalRow {
  id: string;
  symbol: string;
  provider: string;
  model: string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  suggested_qty: number;
  price: number;
  stop_loss: number | null;
  take_profit: number | null;
  horizon: string | null;
  rationale: string;
  risks: string;
  indicators: string;
  executed_order_id: string | null;
  created_at: string;
}

export const signalView = (s: SignalRow) => ({
  id: s.id,
  symbol: s.symbol,
  provider: s.provider,
  model: s.model,
  action: s.action,
  confidence: s.confidence,
  suggestedQty: s.suggested_qty,
  price: s.price,
  stopLoss: s.stop_loss,
  takeProfit: s.take_profit,
  horizon: s.horizon,
  rationale: s.rationale,
  risks: JSON.parse(s.risks) as string[],
  indicators: JSON.parse(s.indicators) as IndicatorSummary,
  executedOrderId: s.executed_order_id,
  createdAt: s.created_at,
});

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(2)}%`);
const fx = (n: number | null, d = 2) => (n === null ? "n/a" : n.toFixed(d));

/**
 * Transparent fallback model used when no AI provider is connected (or "rule-based" is chosen):
 * trend, momentum and mean-reversion votes, with ATR-based stop and target.
 */
export function ruleBasedSignal(ind: IndicatorSummary): SignalOutput {
  const reasons: string[] = [];
  let score = 0;
  if (ind.sma50 !== null) {
    if (ind.price > ind.sma50) (score += 1), reasons.push("price is above its 50-day average (uptrend)");
    else (score -= 1), reasons.push("price is below its 50-day average (downtrend)");
  }
  if (ind.sma20 !== null && ind.sma50 !== null) {
    if (ind.sma20 > ind.sma50) (score += 1), reasons.push("the 20-day average is above the 50-day (bullish crossover)");
    else (score -= 1), reasons.push("the 20-day average is below the 50-day (bearish crossover)");
  }
  if (ind.rsi14 !== null) {
    if (ind.rsi14 < 30) (score += 1), reasons.push(`RSI ${ind.rsi14.toFixed(0)} is oversold`);
    else if (ind.rsi14 > 70) (score -= 1), reasons.push(`RSI ${ind.rsi14.toFixed(0)} is overbought`);
    else reasons.push(`RSI ${ind.rsi14.toFixed(0)} is neutral`);
  }
  if (ind.macdHistogram !== null) {
    if (ind.macdHistogram > 0) (score += 0.5), reasons.push("MACD momentum is positive");
    else (score -= 0.5), reasons.push("MACD momentum is negative");
  }
  if (ind.return20d !== null) score += ind.return20d > 0 ? 0.5 : -0.5;

  const action: SignalOutput["action"] = score >= 2 ? "buy" : score <= -2 ? "sell" : "hold";
  const atr = ind.atr14 ?? ind.price * 0.02;
  const vol = ind.volatility20d ?? 0.3;
  return {
    action,
    confidence: Math.min(0.85, 0.35 + Math.abs(score) * 0.1),
    position_pct: action === "buy" ? Math.max(2, Math.min(10, 10 * (0.25 / Math.max(vol, 0.1)))) : 0,
    stop_loss: action === "hold" ? null : Math.round((ind.price - 2 * atr) * 100) / 100,
    take_profit: action === "hold" ? null : Math.round((ind.price + 3 * atr) * 100) / 100,
    horizon: "weeks",
    rationale: `Rule-based technical read: ${reasons.join("; ")}. Net score ${score.toFixed(1)} → ${action.toUpperCase()}.`,
    risks: [
      "Technical signals ignore news, earnings and fundamentals",
      `Recent volatility is ${pct(ind.volatility20d)} annualised`,
      "Past price patterns don't guarantee future moves",
    ],
  };
}

function buildPrompt(args: {
  symbol: string;
  name: string;
  dataSource: string;
  ind: IndicatorSummary;
  closes: { t: string; c: number }[];
  equity: number;
  cash: number;
  heldQty: number;
  avgCost: number | null;
  maxPct: number;
}) {
  const { ind } = args;
  return [
    `Analyse ${args.symbol} (${args.name}) and give a trading signal.`,
    ``,
    `Data source: ${args.dataSource === "simulated" ? "SIMULATED practice market (synthetic prices)" : "live market data"}`,
    `Latest price: ${ind.price.toFixed(2)}`,
    `SMA20 ${fx(ind.sma20)} | SMA50 ${fx(ind.sma50)} | SMA200 ${fx(ind.sma200)}`,
    `RSI14 ${fx(ind.rsi14, 1)} | MACD ${fx(ind.macd, 3)} signal ${fx(ind.macdSignal, 3)} histogram ${fx(ind.macdHistogram, 3)}`,
    `ATR14 ${fx(ind.atr14)} | 20d volatility (annualised) ${pct(ind.volatility20d)}`,
    `Returns: 5d ${pct(ind.return5d)} | 20d ${pct(ind.return20d)} | 60d ${pct(ind.return60d)}`,
    `52-week range: ${fx(ind.low52w)} - ${fx(ind.high52w)}`,
    ``,
    `Last ${args.closes.length} daily closes (oldest first):`,
    args.closes.map((b) => `${b.t} ${b.c.toFixed(2)}`).join(", "),
    ``,
    `Portfolio: equity $${args.equity.toFixed(2)}, cash $${args.cash.toFixed(2)}.`,
    args.heldQty > 0
      ? `Currently holding ${args.heldQty} shares at an average cost of ${args.avgCost?.toFixed(2)}.`
      : `No current position in ${args.symbol}.`,
    ``,
    `Rules:`,
    `- The account is long-only: "sell" means reduce or close an existing position. If there is no position, use "hold" instead of "sell".`,
    `- position_pct must be between 0 and ${Math.round(args.maxPct * 100)} and only applies to buys.`,
    `- Prefer "hold" when the evidence is mixed. Set confidence honestly (0 to 1).`,
    `- Stop-loss and take-profit should be price levels consistent with the action and recent volatility.`,
  ].join("\n");
}

const SYSTEM =
  "You are a disciplined equity analyst inside a trading app. You assess technical data objectively, size positions " +
  "conservatively, and always state the main risks. Your output is a decision aid that a human reviews before any order " +
  "is placed; it is not personalised financial advice.";

export async function analyze(ctx: Ctx, userId: string, input: { symbol: string; provider?: string; model?: string }) {
  const symbol = normalizeSymbol(input.symbol);
  const { broker, market } = brokerFor(ctx, userId);
  const [quote, bars, account] = await Promise.all([market.quote(symbol), market.bars(symbol, 260), broker.account()]);
  const ind = summarize(bars, quote.price);
  const held = account.positions.find((p) => p.symbol === symbol);

  // Pick the model: explicit choice → server default → Claude if connected → rule-based.
  let provider = input.provider;
  let model = input.model;
  if (!provider || provider === "rules") {
    if (!provider && ctx.config.AI_DEFAULT_MODEL) {
      const [p, ...rest] = ctx.config.AI_DEFAULT_MODEL.split(":");
      provider = p;
      model = rest.join(":");
    } else if (!provider && tryResolve(ctx, userId, "anthropic")) {
      provider = "anthropic";
      model = "claude-opus-5-5";
    } else {
      provider = "rules";
    }
  }
  if (provider !== "rules" && !model) model = getProvider(provider)?.models[0]?.id;

  let output: SignalOutput;
  let servedModel = "technical-rules-v1";
  if (provider === "rules" || provider === "demo") {
    provider = "rules";
    output = ruleBasedSignal(ind);
  } else {
    const result = await completeStructured(ctx, userId, {
      provider,
      model: model!,
      system: SYSTEM,
      prompt: buildPrompt({
        symbol,
        name: quote.name,
        dataSource: market.source,
        ind,
        closes: bars.slice(-30).map((b) => ({ t: b.t, c: b.c })),
        equity: account.equity,
        cash: account.cash,
        heldQty: held?.qty ?? 0,
        avgCost: held?.avgCost ?? null,
        maxPct: ctx.config.AI_MAX_POSITION_PCT,
      }),
      schema: SignalSchema,
    });
    output = result.data;
    servedModel = result.model;
  }

  // Guardrails on whatever the model said.
  let action = output.action;
  if (action === "sell" && !held) action = "hold";
  const confidence = Math.max(0, Math.min(1, output.confidence > 1 ? output.confidence / 100 : output.confidence));
  const positionPct = Math.max(0, Math.min(ctx.config.AI_MAX_POSITION_PCT * 100, output.position_pct));
  let suggestedQty = 0;
  if (action === "buy") {
    const budget = Math.min((account.equity * positionPct) / 100, account.buyingPower);
    suggestedQty = budget >= quote.price ? Math.floor(budget / quote.price) : Math.floor((budget / quote.price) * 10000) / 10000;
  } else if (action === "sell" && held) {
    suggestedQty = held.qty;
  }

  const id = newId("sig");
  run(
    ctx.db,
    `INSERT INTO ai_signals (id, user_id, symbol, provider, model, action, confidence, suggested_qty, price, stop_loss, take_profit,
       horizon, rationale, risks, indicators, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    symbol,
    provider,
    servedModel,
    action,
    Math.round(confidence * 100) / 100,
    suggestedQty,
    quote.price,
    output.stop_loss,
    output.take_profit,
    output.horizon,
    action !== output.action ? `${output.rationale} (Adjusted to HOLD: there is no position to sell.)` : output.rationale,
    JSON.stringify(output.risks.slice(0, 6)),
    JSON.stringify(ind),
    nowIso(),
  );
  return { signal: signalView(one<SignalRow>(ctx.db, "SELECT * FROM ai_signals WHERE id = ?", id)!), quote, dataSource: market.source };
}

export function listSignals(ctx: Ctx, userId: string, symbol?: string) {
  const rows = symbol
    ? all<SignalRow>(ctx.db, "SELECT * FROM ai_signals WHERE user_id = ? AND symbol = ? ORDER BY created_at DESC LIMIT 20", userId, normalizeSymbol(symbol))
    : all<SignalRow>(ctx.db, "SELECT * FROM ai_signals WHERE user_id = ? ORDER BY created_at DESC LIMIT 30", userId);
  return rows.map(signalView);
}

export function getSignal(ctx: Ctx, userId: string, id: string) {
  const row = one<SignalRow>(ctx.db, "SELECT * FROM ai_signals WHERE id = ? AND user_id = ?", id, userId);
  return row ? signalView(row) : null;
}
