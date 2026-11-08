import type { Bar } from "./market.js";

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(values: number[]) {
  if (values.length < 35) return null;
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const line = fast.map((f, i) => f - slow[i]);
  const signal = emaSeries(line.slice(25), 9);
  const m = line[line.length - 1];
  const s = signal[signal.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { h, l } = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/** Annualised volatility of daily log returns over the last `period` days. */
export function volatility(values: number[], period = 20): number | null {
  if (values.length <= period) return null;
  const rets: number[] = [];
  for (let i = values.length - period; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export interface IndicatorSummary {
  price: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr14: number | null;
  volatility20d: number | null;
  return5d: number | null;
  return20d: number | null;
  return60d: number | null;
  high52w: number | null;
  low52w: number | null;
}

const r4 = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);

export function summarize(bars: Bar[], livePrice?: number): IndicatorSummary {
  const closes = bars.map((b) => b.c);
  if (livePrice) closes.push(livePrice);
  const price = closes[closes.length - 1];
  const ret = (n: number) => (closes.length > n ? price / closes[closes.length - 1 - n] - 1 : null);
  const m = macd(closes);
  const year = bars.slice(-252);
  return {
    price,
    sma20: r4(sma(closes, 20)),
    sma50: r4(sma(closes, 50)),
    sma200: r4(sma(closes, 200)),
    rsi14: r4(rsi(closes, 14)),
    macd: r4(m?.macd ?? null),
    macdSignal: r4(m?.signal ?? null),
    macdHistogram: r4(m?.histogram ?? null),
    atr14: r4(atr(bars, 14)),
    volatility20d: r4(volatility(closes, 20)),
    return5d: r4(ret(5)),
    return20d: r4(ret(20)),
    return60d: r4(ret(60)),
    high52w: year.length ? Math.max(...year.map((b) => b.h)) : null,
    low52w: year.length ? Math.min(...year.map((b) => b.l)) : null,
  };
}
