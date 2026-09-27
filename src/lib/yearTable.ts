/**
 * One year of one EVI series as a dense pixel × day table.
 *
 * Decoding `pixels_timeseries` is the slow part of every chart: the file is
 * sorted by pixel, so any random sample touches every row group and DuckDB
 * decompresses the whole 25-million-row file. A year table is built from one
 * scan, kept in memory and in offline storage, and every chart after that
 * (samples, the mean and IQR band, compare-years, per-pixel means, a clicked
 * pixel's trace) is plain array work.
 *
 * Values are Float32: EVI is a 0–1 index and 7 significant digits is far
 * beyond its precision, and it halves the size (about 20 MB per year for a
 * 14,000-pixel site). The functions here reproduce the SQL they replace:
 * `avg`, `quantile_cont` and `ORDER BY series, pixel_id, date`.
 */
import { pixelIndex } from './pixelIndex';
import type { DailySummaryRow } from './types';

const DAY_MS = 86_400_000;

export interface YearTable {
  year: number;
  series: string;
  /** 365 or 366. */
  days: number;
  /** Pixels with at least one value this year, ascending. */
  pixelIds: Int32Array;
  /** Row-major `pixelIds.length × days`; NaN where there is no value. */
  values: Float32Array;
}

export interface TimeseriesBundle {
  seriesNames: string[];
  pixelId: Int32Array;
  seriesIdx: Uint8Array;
  /** Epoch milliseconds. */
  time: Float64Array;
  evi: Float64Array;
  rows: number;
  pixelsLoaded: number;
}

export function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}

/**
 * Fills one year's table as rows stream in, in any order, without holding
 * the rows themselves: each new pixel gets a row of NaN days, and `finish`
 * puts the rows in pixel order. Out-of-range days and non-finite values are
 * ignored.
 */
export class YearTableBuilder {
  readonly days: number;
  private rowOf = new Map<number, number>();
  private ids: number[] = [];
  private values: Float32Array;
  private lastId = NaN;
  private lastRow = -1;

  constructor(
    readonly year: number,
    readonly series: string,
    expectedPixels = 1024,
  ) {
    this.days = daysInYear(year);
    this.values = new Float32Array(Math.max(1, expectedPixels) * this.days).fill(NaN);
  }

  add(id: number, day: number, value: number): void {
    if (!(day >= 0 && day < this.days) || !Number.isFinite(value)) return;
    let row = this.lastRow;
    if (id !== this.lastId) {
      const known = this.rowOf.get(id);
      if (known === undefined) {
        row = this.ids.length;
        this.ids.push(id);
        this.rowOf.set(id, row);
        if ((row + 1) * this.days > this.values.length) {
          const grown = new Float32Array(this.values.length * 2).fill(NaN);
          grown.set(this.values);
          this.values = grown;
        }
      } else row = known;
      this.lastId = id;
      this.lastRow = row;
    }
    this.values[row * this.days + day] = value;
  }

  finish(): YearTable {
    const n = this.ids.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.ids[a] - this.ids[b]);
    const pixelIds = Int32Array.from(order, (i) => this.ids[i]);
    const inOrder = order.every((r, i) => r === i);
    const values = inOrder ? this.values.slice(0, n * this.days) : new Float32Array(n * this.days);
    if (!inOrder) {
      order.forEach((from, to) =>
        values.set(this.values.subarray(from * this.days, (from + 1) * this.days), to * this.days),
      );
    }
    return { year: this.year, series: this.series, days: this.days, pixelIds, values };
  }
}

/** A table from scanned rows: pixel id, day index (0 = 1 January) and value. */
export function buildYearTable(
  year: number,
  series: string,
  ids: ArrayLike<number>,
  day: ArrayLike<number>,
  evi: ArrayLike<number>,
): YearTable {
  const b = new YearTableBuilder(year, series);
  for (let i = 0; i < ids.length; i++) b.add(ids[i], day[i], evi[i]);
  return b.finish();
}

/** Inclusive ISO date range -> day indices within `year`, or null if disjoint. */
function dayWindow(year: number, days: number, range?: [string, string] | null): [number, number] | null {
  if (!range) return [0, days - 1];
  const start = Date.UTC(year, 0, 1);
  const from = Math.max(0, Math.round((Date.parse(`${range[0]}T00:00:00Z`) - start) / DAY_MS));
  const to = Math.min(days - 1, Math.round((Date.parse(`${range[1]}T00:00:00Z`) - start) / DAY_MS));
  return from <= to ? [from, to] : null;
}

const bySeries = (a: YearTable, b: YearTable) =>
  a.series < b.series ? -1 : a.series > b.series ? 1 : a.year - b.year;

/**
 * The rows `SELECT pixel_id, series, epoch_ms(date), evi … ORDER BY series,
 * pixel_id, date LIMIT rowLimit` would return for these pixels.
 */
