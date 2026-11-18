/**
 * Year-to-year class transitions. Both years are classified by the same model
 * on the same grid, so each cell can be followed from one year to the next.
 * Ribbon widths are cell counts; "not classified" stays its own band rather
 * than being folded into a class.
 */
import { useMemo, useRef, useState } from 'react';
import { FigureMenu } from '@/components/FigureMenu';
import { copyImage, elementToBlob } from '@/lib/figure';
import { downloadBlob, exportBackground, timestampedName } from '@/lib/export';
import clsx from 'clsx';
import type { RunManifest } from '@/lib/phenoclass/model';
import { classColor } from '@/lib/phenoclass/palette';
import { formatCount } from '@/lib/format';
import { ErrorPanel, LoadingPanel, useDark } from '../shared';
import { useRunArrays } from './shared';
import { useSize } from '@/components/viz/useSize';

const UNCLASSIFIED = '#b9c0bd';

export function TransitionsSection({ run }: { run: RunManifest }) {
  const dark = useDark();
  const arrays = useRunArrays(run);
  const years = run.years;
  const [from, setFrom] = useState(years[0]);
  const [to, setTo] = useState(years[1] ?? years[0]);
  const [focus, setFocus] = useState<number | null>(null);
  const k = run.model.kmeans.k;
  const figRef = useRef<HTMLDivElement>(null);
  const png = () => (figRef.current ? elementToBlob(figRef.current, exportBackground()) : Promise.reject(new Error('Not ready')));

  const matrix = useMemo(() => {
    const a = arrays.data?.labels[String(from)];
    const b = arrays.data?.labels[String(to)];
    if (!a || !b || a.length !== b.length) return null;
    const m = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0) as number[]);
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x === 0 && y === 0) continue; // outside the footprint in both years
      if (x <= k && y <= k) m[x][y]++;
    }
    return m;
  }, [arrays.data, from, to, k]);

  if (arrays.error) return <ErrorPanel message={arrays.error} onRetry={arrays.reload} />;
  if (!arrays.data || !matrix) return <LoadingPanel progress={arrays.progress} label="Reading class maps" />;
  if (years.length < 2) return <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">Transitions need a run with at least two years.</div>;

  const color = (c: number) => (c === 0 ? UNCLASSIFIED : classColor(c, dark));
  const name = (c: number) => (c === 0 ? 'Not classified' : `Class ${c}`);
  const rowSum = matrix.map((r) => r.reduce((s, v) => s + v, 0));
  const colSum = matrix[0].map((_, j) => matrix.reduce((s, r) => s + r[j], 0));
  let both = 0;
  let same = 0;
  for (let i = 1; i <= k; i++) for (let j = 1; j <= k; j++) {
    both += matrix[i][j];
    if (i === j) same += matrix[i][j];
  }

  return (
    <div ref={figRef} className="flex h-full min-h-0 flex-col gap-3 bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <YearPick label="From" value={from} years={years} onChange={setFrom} />
        <span className="text-[var(--text-faint)]">→</span>
        <YearPick label="To" value={to} years={years} onChange={setTo} />
        {both > 0 && (
          <span className="ml-auto text-[var(--text-muted)]" title="Cells classified in both years whose class did not change">
            <b className="text-[15px] font-semibold tabular-nums text-[var(--text)]">{((same / both) * 100).toFixed(1)}%</b> kept their class
            <span className="text-[var(--text-faint)]"> · {formatCount(both)} cells classified in both</span>
          </span>
        )}
        <div className={both > 0 ? '' : 'ml-auto'}>
          <FigureMenu
            actions={{
              save: async () => downloadBlob(await png(), timestampedName([run.siteId, 'class-transitions', `${from}-${to}`], 'png')),
              copy: () => copyImage(png()),
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Classes">
        {Array.from({ length: k }, (_, idx) => idx + 1).map((c) => {
          const share = rowSum[c] && both ? matrix[c][c] / rowSum[c] : 0;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setFocus(focus === c ? null : c)}
              aria-pressed={focus === c}
              className={clsx(
                'flex min-w-[112px] flex-col gap-1 rounded-[10px] border px-2.5 py-2 text-left transition-colors duration-150',
                focus === c ? 'border-[var(--accent)] bg-[var(--pale)]' : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]',
              )}
              title={`${name(c)} in ${from}: ${formatCount(rowSum[c])} cells; ${(share * 100).toFixed(1)}% stay in it in ${to}`}
            >
              <span className="flex items-center gap-1.5 text-[12px] font-medium">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color(c) }} />
                {name(c)}
              </span>
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{formatCount(rowSum[c])} cells</span>
              <span className="h-1 w-full overflow-hidden rounded-full bg-[var(--season-off)]" aria-hidden>
                <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: color(c) }} />
              </span>
              <span className="text-[10.5px] tabular-nums text-[var(--text-faint)]">{(share * 100).toFixed(0)}% stay</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 rounded-[14px] border border-[var(--border)] bg-[var(--bg-elevated)]">
        <Flow matrix={matrix} rowSum={rowSum} colSum={colSum} color={color} name={name} from={from} to={to} focus={focus} />
      </div>
    </div>
  );
}

