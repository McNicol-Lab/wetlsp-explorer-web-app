/**
 * Phenometrics "Season": a bento of the site's NetCDF timing layers across
 * every imported year. Each layer is read at full resolution and reduced to
 * quantiles over its valid (non-fill) cells, so nothing here is pooled or
 * smoothed. Years or layers without valid cells are shown as absent.
 */
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { readRaster, MAX_CELL_BUDGET } from '@/engine/netcdf';
import { useAsyncData, ErrorPanel } from './shared';
import { layerInfo } from '@/lib/layers';
import { formatCount } from '@/lib/format';
import type { SiteManifest } from '@/lib/types';

/** The cycle-1 timing layers, in seasonal order. */
const TIMING = ['OGI', '50PCGI', 'Peak', '50PCGD', 'OGMn'] as const;
type Timing = (typeof TIMING)[number];
const NAMES: Record<Timing, string> = {
  OGI: 'Onset of greenness increase',
  '50PCGI': '50% greenness increase',
  Peak: 'Peak',
  '50PCGD': '50% greenness decrease',
  OGMn: 'Onset of greenness minimum',
};

interface Stats {
  n: number;
  total: number;
  q10: number;
  q25: number;
  q50: number;
  q75: number;
  q90: number;
  /** 24-bin histogram over [lo, hi] of the layer across all years. */
  values: Float32Array;
}

interface YearSummary {
  year: number;
  timing: Partial<Record<Timing, Stats>>;
  layer: Stats | null;
}

function quantiles(values: Float32Array): Stats | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  finite.sort();
  const q = (p: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(p * (finite.length - 1))))];
  return { n: finite.length, total: values.length, q10: q(0.1), q25: q(0.25), q50: q(0.5), q75: q(0.75), q90: q(0.9), values: finite };
}

function useSeasonSummary(manifest: SiteManifest | null, layer: string | null, available: string[]) {
  const years = useMemo(() => [...new Set(manifest?.netcdf.map((n) => n.year) ?? [])].sort((a, b) => a - b), [manifest]);
  const timing = TIMING.filter((t) => available.includes(t));
  return useAsyncData<YearSummary[]>(
    async ({ signal, onProgress }) => {
      if (!manifest) return [];
      const out: YearSummary[] = [];
      for (const year of years) {
        const row: YearSummary = { year, timing: {}, layer: null };
        for (const t of timing) {
          onProgress({ phase: 'netcdf', fraction: null, detail: `Reading ${t} · ${year}` });
          const slice = await readRaster(manifest, year, t, MAX_CELL_BUDGET, { signal, onProgress });
          const st = quantiles(slice.values);
          if (st) row.timing[t] = st;
        }
        if (layer) {
          const known = row.timing[layer as Timing];
          if (known) row.layer = known;
          else {
            onProgress({ phase: 'netcdf', fraction: null, detail: `Reading ${layer} · ${year}` });
            const slice = await readRaster(manifest, year, layer, MAX_CELL_BUDGET, { signal, onProgress });
            row.layer = quantiles(slice.values);
          }
        }
        out.push(row);
      }
      return out;
    },
    [manifest?.siteId, years.join(','), layer, timing.join(',')],
    { enabled: Boolean(manifest && years.length) },
  );
}

/* ---------------------------------------------------------------- dates */

