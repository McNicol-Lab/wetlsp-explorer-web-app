/**
 * One small chart per year on a shared day-of-year axis and a shared EVI
 * scale, so seasons compare by shape and height. Hover tracks the same day in
 * every panel; clicking a panel opens that year in the line chart.
 */
import { useMemo, useState } from 'react';
import { useSize } from './useSize';
import clsx from 'clsx';
import type { DailySummaryRow } from '@/lib/types';

const DAY = 86_400_000;
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_START = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

interface YearSeries {
  year: number;
  doy: number[];
  mean: number[];
  q25: number[];
  q75: number[];
  peak: { doy: number; value: number } | null;
  days: number;
}

function doyOf(iso: string): number {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Math.floor((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY) + 1;
}

export function YearMultiples({
  summary,
  years,
  series,
  color,
  activeYear,
  onPick,
}: {
  summary: DailySummaryRow[];
  years: number[];
  series: string;
  color: string;
  activeYear: number | null;
  onPick: (year: number) => void;
}) {
  const [hoverDoy, setHoverDoy] = useState<number | null>(null);
  const [hoverYear, setHoverYear] = useState<number | null>(null);

  const data = useMemo<YearSeries[]>(() => {
    const by = new Map<number, YearSeries>();
    for (const y of years) by.set(y, { year: y, doy: [], mean: [], q25: [], q75: [], peak: null, days: 0 });
    const rows = summary.filter((r) => r.series === series).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const r of rows) {
      const y = Number(r.date.slice(0, 4));
      const s = by.get(y);
      if (!s || !Number.isFinite(r.mean)) continue;
      const d = doyOf(r.date);
      s.doy.push(d);
      s.mean.push(r.mean);
      s.q25.push(r.q25);
      s.q75.push(r.q75);
      if (!s.peak || r.mean > s.peak.value) s.peak = { doy: d, value: r.mean };
    }
    for (const s of by.values()) s.days = s.doy.length;
    return [...by.values()];
  }, [summary, years, series]);

  // One EVI scale for every panel.
  const [lo, hi] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const s of data) {
      for (let i = 0; i < s.days; i++) {
        const l = Number.isFinite(s.q25[i]) ? s.q25[i] : s.mean[i];
        const h = Number.isFinite(s.q75[i]) ? s.q75[i] : s.mean[i];
        if (l < a) a = l;
        if (h > b) b = h;
      }
    }
    if (!Number.isFinite(a)) return [0, 1];
    const pad = (b - a) * 0.06 || 0.05;
    return [a - pad, b + pad];
  }, [data]);

  const cols = data.length === 4 ? 2 : Math.min(3, data.length);

  return (
    <div className="grid h-full min-h-0 gap-px bg-[var(--border)]" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
      {data.map((s) => (
        <Panel
          key={s.year}
          s={s}
          lo={lo}
          hi={hi}
          color={color}
          active={s.year === activeYear}
          dim={hoverYear !== null && hoverYear !== s.year}
          hoverDoy={hoverDoy}
          onHover={(d) => {
            setHoverDoy(d);
            setHoverYear(d === null ? null : s.year);
          }}
          onPick={() => onPick(s.year)}
        />
      ))}
    </div>
  );
}