function YearPick({ label, value, years, onChange }: { label: string; value: number; years: number[]; onChange: (y: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 font-medium tabular-nums text-[var(--text)]"
      >
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </label>
  );
}

function Flow({
  matrix, rowSum, colSum, color, name, from, to, focus,
}: {
  matrix: number[][];
  rowSum: number[];
  colSum: number[];
  color: (c: number) => string;
  name: (c: number) => string;
  from: number;
  to: number;
  focus: number | null;
}) {
  const [box, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const W = Math.max(320, size.width);
  const H = Math.max(240, size.height);
  const pad = { t: 30, b: 16, l: 120, r: 120 };
  const barW = 14;
  const gap = 6;
  const total = rowSum.reduce((s, v) => s + v, 0);
  const order = [...Array.from({ length: matrix.length - 1 }, (_, i) => i + 1), 0];
  const nodesL = order.filter((c) => rowSum[c] > 0);
  const nodesR = order.filter((c) => colSum[c] > 0);
  const scaleH = (H - pad.t - pad.b - gap * (Math.max(nodesL.length, nodesR.length) - 1)) / (total || 1);

  const place = (nodes: number[], sums: number[]) => {
    const pos: Record<number, { y: number; h: number }> = {};
    let y = pad.t;
    for (const c of nodes) {
      const h = sums[c] * scaleH;
      pos[c] = { y, h };
      y += h + gap;
    }
    return pos;
  };
  const L = place(nodesL, rowSum);
  const R = place(nodesR, colSum);
  const xL = pad.l;
  const xR = W - pad.r - barW;

  const outY: Record<number, number> = Object.fromEntries(nodesL.map((c) => [c, L[c].y]));
  const inY: Record<number, number> = Object.fromEntries(nodesR.map((c) => [c, R[c].y]));
  const ribbons: Array<{ key: string; d: string; c: number; t: number; v: number }> = [];
  for (const i of nodesL) for (const j of nodesR) {
    const v = matrix[i][j];
    if (!v) continue;
    const h = v * scaleH;
    const y0 = outY[i];
    const y1 = inY[j];
    outY[i] += h;
    inY[j] += h;
    const x0 = xL + barW;
    const x1 = xR;
    const mx = (x0 + x1) / 2;
    ribbons.push({
      key: `${i}-${j}`,
      c: i,
      t: j,
      v,
      d: `M${x0} ${y0}C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}L${x1} ${y1 + h}C${mx} ${y1 + h} ${mx} ${y0 + h} ${x0} ${y0 + h}Z`,
    });
  }
  const hovered = ribbons.find((r) => r.key === hover) ?? null;

  return (
    <div ref={box} className="relative h-full w-full">
      {size.width > 0 && (
        <svg width={W} height={H} role="img" aria-label={`Class transitions from ${from} to ${to}`}>
          <text x={xL + barW / 2} y={16} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--text)">{from}</text>
          <text x={xR + barW / 2} y={16} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--text)">{to}</text>
          {ribbons.map((r) => {
            const dim = (focus !== null && r.c !== focus) || (hover !== null && hover !== r.key);
            return (
              <path
                key={r.key}
                d={r.d}
                fill={color(r.c)}
                opacity={dim ? 0.08 : r.c === r.t ? 0.55 : 0.38}
                onMouseEnter={() => setHover(r.key)}
                onMouseLeave={() => setHover(null)}
                className="transition-opacity duration-150"
              />
            );
          })}
          {nodesL.map((c) => (
            <g key={`l${c}`}>
              <rect x={xL} y={L[c].y} width={barW} height={Math.max(1, L[c].h)} rx={3} fill={color(c)} />
              <text x={xL - 8} y={L[c].y + L[c].h / 2 + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">
                {name(c)} <tspan fill="var(--text-faint)" className="tabular-nums">{((rowSum[c] / total) * 100).toFixed(1)}%</tspan>
              </text>
            </g>
          ))}
          {nodesR.map((c) => (
            <g key={`r${c}`}>
              <rect x={xR} y={R[c].y} width={barW} height={Math.max(1, R[c].h)} rx={3} fill={color(c)} />
              <text x={xR + barW + 8} y={R[c].y + R[c].h / 2 + 4} fontSize={11} fill="var(--text-muted)">
                {name(c)} <tspan fill="var(--text-faint)" className="tabular-nums">{((colSum[c] / total) * 100).toFixed(1)}%</tspan>
              </text>
            </g>
          ))}
        </svg>
      )}
      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px] shadow-[var(--shadow-pop)]">
          <b className="font-medium">{name(hovered.c)} → {name(hovered.t)}</b>
          <span className="block tabular-nums text-[var(--text-muted)]">
            {formatCount(hovered.v)} cells · {((hovered.v / (rowSum[hovered.c] || 1)) * 100).toFixed(1)}% of {name(hovered.c)} in {from}
          </span>
        </div>
      )}
    </div>
  );
}
