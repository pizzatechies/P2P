import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { num } from "../format";
import type { Bar } from "../types";

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

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
    const padY = (hi - lo) * 0.08 || hi * 0.02;
    const ticks = niceTicks(lo - padY, hi + padY, 4);
    const yMin = Math.min(lo - padY, ticks[0]);
    const yMax = Math.max(hi + padY, ticks[ticks.length - 1]);
    const iw = width - pad.left - pad.right;
    const ih = height - pad.top - pad.bottom;
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
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
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