const MONTH_START = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Day of year (may fall outside 1–365 for the previous / next year) as a date label. */
function doyLabel(doy: number, year: number): string {
  const d = new Date(Date.UTC(year, 0, Math.round(doy)));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getUTCFullYear() !== year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

/* ---------------------------------------------------------------- bento */

export function PhenoSeason({ manifest, layer, available }: { manifest: SiteManifest; layer: string | null; available: string[] }) {
  const summary = useSeasonSummary(manifest, layer, available);
  const [focusYear, setFocusYear] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  if (summary.error && !summary.data) return <ErrorPanel message={summary.error} onRetry={summary.reload} />;
  if (!summary.data) return <SeasonSkeleton detail={summary.progress?.detail} />;

  const rows = summary.data;
  const withSeason = rows.filter((r) => r.timing.OGI || r.timing.Peak || r.timing.OGMn);
  const active = rows.find((r) => r.year === focusYear) ?? [...withSeason].reverse()[0] ?? rows[rows.length - 1];

  // One calendar axis for every year: the central 80% of all timing values.
  let lo = 1;
  let hi = 366;
  for (const r of rows) for (const t of TIMING) {
    const s = r.timing[t];
    if (!s) continue;
    lo = Math.min(lo, s.q10);
    hi = Math.max(hi, s.q90);
  }
  lo = Math.floor(lo / 15) * 15;
  hi = Math.ceil(hi / 15) * 15;

  return (
    <div className="panel-reveal grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] grid-rows-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3 overflow-auto p-3 max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-none">
      <Tile title="Seasonal profile" hint="Median of valid cells per year · whiskers are the 25–75% range" className="min-h-[240px]">
        <SeasonProfile rows={rows} lo={lo} hi={hi} active={active?.year ?? null} onPick={setFocusYear} hover={hover} onHover={setHover} />
      </Tile>

      <Tile title={active ? `Season ring · ${active.year}` : 'Season ring'} hint="Calendar year as a ring; medians only" className="min-h-[240px]">
        {active ? <SeasonArc row={active} /> : <Empty text="No timing layers with valid cells." />}
      </Tile>

      <Tile
        title={layer ? `${layer} across years` : 'Layer across years'}
        hint={layer ? `${layerInfo(layer).description} · ${layerInfo(layer).units ?? ''}` : undefined}
        className="col-span-2 min-h-[200px] max-[1100px]:col-span-1"
      >
        {layer ? <Ridges rows={rows} layer={layer} /> : <Empty text="Pick a layer in the details panel." />}
      </Tile>
    </div>
  );
}

function Tile({ title, hint, className, children }: { title: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={clsx('flex min-h-0 flex-col rounded-[14px] border border-[var(--border)] bg-[var(--bg-elevated)]', className)}>
      <header className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-3">
        <h3 className="shrink-0 whitespace-nowrap text-[13px] font-semibold tracking-[-0.01em]">{title}</h3>
        {hint && <span className="truncate text-[11px] text-[var(--text-faint)]" title={hint}>{hint}</span>}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid h-full place-items-center p-6 text-center text-[12px] text-[var(--text-muted)]">{text}</div>;
}

function SeasonSkeleton({ detail }: { detail?: string }) {
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_300px] grid-rows-[minmax(0,1.25fr)_minmax(0,1fr)] gap-3 p-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={clsx('rounded-[14px] border border-[var(--border)] bg-[var(--bg-elevated)] p-4', i === 2 && 'col-span-2')}>
          <div className="skeleton h-3 w-28" />
          <div className="mt-5 space-y-3">
            {[0, 1, 2, 3].map((j) => <div key={j} className="skeleton h-3" style={{ width: `${60 + ((i + j) % 3) * 12}%` }} />)}
          </div>
        </div>
      ))}
      <div className="col-span-2 -mt-1 text-center text-[11px] text-[var(--text-faint)]">{detail ?? 'Reading phenometric layers'}…</div>
    </div>
  );
}

/* --------------------------------------------------------- season profile */

