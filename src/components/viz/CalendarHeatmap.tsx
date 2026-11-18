/**
 * A year as a week × weekday grid, each day coloured by the sampled pixels'
 * mean EVI. Days without a value are hatched, never filled: with the raw
 * series that shows exactly when acquisitions exist; the spline series is
 * gap-filled, and the legend says so.
 */
import { useMemo, useState } from 'react';
import { GREENNESS_RAMP, rampToCssGradient, sampleRamp } from '@/lib/colorscales';
import type { DailySummaryRow } from '@/lib/types';
import { useSize } from './useSize';

const DAY = 86_400_000;
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

export function CalendarHeatmap({
  summary,
  year,
  series,
}: {
  summary: DailySummaryRow[];
  year: number;
  series: string;
}) {
  const [box, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ date: string; row: DailySummaryRow | null; x: number; y: number } | null>(null);

  const { byDate, lo, hi, count } = useMemo(() => {
    const m = new Map<string, DailySummaryRow>();
    let a = Infinity;
    let b = -Infinity;
    for (const r of summary) {
      if (r.series !== series || !r.date.startsWith(String(year)) || !Number.isFinite(r.mean)) continue;
      m.set(r.date.slice(0, 10), r);
      if (r.mean < a) a = r.mean;
      if (r.mean > b) b = r.mean;
    }
    return { byDate: m, lo: a, hi: b, count: m.size };
  }, [summary, year, series]);

  const start = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - start) / DAY;
  const firstDow = (new Date(start).getUTCDay() + 6) % 7; // Monday = 0
  const weeks = Math.ceil((days + firstDow) / 7);

  const labelW = 30;
  const topH = 18;
  const legendH = 40;
  const cell = Math.max(6, Math.min(22, Math.floor(Math.min((size.width - labelW - 8) / weeks, (size.height - topH - legendH) / 7)) - 2));
  const step = cell + 2;
  const gridW = labelW + weeks * step;

  const color = (v: number) => {
    const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    const [r, g, b] = sampleRamp(GREENNESS_RAMP, 0.08 + 0.92 * t);
    return `rgb(${r},${g},${b})`;
  };

  const cells: JSX.Element[] = [];
  for (let d = 0; d < days; d++) {
    const idx = d + firstDow;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const iso = new Date(start + d * DAY).toISOString().slice(0, 10);
    const r = byDate.get(iso) ?? null;
    const x = labelW + col * step;
    const y = topH + row * step;
    cells.push(
      <rect
        key={iso}
        x={x}
        y={y}
        width={cell}
        height={cell}
        rx={Math.min(3, cell / 4)}
        fill={r ? color(r.mean) : 'url(#cal-missing)'}
        stroke={hover?.date === iso ? 'var(--text)' : 'transparent'}
        strokeWidth={1.5}
        onMouseEnter={() => setHover({ date: iso, row: r, x: x + cell / 2, y })}
      />,
    );
  }
  const months = Array.from({ length: 12 }, (_, m) => {
    const d = (Date.UTC(year, m, 1) - start) / DAY;
    return { m, x: labelW + Math.floor((d + firstDow) / 7) * step };
  });

  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <div ref={box} className="relative flex h-full w-full flex-col items-center justify-center p-4" onMouseLeave={() => setHover(null)}>
      {count === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">No {series} values for {year} in this sample.</p>
      ) : size.width > 0 && (
        <>
          <div className="relative">
          <svg width={gridW} height={topH + 7 * step} role="img" aria-label={`Calendar of daily mean ${series} EVI in ${year}, ${count} days with values`}>
            <defs>
              <pattern id="cal-missing" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="4" fill="var(--bg-sunken)" />
                <line x1="0" y1="0" x2="0" y2="4" stroke="var(--border-strong)" strokeWidth="1" />
              </pattern>
            </defs>
            {months.map(({ m, x }) => (
              <text key={m} x={x} y={11} fontSize={10.5} fill="var(--text-faint)">
                {new Date(Date.UTC(year, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}
              </text>
            ))}
            {WEEKDAYS.map((w, i) => w && (
              <text key={i} x={0} y={topH + i * step + cell - 1} fontSize={10} fill="var(--text-faint)">{w}</text>
            ))}
            {cells}
          </svg>
          {hover && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px] shadow-[var(--shadow-pop)]"
              style={{ left: hover.x, top: hover.y - 6 }}
            >
              <div className="font-medium">{fmt(hover.date)}</div>
              {hover.row ? (
                <div className="tabular-nums text-[var(--text-muted)]">
                  mean <b className="font-medium text-[var(--text)]">{hover.row.mean.toFixed(3)}</b>
                  {Number.isFinite(hover.row.q25) && <> · IQR {hover.row.q25.toFixed(3)}–{hover.row.q75.toFixed(3)}</>}
                  <> · {hover.row.n} px</>
                </div>
              ) : (
                <div className="text-[var(--text-muted)]">No {series} value</div>
              )}
            </div>
          )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 whitespace-nowrap text-[11px] text-[var(--text-muted)]">
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{lo.toFixed(2)}</span>
              <span className="h-2.5 w-28 rounded-full" style={{ background: rampToCssGradient(GREENNESS_RAMP.slice(1)) }} />
              <span className="tabular-nums">{hi.toFixed(2)}</span>
              <span>mean {series} EVI</span>
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="12" height="12"><rect width="12" height="12" rx="3" fill="url(#cal-missing)" /></svg>
              no value
            </span>
            <span className="tabular-nums">{count} of {days} days</span>
            {series === 'spline' && <span className="text-[var(--text-faint)]">spline is gap-filled, not daily observations</span>}
          </div>

        </>
      )}
    </div>
  );
}
