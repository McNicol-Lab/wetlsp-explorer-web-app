/** Pieces shared by the Phenology Classes sections. */
import clsx from 'clsx';
import type { ColorScale, RGBA } from '@/lib/colorscales';
import { CODE } from '@/lib/phenoclass/constants';
import type { RunManifest } from '@/lib/phenoclass/model';
import { classColor, hexRgb, STATUS_COLORS } from '@/lib/phenoclass/palette';
import { readRunFile } from '@/lib/phenoclass/storage';
import type { RunArrays } from '@/lib/phenoclass/exports';
import type { RasterSlice } from '@/lib/types';
import { formatCount } from '@/lib/format';
import { useAsyncData } from '../shared';

/** Full-resolution arrays of a saved run, read from OPFS when a view needs them. */
export function useRunArrays(run: RunManifest | null) {
  return useAsyncData<RunArrays>(
    async () => {
      if (!run) throw new Error('No analysis selected.');
      const labels: Record<string, Uint8Array> = {};
      for (const a of run.annual) labels[String(a.year)] = new Uint8Array(await readRunFile(run.siteId, run.runId, a.labelsFile));
      let consensus: RunArrays['consensus'] = null;
      if (run.consensus) {
        const f = run.consensus.files;
        consensus = {
          cls: new Uint8Array(await readRunFile(run.siteId, run.runId, f.cls)),
          validYears: new Uint8Array(await readRunFile(run.siteId, run.runId, f.validYears)),
          agreement: new Float32Array(await readRunFile(run.siteId, run.runId, f.agreement)),
        };
      }
      const n = run.grid.width * run.grid.height;
      for (const [y, l] of Object.entries(labels)) {
        if (l.length !== n) throw new Error(`The saved ${y} map is damaged. Delete this run and train again.`);
      }
      return { labels, consensus };
    },
    [run?.siteId, run?.runId],
    { enabled: Boolean(run) },
  );
}

const TRANSPARENT: RGBA = [0, 0, 0, 0];
const rgba = (hex: string): RGBA => [...hexRgb(hex), 255];

/** Categorical scale for class codes; hidden classes are drawn transparent. */
export function classScale(k: number, hidden: ReadonlySet<number>, dark: boolean): ColorScale {
  const table: RGBA[] = Array.from({ length: 256 }, () => TRANSPARENT);
  table[CODE.NODATA] = rgba(dark ? STATUS_COLORS.nodataDark : STATUS_COLORS.nodataLight);
  for (let c = 1; c <= k; c++) table[c] = hidden.has(c) ? TRANSPARENT : rgba(classColor(c, dark));
  table[CODE.AMBIGUOUS] = rgba(STATUS_COLORS.ambiguous);
  table[CODE.INSUFFICIENT] = rgba(STATUS_COLORS.insufficient);
  const color = (v: number): RGBA => (Number.isFinite(v) && v >= 0 && v <= 255 ? table[v | 0] : TRANSPARENT);
  return {
    family: 'qa',
    stops: Array.from({ length: k }, (_, i) => classColor(i + 1, dark)),
    discrete: true,
    domain: [0, k],
    color,
    hex: (v) => {
      const [r, g, b] = color(v);
      return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    },
    ticks: () => Array.from({ length: k }, (_, i) => i + 1),
  };
}

/** Sequential single-hue ramp (light → dark blue), validated steps from the dataviz reference. */
export const BLUE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

export function sequentialScale(domain: [number, number], dark: boolean, discreteSteps?: number): ColorScale {
  const stops = dark ? [...BLUE_RAMP].reverse() : BLUE_RAMP;
  const [lo, hi] = domain;
  const pick = (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = hexRgb(stops[i]);
    const b = hexRgb(stops[Math.min(stops.length - 1, i + 1)]);
    return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f)) as [number, number, number];
  };
  const color = (v: number): RGBA => {
    if (!Number.isFinite(v)) return TRANSPARENT;
    let t = hi === lo ? 1 : (v - lo) / (hi - lo);
    if (discreteSteps) t = Math.round(t * (discreteSteps - 1)) / Math.max(1, discreteSteps - 1);
    return [...pick(t), 255];
  };
  return {
    family: 'count',
    stops,
    discrete: Boolean(discreteSteps),
    domain,
    color,
    hex: (v) => `#${color(v).slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('')}`,
    ticks: (count = 5) => Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / Math.max(1, count - 1)),
  };
}

const DISPLAY_CELLS = 4_000_000;

/**
 * A display slice for `RasterFigure`. Full resolution unless the grid exceeds
 * 4 M cells, then modal (codes) or mean (fractions) pooled for display only;
 * statistics never come from this.
 */