function SeasonProfile({
  rows, lo, hi, active, onPick, hover, onHover,
}: {
  rows: YearSummary[];
  lo: number;
  hi: number;
  active: number | null;
  onPick: (y: number) => void;
  hover: string | null;
  onHover: (k: string | null) => void;
}) {
  const x = (d: number) => `${((d - lo) / (hi - lo)) * 100}%`;
  const ticks = MONTH_START.filter((d) => d >= lo && d <= hi);
  return (
    <div className="flex h-full flex-col pb-3 pl-14 pr-4">
      <div className="relative min-h-0 flex-1">
        {/* month grid */}
        {ticks.map((d, i) => (
          <div key={d} className="absolute inset-y-0 border-l border-[var(--grid)]" style={{ left: x(d) }}>
            <span className="absolute -bottom-0.5 left-1 translate-y-full text-[10px] text-[var(--text-faint)]">{MONTH[i % 12]}</span>
          </div>
        ))}
        {(lo < 1 || hi > 366) && (
          <>
            {lo < 1 && <div className="absolute inset-y-0 left-0 bg-[var(--bg-sunken)] opacity-60" style={{ width: x(1) }} title="Previous calendar year" />}
            {hi > 366 && <div className="absolute inset-y-0 right-0 bg-[var(--bg-sunken)] opacity-60" style={{ left: x(366) }} title="Next calendar year" />}
          </>
        )}
        <div className="relative flex h-full flex-col justify-around">
          {rows.map((r) => {
            const t = r.timing;
            const start = t.OGI?.q50;
            const end = t.OGMn?.q50;
            const up = t['50PCGI']?.q50;
            const down = t['50PCGD']?.q50;
            const peak = t.Peak?.q50;
            const none = start === undefined && end === undefined && peak === undefined;
            const key = (k: string) => `${r.year}:${k}`;
            return (
              <button
                key={r.year}
                type="button"
                onClick={() => onPick(r.year)}
                className={clsx('group relative flex h-9 items-center text-left', active === r.year && 'is-active')}
                aria-label={`${r.year}: ${none ? 'no valid timing estimates' : `season ${start !== undefined ? doyLabel(start, r.year) : '?'} to ${end !== undefined ? doyLabel(end, r.year) : '?'}`}`}
              >
                <span className={clsx('absolute -left-1 z-10 -translate-x-full pr-2 text-[12px] font-semibold tabular-nums', active === r.year ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} style={{ left: 0 }}>
                  {r.year}
                </span>
                {none ? (
                  <span className="absolute left-2 text-[11px] text-[var(--text-faint)]">no valid estimates</span>
                ) : (
                  <>
                    {start !== undefined && end !== undefined && (
                      <span className="absolute h-[14px] rounded-full bg-[var(--pale)] ring-1 ring-[var(--season-off)]" style={{ left: x(start), width: `calc(${x(end)} - ${x(start)})` }} />
                    )}
                    {up !== undefined && down !== undefined && (
                      <span
                        className="absolute h-[14px] rounded-full transition-[filter] duration-150 group-hover:brightness-95"
                        style={{ left: x(up), width: `calc(${x(down)} - ${x(up)})`, background: 'linear-gradient(90deg, var(--season-rise), var(--season-fall))' }}
                      />
                    )}
                    {/* IQR whiskers at the season's ends */}
                    {(['OGI', 'OGMn'] as const).map((k) => t[k] && (
                      <span key={k} className="absolute h-px bg-[var(--text-faint)]" style={{ left: x(t[k]!.q25), width: `calc(${x(t[k]!.q75)} - ${x(t[k]!.q25)})`, top: '50%' }} />
                    ))}
                    {TIMING.map((k) => {
                      const s = t[k];
                      if (!s) return null;
                      const isPeak = k === 'Peak';
                      return (
                        <span
                          key={k}
                          onMouseEnter={() => onHover(key(k))}
                          onMouseLeave={() => onHover(null)}
                          className={clsx(
                            'absolute z-10 -translate-x-1/2 rounded-full border-2 bg-[var(--bg-elevated)] transition-transform duration-150',
                            isPeak ? 'h-[14px] w-[14px] border-[var(--accent-strong)]' : 'h-[10px] w-[10px] border-[var(--accent)]',
                            hover === key(k) && 'scale-125',
                          )}
                          style={{ left: x(s.q50) }}
                        >
                          {isPeak && <span className="m-[2px] block h-[6px] w-[6px] rounded-full bg-[var(--lime)]" />}
                          {hover === key(k) && (
                            <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] shadow-[var(--shadow-pop)]">
                              <b className="font-medium">{k}</b> <span className="text-[var(--text-muted)]">{NAMES[k]}</span>
                              <span className="block tabular-nums text-[var(--text-muted)]">
                                median {doyLabel(s.q50, r.year)} (DOY {Math.round(s.q50)}) · IQR {Math.round(s.q25)}–{Math.round(s.q75)} · {formatCount(s.n)} cells
                              </span>
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="h-4" />
      <div className="-ml-10 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-full bg-[var(--pale)] ring-1 ring-[var(--season-off)]" />OGI → OGMn</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-full" style={{ background: 'linear-gradient(90deg, var(--season-rise), var(--season-fall))' }} />50% up → 50% down</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-[var(--accent-strong)] bg-[var(--lime)]" />Peak</span>
        <span className="text-[var(--text-faint)]">Click a year for its ring</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ season arc */

function SeasonArc({ row }: { row: YearSummary }) {
  const [hover, setHover] = useState<Timing | null>(null);
  const S = 220;
  const c = S / 2;
  const R = 78;
  const ang = (doy: number) => ((doy - 1) / 365) * 2 * Math.PI - Math.PI / 2;
  const pt = (doy: number, r = R) => [c + r * Math.cos(ang(doy)), c + r * Math.sin(ang(doy))] as const;
  const arc = (a: number, b: number, r = R) => {
    // Clamp to the calendar year: the ring is one year; out-of-year tails are noted, not wrapped.
    const s = Math.max(1, a);
    const e = Math.min(366, b);
    if (e <= s) return '';
    const [x1, y1] = pt(s, r);
    const [x2, y2] = pt(e, r);
    const large = e - s > 182.5 ? 1 : 0;
    return `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const t = row.timing;
  const outOfYear = TIMING.some((k) => t[k] && (t[k]!.q50 < 1 || t[k]!.q50 > 366));
  const length = t.OGI && t.OGMn ? Math.round(t.OGMn.q50 - t.OGI.q50) : null;
  const shown = hover ? t[hover] : t.Peak;

  return (
    <div className="flex h-full flex-col items-center justify-center pb-3">
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Season ring for ${row.year}`}>
        <circle cx={c} cy={c} r={R} fill="none" stroke="var(--season-off)" strokeWidth={12} />
        {MONTH_START.slice(0, 12).map((d, i) => {
          const [x1, y1] = pt(d, R + 9);
          const [x2, y2] = pt(d, R + 13);
          const [lx, ly] = pt(d + 15, R + 24);
          return (
            <g key={d}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text-faint)" strokeWidth={1} />
              {i % 3 === 0 && <text x={lx} y={ly + 3} textAnchor="middle" fontSize={9.5} fill="var(--text-faint)">{MONTH[i]}</text>}
            </g>
          );
        })}
        {t.OGI && t.OGMn && <path d={arc(t.OGI.q50, t.OGMn.q50)} fill="none" stroke="var(--pale)" strokeWidth={12} />}
        {t['50PCGI'] && t['50PCGD'] && <path d={arc(t['50PCGI'].q50, t['50PCGD'].q50)} fill="none" stroke="var(--season-rise)" strokeWidth={12} strokeLinecap="round" />}
        {TIMING.map((k) => {
          const s = t[k];
          if (!s || s.q50 < 1 || s.q50 > 366) return null;
          const [x, y] = pt(s.q50);
          const isPeak = k === 'Peak';
          return (
            <circle
              key={k}
              cx={x}
              cy={y}
              r={isPeak ? 7 : hover === k ? 6 : 4.5}
              fill={isPeak ? 'var(--lime)' : 'var(--bg-elevated)'}
              stroke={isPeak ? 'var(--accent-strong)' : 'var(--accent)'}
              strokeWidth={2}
              onMouseEnter={() => setHover(k)}
              onMouseLeave={() => setHover(null)}
              className="cursor-default transition-all duration-150"
            >
              <title>{`${k}: ${doyLabel(s.q50, row.year)} (DOY ${Math.round(s.q50)})`}</title>
            </circle>
          );
        })}
        <text x={c} y={c - 8} textAnchor="middle" fontSize={11} fill="var(--text-muted)">{hover ?? 'Peak'}</text>
        <text x={c} y={c + 12} textAnchor="middle" fontSize={17} fontWeight={600} fill="var(--text)" className="tabular-nums">
          {shown ? doyLabel(shown.q50, row.year) : '—'}
        </text>
        {length !== null && (
          <text x={c} y={c + 30} textAnchor="middle" fontSize={10.5} fill="var(--text-faint)" className="tabular-nums">{length} d OGI → OGMn</text>
        )}
      </svg>
      {outOfYear && <p className="px-4 text-center text-[10.5px] text-[var(--text-faint)]">Some medians fall outside {row.year}; the ring shows the calendar year only.</p>}
    </div>
  );
}

/* --------------------------------------------------------------- ridges */

function Ridges({ rows, layer }: { rows: YearSummary[]; layer: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const present = rows.filter((r) => r.layer);
  if (present.length === 0) return <Empty text={`No valid ${layer} cells in any year.`} />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of present) {
    lo = Math.min(lo, r.layer!.q10);
    hi = Math.max(hi, r.layer!.q90);
  }
  const pad = (hi - lo) * 0.15 || 1;
  lo -= pad;
  hi += pad;
  const BINS = 40;
  const units = layerInfo(layer).units ?? '';
  const timing = /day/.test(units);
  // Counts (e.g. NumCycles) are whole numbers: label them as such.
  const integer = present.every((r) => {
    const v = r.layer!.values;
    for (let i = 0; i < Math.min(v.length, 2000); i++) if (!Number.isInteger(v[i])) return false;
    return true;
  });
  const fmt = (v: number) =>
    timing || integer ? Math.round(v).toString() : Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_220px] gap-4 px-4 pb-3 max-[900px]:grid-cols-1">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-around">
          {rows.map((r) => {
            if (!r.layer) {
              return (
                <div key={r.year} className="flex h-8 items-center gap-3 text-[11px]">
                  <span className="w-9 font-semibold tabular-nums text-[var(--text-muted)]">{r.year}</span>
                  <span className="text-[var(--text-faint)]">no valid cells</span>
                </div>
              );
            }
            const counts = new Array(BINS).fill(0);
            for (const v of r.layer.values) {
              const b = Math.floor(((v - lo) / (hi - lo)) * BINS);
              if (b >= 0 && b < BINS) counts[b]++;
            }
            const max = Math.max(...counts) || 1;
            const path = counts.map((cnt, i) => `${i === 0 ? 'M' : 'L'}${(i + 0.5) * (100 / BINS)} ${30 - (cnt / max) * 26}`).join('');
            const xp = (v: number) => ((v - lo) / (hi - lo)) * 100;
            return (
              <div
                key={r.year}
                className={clsx('flex h-8 items-end gap-3 transition-opacity duration-150', hover !== null && hover !== r.year && 'opacity-40')}
                onMouseEnter={() => setHover(r.year)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="w-9 pb-0.5 text-[11px] font-semibold tabular-nums text-[var(--text-muted)]">{r.year}</span>
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 min-w-0 flex-1 overflow-visible">
                  <path d={`${path}L${100 - 50 / BINS} 30L${50 / BINS} 30Z`} fill="var(--season-rise)" opacity={0.55} />
                  <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                  <line x1={xp(r.layer.q25)} x2={xp(r.layer.q75)} y1={29} y2={29} stroke="var(--accent-strong)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <line x1={xp(r.layer.q50)} x2={xp(r.layer.q50)} y1={22} y2={30} stroke="var(--accent-strong)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                </svg>
              </div>
            );
          })}
        </div>
        <div className="ml-12 flex justify-between pt-1 text-[10px] tabular-nums text-[var(--text-faint)]">
          <span>{fmt(lo)}</span>
          <span>{units}</span>
          <span>{fmt(hi)}</span>
        </div>
      </div>

      {/* Year over year: median with IQR on one shared scale */}
      <div className="flex min-h-0 flex-col">
        <div className="text-[11px] text-[var(--text-muted)]">Median, 25–75%</div>
        <YearOverYear rows={rows} lo={lo} hi={hi} fmt={fmt} hover={hover} />
      </div>
    </div>
  );
}

function YearOverYear({ rows, lo, hi, fmt, hover }: { rows: YearSummary[]; lo: number; hi: number; fmt: (v: number) => string; hover: number | null }) {
  const W = 220;
  const H = 130;
  const p = { l: 30, r: 8, t: 10, b: 20 };
  const x = (i: number) => p.l + (rows.length === 1 ? 0.5 : i / (rows.length - 1)) * (W - p.l - p.r);
  const y = (v: number) => p.t + (1 - (v - lo) / (hi - lo)) * (H - p.t - p.b);
  const pts = rows.map((r, i) => (r.layer ? { i, r } : null)).filter(Boolean) as Array<{ i: number; r: YearSummary }>;
  const line = pts.map(({ i, r }, k) => `${k ? 'L' : 'M'}${x(i)} ${y(r.layer!.q50)}`).join('');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="mt-1" role="img" aria-label="Median by year">
      {[lo + (hi - lo) * 0.2, (lo + hi) / 2, hi - (hi - lo) * 0.2].map((t) => (
        <g key={t}>
          <line x1={p.l} x2={W - p.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={p.l - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--text-faint)" className="tabular-nums">{fmt(t)}</text>
        </g>
      ))}
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.4} strokeDasharray="3 3" />
      {pts.map(({ i, r }) => (
        <g key={r.year} opacity={hover !== null && hover !== r.year ? 0.35 : 1}>
          <line x1={x(i)} x2={x(i)} y1={y(r.layer!.q25)} y2={y(r.layer!.q75)} stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" opacity={0.35} />
          <circle cx={x(i)} cy={y(r.layer!.q50)} r={4} fill="var(--bg-elevated)" stroke="var(--accent-strong)" strokeWidth={2}>
            <title>{`${r.year}: median ${fmt(r.layer!.q50)}, IQR ${fmt(r.layer!.q25)}–${fmt(r.layer!.q75)}, ${r.layer!.n} cells`}</title>
          </circle>
        </g>
      ))}
      {rows.map((r, i) => (
        <text key={r.year} x={x(i)} y={H - 5} textAnchor="middle" fontSize={9.5} fill={r.layer ? 'var(--text-muted)' : 'var(--text-faint)'} className="tabular-nums">
          {r.layer ? r.year : `${r.year} –`}
        </text>
      ))}
    </svg>
  );
}
