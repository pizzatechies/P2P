import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { num } from "../format";
import type { Bar } from "../types";

/**
 * A y-axis that starts and ends on a gridline, in round steps, with about one gridline per
 * `spacing` pixels of plot height (so phones get fewer, desktops more, never crowded). Very small
 * or flat ranges are widened to `minSpan` first, so a flat line sits on a sensible scale instead
 * of a pile of gridlines all labelled the same.
 */
function niceScale(lo: number, hi: number, plotHeight: number, { minSpan = 1, spacing = 44 } = {}) {
  let min = lo;
  let max = hi;
  if (!(max - min >= minSpan)) {
    const mid = (min + max) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  const count = Math.max(2, Math.min(6, Math.floor(plotHeight / spacing)));
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw * 0.999) ?? 10 * mag;
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let k = first; k <= last; k++) ticks.push(Number((k * step).toFixed(10)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks, step };
}

/** Gridlines on whole pixels (plus a half for 1-pixel lines), so they stay sharp on every screen. */
const crisp = (v: number) => Math.round(v) + 0.5;

function smaSeries(values: number[], period: number): (number | null)[] {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= period) sum -= values[i - period];
    return i >= period - 1 ? sum / period : null;
  });
}

const SERIES = [
  { key: "close", label: "Close", color: "var(--series-1)" },
  { key: "sma20", label: "SMA 20", color: "var(--series-2)" },
  { key: "sma50", label: "SMA 50", color: "var(--series-3)" },
] as const;

/**
 * Daily close with 20- and 50-day moving averages. One y-axis, 2px lines, recessive grid,
 * crosshair that snaps to the nearest day with a tooltip listing every series, a legend,
 * and a data-table view for readers who can't use the hover layer.
 */