export function displaySlice(
  layer: string,
  values: Uint8Array | Float32Array,
  run: RunManifest,
  opts: { codes: boolean; nodataAsNaN?: number },
): RasterSlice {
  const { width, height, geoTransform: g } = run.grid;
  const n = width * height;
  const factor = n <= DISPLAY_CELLS ? 1 : Math.ceil(Math.sqrt(n / DISPLAY_CELLS));
  const ow = Math.ceil(width / factor);
  const oh = Math.ceil(height / factor);
  const out = new Float32Array(ow * oh);
  let finite = 0;
  let min = Infinity;
  let max = -Infinity;
  const counts = new Map<number, number>();
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let v: number;
      if (factor === 1) v = values[oy * width + ox];
      else if (opts.codes) {
        counts.clear();
        let best = Number.NaN;
        let bestN = 0;
        for (let y = oy * factor; y < Math.min(height, (oy + 1) * factor); y++) {
          for (let x = ox * factor; x < Math.min(width, (ox + 1) * factor); x++) {
            const c = values[y * width + x];
            const m = (counts.get(c) ?? 0) + 1;
            counts.set(c, m);
            if (m > bestN) {
              bestN = m;
              best = c;
            }
          }
        }
        v = best;
      } else {
        let s = 0;
        let m = 0;
        for (let y = oy * factor; y < Math.min(height, (oy + 1) * factor); y++) {
          for (let x = ox * factor; x < Math.min(width, (ox + 1) * factor); x++) {
            const c = values[y * width + x];
            if (Number.isFinite(c) && c !== opts.nodataAsNaN) {
              s += c;
              m++;
            }
          }
        }
        v = m ? s / m : Number.NaN;
      }
      if (opts.nodataAsNaN !== undefined && v === opts.nodataAsNaN) v = Number.NaN;
      out[oy * ow + ox] = v;
      if (Number.isFinite(v)) {
        finite++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  const rotated = g[2] !== 0 || g[4] !== 0;
  return {
    layer,
    width: ow,
    height: oh,
    values: out,
    min: finite ? min : 0,
    max: finite ? max : 0,
    finiteCount: finite,
    bboxProjected: rotated ? null : [g[0], g[3] + height * g[5], g[0] + width * g[1], g[3]],
    bboxWgs84: null,
    downsample: factor,
  };
}

export interface LegendItem {
  key: string;
  color: string;
  label: string;
  hint?: string;
  classId?: number;
}

export function legendItems(run: RunManifest, dark: boolean, opts: { consensus?: boolean } = {}): LegendItem[] {
  const k = run.model.kmeans.k;
  const items: LegendItem[] = Array.from({ length: k }, (_, i) => ({ key: `c${i + 1}`, color: classColor(i + 1, dark), label: `Class ${i + 1}`, classId: i + 1 }));
  if (opts.consensus) {
    items.push({ key: 'amb', color: STATUS_COLORS.ambiguous, label: 'Tie' });
    items.push({ key: 'ins', color: STATUS_COLORS.insufficient, label: 'Too few years' });
  }
  items.push({ key: 'nd', color: dark ? STATUS_COLORS.nodataDark : STATUS_COLORS.nodataLight, label: 'No data' });
  return items;
}

export function Swatch({ color, hidden, className }: { color: string; hidden?: boolean; className?: string }) {
  return (
    <span
      className={clsx('inline-block h-3 w-3 shrink-0 rounded-[3px] border border-[var(--border)]', className)}
      style={{ background: hidden ? 'transparent' : color, borderStyle: hidden ? 'dashed' : 'solid' }}
    />
  );
}

export function formatArea(m2: number | null): string {
  if (m2 === null) return '—';
  if (m2 >= 1e6) return `${(m2 / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} km²`;
  return `${(m2 / 1e4).toLocaleString('en-US', { maximumFractionDigits: 2 })} ha`;
}

export function formatPct(v: number | null, digits = 1): string {
  return v === null ? '—' : `${v.toFixed(digits)} %`;
}

export function runTitle(run: RunManifest): string {
  return `${run.siteId} · k = ${run.model.kmeans.k} · ${run.years.join(', ')}`;
}

export function runSubtitle(run: RunManifest): string {
  const t = run.model.training;
  const fit = run.kind === 'applied'
    ? 'Saved model applied'
    : t?.sampled
      ? `Fit on ${formatCount(t.sampleSize)} of ${formatCount(t.eligibleRows)} pixel-years`
      : `Fit on all ${formatCount(t?.eligibleRows ?? 0)} pixel-years`;
  return `${fit} · ${run.model.modelId}`;
}

/**
 * Tile panels into one self-describing image with a categorical legend: a
 * class map pasted into a slide keeps its site, years, model and caveats.
 */
export function classFigureCard(
  canvases: HTMLCanvasElement[],
  opts: { title: string; subtitle: string; notes?: string[]; panelLabels: string[]; cols: number; background: string; legend: LegendItem[]; hidden?: ReadonlySet<number>; ramp?: { stops: string[]; lo: string; hi: string; label: string } },
): HTMLCanvasElement {
  const visible = canvases.filter((c) => c.width > 0 && c.height > 0);
  if (visible.length === 0) throw new Error('There is nothing on screen to export yet.');
  const cols = Math.max(1, Math.min(opts.cols, visible.length));
  const rows = Math.ceil(visible.length / cols);
  const w = Math.max(...visible.map((c) => c.width));
  const h = Math.max(...visible.map((c) => c.height));
  const u = Math.max(1, Math.round(Math.min(w * cols, 2400) / 900));
  const pad = 20 * u;
  const notes = opts.notes ?? [];
  const header = 64 * u;
  const footer = (opts.ramp ? 56 : 40 + Math.ceil(opts.legend.length / 6) * 20) * u + notes.length * 16 * u + 18 * u;
  const out = document.createElement('canvas');
  out.width = w * cols + pad * 2;
  out.height = header + h * rows + footer;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a 2D canvas to export with.');
  const lum = (hex: string) => {
    const [r, g, b] = hexRgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  const dark = lum(opts.background) < 128;
  const ink = dark ? '#e8ecf2' : '#14181f';
  const muted = dark ? '#98a3b3' : '#5b6270';
  const font = 'Inter, system-ui, sans-serif';
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = ink;
  ctx.font = `600 ${17 * u}px ${font}`;
  ctx.fillText(opts.title, pad, 14 * u);
  ctx.fillStyle = muted;
  ctx.font = `${12 * u}px ${font}`;
  ctx.fillText(opts.subtitle, pad, 38 * u);
  visible.forEach((c, i) => {
    const x = pad + (i % cols) * w;
    const y = header + Math.floor(i / cols) * h;
    ctx.drawImage(c, x, y, w, h);
    const label = opts.panelLabels[i];
    if (label) {
      ctx.font = `600 ${12 * u}px ${font}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = dark ? 'rgba(11,15,20,0.8)' : 'rgba(255,255,255,0.88)';
      ctx.fillRect(x + 76 * u, y + 34 * u, tw + 12 * u, 20 * u);
      ctx.fillStyle = ink;
      ctx.fillText(label, x + 82 * u, y + 38 * u);
    }
  });
  let y = header + h * rows + 12 * u;
  ctx.font = `${11.5 * u}px ${font}`;
  if (opts.ramp) {
    const barW = Math.min(360 * u, out.width - 2 * pad);
    const stops = opts.ramp.stops;
    for (let px = 0; px < barW; px++) {
      ctx.fillStyle = stops[Math.min(stops.length - 1, Math.floor((px / barW) * stops.length))];
      ctx.fillRect(pad + px, y, 1, 10 * u);
    }
    ctx.fillStyle = muted;
    ctx.fillText(opts.ramp.lo, pad, y + 14 * u);
    ctx.textAlign = 'right';
    ctx.fillText(opts.ramp.hi, pad + barW, y + 14 * u);
    ctx.textAlign = 'left';
    ctx.fillText(opts.ramp.label, pad + barW + 12 * u, y);
    y += 36 * u;
  } else {
    const colW = Math.floor((out.width - 2 * pad) / 6);
    opts.legend.forEach((item, i) => {
      const x = pad + (i % 6) * colW;
      const yy = y + Math.floor(i / 6) * 20 * u;
      const hidden = item.classId !== undefined && opts.hidden?.has(item.classId);
      ctx.fillStyle = hidden ? 'transparent' : item.color;
      ctx.fillRect(x, yy + 1 * u, 12 * u, 12 * u);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, yy + 1 * u + 0.5, 12 * u - 1, 12 * u - 1);
      ctx.fillStyle = hidden ? muted : ink;
      ctx.fillText(`${item.label}${hidden ? ' (hidden)' : ''}`, x + 18 * u, yy);
    });
    y += Math.ceil(opts.legend.length / 6) * 20 * u + 8 * u;
  }
  ctx.fillStyle = muted;
  ctx.font = `${10.5 * u}px ${font}`;
  for (const n of notes) {
    ctx.fillText(n, pad, y);
    y += 16 * u;
  }
  ctx.textAlign = 'right';
  ctx.fillText(`WetLSP Explorer · ${new Date().toISOString().slice(0, 10)}`, out.width - pad, out.height - 16 * u);
  return out;
}

/** Strict file name segment. */
export const fileSlug = (...parts: Array<string | number>) => parts.join('_').replace(/[^\w.-]+/g, '-');