export function extractBundle(
  tables: YearTable[],
  pixelIds: ArrayLike<number>,
  dateRange: [string, string] | null | undefined,
  rowLimit: number,
): TimeseriesBundle {
  const ordered = [...tables].sort(bySeries);
  const seriesOrder = [...new Set(ordered.map((t) => t.series))];
  const wanted = Int32Array.from(pixelIds).sort();
  const pixelId: number[] = [];
  const seriesIdx: number[] = [];
  const time: number[] = [];
  const evi: number[] = [];
  const seriesNames: string[] = [];
  const pixels = new Set<number>();

  outer: for (const name of seriesOrder) {
    const group = ordered.filter((t) => t.series === name);
    let idx = -1;
    for (const id of wanted) {
      for (const t of group) {
        const row = pixelIndex(t.pixelIds, id);
        const win = dayWindow(t.year, t.days, dateRange);
        if (row < 0 || !win) continue;
        const base = row * t.days;
        const start = Date.UTC(t.year, 0, 1);
        for (let d = win[0]; d <= win[1]; d++) {
          const v = t.values[base + d];
          if (Number.isNaN(v)) continue;
          if (pixelId.length >= rowLimit) break outer;
          if (idx < 0) {
            idx = seriesNames.length;
            seriesNames.push(name);
          }
          pixelId.push(id);
          seriesIdx.push(idx);
          time.push(start + d * DAY_MS);
          evi.push(v);
          pixels.add(id);
        }
      }
    }
  }
  return {
    seriesNames,
    pixelId: Int32Array.from(pixelId),
    seriesIdx: Uint8Array.from(seriesIdx),
    time: Float64Array.from(time),
    evi: Float64Array.from(evi),
    rows: pixelId.length,
    pixelsLoaded: pixels.size,
  };
}

/** DuckDB's `quantile_cont`: linear interpolation between order statistics. */
export function quantileCont(sorted: ArrayLike<number>, n: number, q: number): number {
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Daily mean, interquartile range and pixel count across the given pixels,
 * ordered by date then series, as the daily-summary SQL returns them.
 */
export function dailySummary(
  tables: YearTable[],
  pixelIds: ArrayLike<number>,
  dateRange?: [string, string] | null,
): DailySummaryRow[] {
  const out: DailySummaryRow[] = [];
  const scratch = new Float64Array(pixelIds.length);
  const ordered = [...tables].sort((a, b) => a.year - b.year || (a.series < b.series ? -1 : a.series > b.series ? 1 : 0));
  for (let ti = 0; ti < ordered.length;) {
    // All series of one year, walked day by day so rows come out date-major.
    const year = ordered[ti].year;
    const group: YearTable[] = [];
    while (ti < ordered.length && ordered[ti].year === year) group.push(ordered[ti++]);
    const rows = group.map((t) => Array.from(pixelIds, (id) => pixelIndex(t.pixelIds, id)).filter((r) => r >= 0));
    const days = group[0].days;
    const win = dayWindow(year, days, dateRange);
    if (!win) continue;
    for (let d = win[0]; d <= win[1]; d++) {
      const date = new Date(Date.UTC(year, 0, 1) + d * DAY_MS).toISOString().slice(0, 10);
      group.forEach((t, gi) => {
        let n = 0;
        let sum = 0;
        for (const r of rows[gi]) {
          const v = t.values[r * t.days + d];
          if (Number.isNaN(v)) continue;
          scratch[n++] = v;
          sum += v;
        }
        if (n === 0) return;
        const sorted = scratch.subarray(0, n).sort();
        out.push({
          date,
          series: t.series,
          mean: sum / n,
          q25: quantileCont(sorted, n, 0.25),
          q75: quantileCont(sorted, n, 0.75),
          n,
        });
      });
    }
  }
  return out;
}

/** Pixels with at least one value in any of the tables, ascending. */
export function distinctPixels(tables: YearTable[]): Int32Array {
  if (tables.length === 1) return tables[0].pixelIds;
  const all = new Set<number>();
  for (const t of tables) for (const id of t.pixelIds) all.add(id);
  return Int32Array.from(all).sort();
}

/** Mean value per pixel across every day of the tables (`avg(evi) GROUP BY pixel_id`). */
export function pixelMeans(tables: YearTable[]): Map<number, number> {
  const sum = new Map<number, number>();
  const count = new Map<number, number>();
  for (const t of tables) {
    for (let r = 0; r < t.pixelIds.length; r++) {
      let s = 0;
      let n = 0;
      for (let d = 0, i = r * t.days; d < t.days; d++, i++) {
        const v = t.values[i];
        if (Number.isNaN(v)) continue;
        s += v;
        n++;
      }
      if (n === 0) continue;
      const id = t.pixelIds[r];
      sum.set(id, (sum.get(id) ?? 0) + s);
      count.set(id, (count.get(id) ?? 0) + n);
    }
  }
  const out = new Map<number, number>();
  for (const [id, s] of sum) out.set(id, s / count.get(id)!);
  return out;
}

/* ------------------------------------------------------------ storage */

interface Header {
  v: 1;
  year: number;
  series: string;
  days: number;
  n: number;
  /** Identifies the source file; a mismatch means the table is stale. */
  source: string;
}

/** Length-prefixed JSON header, then the pixel ids and the values. */
export function packYearTable(t: YearTable, source: string): Blob {
  const header: Header = { v: 1, year: t.year, series: t.series, days: t.days, n: t.pixelIds.length, source };
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  // Pad the header so both arrays start on a 4-byte boundary.
  const pad = (4 - ((4 + bytes.length) % 4)) % 4;
  return new Blob([Uint32Array.of(bytes.length + pad), bytes, new Uint8Array(pad).fill(32), t.pixelIds, t.values] as BlobPart[]);
}

/** The table in `buf`, or null when it is corrupt or built from another source. */
export function unpackYearTable(buf: ArrayBuffer, source: string): YearTable | null {
  try {
    const len = new Uint32Array(buf, 0, 1)[0];
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as Header;
    if (h.v !== 1 || h.source !== source) return null;
    const off = 4 + len;
    if (buf.byteLength !== off + h.n * 4 + h.n * h.days * 4) return null;
    return {
      year: h.year,
      series: h.series,
      days: h.days,
      pixelIds: new Int32Array(buf, off, h.n),
      values: new Float32Array(buf, off + h.n * 4, h.n * h.days),
    };
  } catch {
    return null;
  }
}