function Panel({
  s, lo, hi, color, active, dim, hoverDoy, onHover, onPick,
}: {
  s: YearSeries;
  lo: number;
  hi: number;
  color: string;
  active: boolean;
  dim: boolean;
  hoverDoy: number | null;
  onHover: (doy: number | null) => void;
  onPick: () => void;
}) {
  const [box, size] = useSize<HTMLDivElement>();
  const W = Math.max(120, size.width);
  const H = Math.max(80, size.height);
  const pad = { l: 34, r: 10, t: 8, b: 20 };
  const x = (d: number) => pad.l + ((d - 1) / 365) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  let line = '';
  let band = '';
  let pen = false;
  for (let i = 0; i < s.days; i++) {
    // Break the line across gaps longer than a week: no bridging missing data.
    const gap = i > 0 && s.doy[i] - s.doy[i - 1] > 7;
    line += `${!pen || gap ? 'M' : 'L'}${x(s.doy[i]).toFixed(1)} ${y(s.mean[i]).toFixed(1)}`;
    pen = true;
  }
  const hasBand = s.q25.some(Number.isFinite);
  if (hasBand && s.days > 1) {
    const top = s.doy.map((d, i) => `${x(d).toFixed(1)} ${y(s.q75[i]).toFixed(1)}`);
    const bottom = s.doy.map((d, i) => `${x(d).toFixed(1)} ${y(s.q25[i]).toFixed(1)}`).reverse();
    band = `M${top.join('L')}L${bottom.join('L')}Z`;
  }

  // The value nearest the hovered day (within 3 days), never interpolated.
  let hv: { doy: number; mean: number } | null = null;
  if (hoverDoy !== null && s.days) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < s.days; i++) {
      const dd = Math.abs(s.doy[i] - hoverDoy);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best >= 0 && bd <= 3) hv = { doy: s.doy[best], mean: s.mean[best] };
  }

  // Round ticks: 0.1 or 0.2 steps inside the shared range.
  const tickStep = hi - lo > 0.6 ? 0.2 : hi - lo > 0.25 ? 0.1 : 0.05;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / tickStep) * tickStep; t <= hi + 1e-9; t += tickStep) ticks.push(Number(t.toFixed(2)));

  return (
    <button
      type="button"
      onClick={onPick}
      className={clsx(
        'group relative flex min-h-0 flex-col bg-[var(--bg-elevated)] text-left transition-opacity duration-150 focus-visible:z-10',
        dim && 'opacity-55',
      )}
      aria-label={`${s.year}: ${s.peak ? `peak EVI ${s.peak.value.toFixed(3)} on day ${s.peak.doy}` : 'no data'}. Open in the line chart.`}
    >
      <div className="flex items-baseline justify-between px-3 pt-2">
        <span className={clsx('text-[13px] font-semibold tabular-nums', active && 'text-[var(--accent)]')}>
          {s.year}
          {active && <span className="ml-1.5 inline-block h-1.5 w-1.5 -translate-y-0.5 rounded-full bg-[var(--accent)]" />}
        </span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
          {hv
            ? <>DOY {hv.doy} · <b className="font-medium text-[var(--text)]">{hv.mean.toFixed(3)}</b></>
            : s.peak
              ? <>peak <b className="font-medium text-[var(--text)]">{s.peak.value.toFixed(3)}</b> · DOY {s.peak.doy}</>
              : 'no data'}
        </span>
      </div>
      {s.days === 0 ? (
        <div className="grid flex-1 place-items-center text-[12px] text-[var(--text-faint)]">No {s.year} data in this sample.</div>
      ) : (
        <div ref={box} className="relative min-h-0 flex-1">
        <svg
          width={W}
          height={H}
          className="absolute inset-0"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const d = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * 365 + 1);
            onHover(d >= 1 && d <= 366 ? d : null);
          }}
          onMouseLeave={() => onHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9.5} fill="var(--text-faint)" className="tabular-nums">
                {t.toFixed(tickStep < 0.1 ? 2 : 1)}
              </text>
            </g>
          ))}
          {MONTH_START.map((d, i) => (
            <text key={d} x={x(d + 14)} y={H - 6} textAnchor="middle" fontSize={9.5} fill="var(--text-faint)">
              {MONTHS[i]}
            </text>
          ))}
          {band && <path d={band} fill={color} opacity={0.14} />}
          <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
          {s.peak && <circle cx={x(s.peak.doy)} cy={y(s.peak.value)} r={3} fill="var(--lime)" stroke={color} strokeWidth={1.2} />}
          {hoverDoy !== null && (
            <line x1={x(hoverDoy)} x2={x(hoverDoy)} y1={pad.t} y2={H - pad.b} stroke="var(--text-faint)" strokeDasharray="2 3" />
          )}
          {hv && <circle cx={x(hv.doy)} cy={y(hv.mean)} r={3.2} fill={color} />}
        </svg>
        </div>
      )}
    </button>
  );
}