export function PriceChart({ bars, height: heightProp = 280, title }: { bars: Bar[]; height?: number; title: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real pixel width so text and strokes stay crisp on every screen.
  const [width, setWidth] = useState(760);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bars.length >= 2]);
  const height = Math.round(Math.max(200, Math.min(heightProp, width * 0.6)));
  const pad = { top: 12, right: 52, bottom: 26, left: 8 };

  const model = useMemo(() => {
    // Compute SMAs over the full history, then show the most recent window.
    const closes = bars.map((b) => b.c);
    const s20 = smaSeries(closes, 20);
    const s50 = smaSeries(closes, 50);
    const shown = Math.min(bars.length, 120);
    const from = bars.length - shown;
    const rows = bars.slice(from).map((b, i) => ({ t: b.t, close: b.c, sma20: s20[from + i], sma50: s50[from + i] }));
    const vals = rows.flatMap((r) => [r.close, r.sma20, r.sma50]).filter((v): v is number => v !== null);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const iw = width - pad.left - pad.right;
    const ih = height - pad.top - pad.bottom;
    const padY = (hi - lo) * 0.04;
    const { ticks, min: yMin, max: yMax } = niceScale(lo - padY, hi + padY, ih, { minSpan: Math.max(Math.abs(hi) * 0.02, 0.01) });
    const x = (i: number) => pad.left + (rows.length <= 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
    const path = (key: "close" | "sma20" | "sma50") => {
      let d = "";
      let pen = false;
      rows.forEach((r, i) => {
        const v = r[key];
        if (v === null) {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const area = `${path("close")}L${x(rows.length - 1).toFixed(1)},${(pad.top + ih).toFixed(1)}L${x(0).toFixed(1)},${(pad.top + ih).toFixed(1)}Z`;
    const monthTicks: { i: number; label: string }[] = [];
    rows.forEach((r, i) => {
      const m = r.t.slice(0, 7);
      if (i === 0 || m !== rows[i - 1].t.slice(0, 7)) {
        const tooClose = monthTicks.length > 0 && x(i) - x(monthTicks[monthTicks.length - 1].i) < 44;
        if (i > 4 && i < rows.length - 4 && !tooClose) {
          monthTicks.push({ i, label: new Date(r.t + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) });
        }
      }
    });
    return { rows, ticks, x, y, path, area, iw, ih, monthTicks };
  }, [bars, height, width]);

  if (bars.length < 2) return <div className="empty">Not enough price history yet.</div>;
  const { rows, ticks, x, y, path, area, ih, monthTicks } = model;
  const last = rows[rows.length - 1];

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / (width - pad.left - pad.right)) * (rows.length - 1));
    setHover(Math.max(0, Math.min(rows.length - 1, i)));
  }

  const h = hover !== null ? rows[hover] : null;
  const tipLeftPct = hover !== null ? (x(hover) / width) * 100 : 0;

  return (
    <div className="stack-sm">
      <div className="legend" aria-hidden="true">
        {SERIES.map((s) => (
          <span key={s.key} className="key">
            <span className="line-key" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart" ref={wrapRef}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title}: last close ${num(last.close)}, 20-day average ${num(last.sma20)}, 50-day average ${num(last.sma50)}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={crisp(y(t))} y2={crisp(y(t))} />
              <text className="axis-text" x={width - pad.right + 8} y={y(t) + 4}>
                {t >= 1000 ? t.toLocaleString(undefined, { maximumFractionDigits: 0 }) : t.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </text>
            </g>
          ))}
          {monthTicks.map((m) => (
            <text key={m.i} className="axis-text" x={x(m.i)} y={height - 6} textAnchor="middle">
              {m.label}
            </text>
          ))}
          <path d={area} fill="var(--series-1)" opacity={0.08} />
          <path d={path("sma50")} fill="none" stroke="var(--series-3)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path("sma20")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path("close")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(rows.length - 1)} cy={y(last.close)} r={4} fill="var(--series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
          {h && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ih} stroke="var(--text-3)" strokeWidth={1} />
              {SERIES.map((s) => {
                const v = h[s.key];
                return v === null ? null : (
                  <circle key={s.key} cx={x(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--viz-surface)" strokeWidth={2} />
                );
              })}
            </g>
          )}
          <rect
            x={pad.left}
            y={pad.top}
            width={width - pad.left - pad.right}
            height={ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {h && (
          <div
            className="chart-tip"
            style={{
              top: 8,
              left: tipLeftPct > 60 ? undefined : `calc(${tipLeftPct}% + 12px)`,
              right: tipLeftPct > 60 ? `calc(${100 - tipLeftPct}% + 12px)` : undefined,
            }}
          >
            <div className="faint" style={{ marginBottom: 4 }}>
              {new Date(h.t + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
            </div>
            {SERIES.map((s) => (
              <div key={s.key} className="tip-row">
                <span className="row" style={{ gap: 6 }}>
                  <span className="line-key" style={{ background: s.color }} />
                  <span className="muted">{s.label}</span>
                </span>
                <strong>{num(h[s.key])}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="xs">
        <summary className="faint" style={{ cursor: "pointer" }}>View data table</summary>
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="r">Close</th>
                <th className="r">SMA 20</th>
                <th className="r">SMA 50</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().slice(0, 30).map((r) => (
                <tr key={r.t}>
                  <td>{r.t}</td>
                  <td className="r num">{num(r.close)}</td>
                  <td className="r num">{num(r.sma20)}</td>
                  <td className="r num">{num(r.sma50)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Tiny single-series trend line (no axes, no legend - the row it sits in names it). */
export function Sparkline({ values, width = 72, height = 24, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values
    .map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(2 + (1 - (v - lo) / span) * (height - 4)).toFixed(1)}`)
    .join("");
  const lastX = width - 2;
  const lastY = 2 + (1 - (values[values.length - 1] - lo) / span) * (height - 4);
  return (
    <svg width={width} height={height} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={d} fill="none" stroke="var(--spark)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}

const fmtMoney = (v: number) => v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
const fmtAxisMoney = (v: number, step = 1) => {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(step >= 1_000_000 ? 0 : 1)}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(step >= 1000 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2)}`;
};
const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function useWidth(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dep]);
  return { ref, width };
}

/**
 * Portfolio value by day: one series, so no legend (the title names it). Crosshair snaps to the
 * nearest day; the data table is there for readers who can't use the hover layer.
 */
export function EquityChart({ points, title, height: heightProp = 220 }: { points: { day: string; equity: number }[]; title: string; height?: number }) {
  const { ref, width } = useWidth(points.length >= 2);
  const [hover, setHover] = useState<number | null>(null);
  const height = Math.round(Math.max(170, Math.min(heightProp, width * 0.5)));
  const pad = { top: 12, right: 56, bottom: 26, left: 8 };
  const model = useMemo(() => {
    const vals = points.map((p) => p.equity);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const iw = width - pad.left - pad.right;
    const ih = height - pad.top - pad.bottom;
    const padY = (hi - lo) * 0.06;
    const { ticks, min: yMin, max: yMax, step } = niceScale(lo - padY, hi + padY, ih, { minSpan: Math.max(Math.abs(hi) * 0.02, 10) });
    const x = (i: number) => pad.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(1)},${(pad.top + ih).toFixed(1)}L${x(0).toFixed(1)},${(pad.top + ih).toFixed(1)}Z`;
    const labels: { i: number; label: string }[] = [];
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 90))));
    points.forEach((p, i) => {
      if (i % every === 0 && i < points.length - every / 2) {
        labels.push({ i, label: new Date(p.day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) });
      }
    });
    return { ticks, step, x, y, line, area, ih, labels };
  }, [points, width, height]);

  if (points.length < 2) return <div className="empty">The chart fills in as your portfolio is valued each day.</div>;
  const { ticks, step, x, y, line, area, ih, labels } = model;
  const last = points[points.length - 1];
  const h = hover !== null ? points[hover] : null;
  const tipLeftPct = hover !== null ? (x(hover) / width) * 100 : 0;
  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / (width - pad.left - pad.right)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }
  return (
    <div className="stack-sm">
      <div className="chart" ref={ref}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${fmtMoney(points[0].equity)} on ${fmtDay(points[0].day)}, ${fmtMoney(last.equity)} on ${fmtDay(last.day)}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={crisp(y(t))} y2={crisp(y(t))} />
              <text className="axis-text" x={width - pad.right + 8} y={y(t) + 4}>{fmtAxisMoney(t, step)}</text>
            </g>
          ))}
          {labels.map((l) => (
            <text key={l.i} className="axis-text" x={x(l.i)} y={height - 6} textAnchor={l.i === 0 ? "start" : "middle"}>{l.label}</text>
          ))}
          <path d={area} fill="var(--series-1)" opacity={0.08} />
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(points.length - 1)} cy={y(last.equity)} r={4} fill="var(--series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
          {h && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ih} stroke="var(--text-3)" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.equity)} r={4} fill="var(--series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
            </g>
          )}
          <rect x={pad.left} y={pad.top} width={width - pad.left - pad.right} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {h && (
          <div className="chart-tip" style={{ top: 8, left: tipLeftPct > 60 ? undefined : `calc(${tipLeftPct}% + 12px)`, right: tipLeftPct > 60 ? `calc(${100 - tipLeftPct}% + 12px)` : undefined }}>
            <div className="faint" style={{ marginBottom: 4 }}>{fmtDay(h.day)}</div>
            <div className="tip-row"><span className="muted">Value</span><strong>{fmtMoney(h.equity)}</strong></div>
          </div>
        )}
      </div>
      <details className="xs">
        <summary className="faint" style={{ cursor: "pointer" }}>View data table</summary>
        <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
          <table className="table">
            <thead><tr><th>Day</th><th className="r">Value</th></tr></thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.day}><td>{p.day}</td><td className="r num">{fmtMoney(p.equity)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/**
 * Realised profit or loss per period: bars grow up from zero for a gain (blue) and down for a loss
 * (red), with the sign also in the tooltip and table, so colour is never the only cue.
 */
export function PnlBars({ bars, title, height: heightProp = 200 }: { bars: { label: string; value: number; detail?: string }[]; title: string; height?: number }) {
  const { ref, width } = useWidth(bars.length);
  const [hover, setHover] = useState<number | null>(null);
  const height = Math.round(Math.max(160, Math.min(heightProp, width * 0.5)));
  const pad = { top: 12, right: 56, bottom: 26, left: 8 };
  const vals = bars.map((b) => b.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  // Nothing realised yet: a $0 line on a $0 to $10 scale, not a stack of identical labels.
  const { ticks, min: yMin, max: yMax, step } = niceScale(lo, hi === lo ? lo + 10 : hi, ih, { minSpan: 10 });
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const slot = iw / Math.max(1, bars.length);
  const bw = Math.max(4, Math.min(28, slot - 2)); // 2px surface gap between bars
  const zero = y(0);
  const h = hover !== null ? bars[hover] : null;
  const tipLeftPct = hover !== null ? ((pad.left + slot * (hover + 0.5)) / width) * 100 : 0;
  const total = vals.reduce((s, v) => s + v, 0);
  return (
    <div className="stack-sm">
      <div className="chart" ref={ref}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${fmtMoney(total)} in total`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={crisp(y(t))} y2={crisp(y(t))} />
              <text className="axis-text" x={width - pad.right + 8} y={y(t) + 4}>{fmtAxisMoney(t, step)}</text>
            </g>
          ))}
          <line x1={pad.left} x2={width - pad.right} y1={crisp(zero)} y2={crisp(zero)} stroke="var(--text-3)" strokeWidth={1} shapeRendering="crispEdges" />
          {bars.map((b, i) => {
            const cx = pad.left + slot * (i + 0.5);
            const top = Math.min(y(b.value), zero);
            const hgt = Math.abs(y(b.value) - zero);
            const r = Math.min(4, hgt / 2, bw / 2);
            // Round only the end away from the baseline.
            const x0 = cx - bw / 2;
            const x1 = cx + bw / 2;
            const d =
              b.value >= 0
                ? `M${x0},${zero}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${zero}Z`
                : `M${x0},${zero}V${zero + hgt - r}Q${x0},${zero + hgt} ${x0 + r},${zero + hgt}H${x1 - r}Q${x1},${zero + hgt} ${x1},${zero + hgt - r}V${zero}Z`;
            return (
              <g key={b.label}>
                {hgt > 0.5 && <path d={d} fill={b.value >= 0 ? "var(--div-pos)" : "var(--div-neg)"} opacity={hover === null || hover === i ? 1 : 0.55} />}
                <text className="axis-text" x={cx} y={height - 6} textAnchor="middle">{bars.length > 8 && width < 520 ? b.label.slice(0, 1) : b.label}</text>
                <rect x={pad.left + slot * i} y={pad.top} width={slot} height={ih} fill="transparent" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
        {h && (
          <div className="chart-tip" style={{ top: 8, left: tipLeftPct > 60 ? undefined : `calc(${tipLeftPct}% + 12px)`, right: tipLeftPct > 60 ? `calc(${100 - tipLeftPct}% + 12px)` : undefined }}>
            <div className="faint" style={{ marginBottom: 4 }}>{h.label}</div>
            <div className="tip-row"><span className="muted">{h.value >= 0 ? "Gain" : "Loss"}</span><strong>{h.value > 0 ? "+" : ""}{fmtMoney(h.value)}</strong></div>
            {h.detail && <div className="faint">{h.detail}</div>}
          </div>
        )}
      </div>
      <details className="xs">
        <summary className="faint" style={{ cursor: "pointer" }}>View data table</summary>
        <div className="table-wrap" style={{ marginTop: 6 }}>
          <table className="table">
            <thead><tr><th>Period</th><th className="r">Realised P&amp;L</th><th>Detail</th></tr></thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.label}><td>{b.label}</td><td className="r num">{b.value > 0 ? "+" : ""}{fmtMoney(b.value)}</td><td className="faint">{b.detail ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
