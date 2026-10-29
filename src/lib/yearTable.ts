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
 *
 * The values are kept in blocks of whole pixel rows. Chrome cannot allocate
 * one typed array of 2 GiB or more, and a year of a 1.5-million-pixel site
 * (MY-MLM) is 2.2 GB.
 */
import { pixelIndex } from './pixelIndex';
import type { DailySummaryRow } from './types';

const DAY_MS = 86_400_000;

/** About 64 MB per block: far from the 2 GiB limit, and one block for a small site. */
const BLOCK_BYTES = 64 * 1024 ** 2;

export interface YearTable {
  year: number;
  series: string;
  /** 365 or 366. */
  days: number;
  /** Pixels with at least one value this year, ascending. */
  pixelIds: Int32Array;
  /**
   * Row-major `pixelIds.length × days`, `blockRows` pixels per block (the last
   * one shorter); NaN where there is no value. Read rows with `rowValues`.
   */
  blocks: Float32Array[];
  blockRows: number;
}

export function blockRowsFor(days: number): number {
  return Math.max(1, Math.floor(BLOCK_BYTES / (days * 4)));
}

/** One pixel's values for the year (a view, not a copy). */
export function rowValues(t: YearTable, row: number): Float32Array {
  const b = Math.floor(row / t.blockRows);
  const at = (row - b * t.blockRows) * t.days;
  return t.blocks[b].subarray(at, at + t.days);
}

/** Bytes a table holds in memory. */
export function yearTableBytes(t: YearTable): number {
  return t.pixelIds.byteLength + t.blocks.reduce((n, b) => n + b.byteLength, 0);
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
 * ignored. Memory grows a block at a time, so nothing is ever copied to grow.
 */
export class YearTableBuilder {
  readonly days: number;
  readonly blockRows: number;
  private rowOf = new Map<number, number>();
  private ids: number[] = [];
  private blocks: Float32Array[] = [];
  /** Rows the last block has room for; it doubles up to `blockRows`. */
  private lastCapacity = 0;
  private lastId = NaN;
  private lastBlock: Float32Array | null = null;
  private lastAt = 0;

  constructor(
    readonly year: number,
    readonly series: string,
    private readonly firstRows = 1024,
    blockRows?: number,
  ) {
    this.days = daysInYear(year);
    this.blockRows = blockRows ?? blockRowsFor(this.days);
  }

  add(id: number, day: number, value: number): void {
    if (!(day >= 0 && day < this.days) || !Number.isFinite(value)) return;
    if (id !== this.lastId) {
      let row = this.rowOf.get(id);
      if (row === undefined) {
        row = this.ids.length;
        this.ids.push(id);
        this.rowOf.set(id, row);
        this.ensureRow(row);
      }
      const b = Math.floor(row / this.blockRows);
      this.lastBlock = this.blocks[b];
      this.lastAt = (row - b * this.blockRows) * this.days;
      this.lastId = id;
    }
    this.lastBlock![this.lastAt + day] = value;
  }

  private ensureRow(row: number): void {
    const b = Math.floor(row / this.blockRows);
    const inBlock = row - b * this.blockRows;
    if (b === this.blocks.length) {
      this.lastCapacity = Math.min(this.blockRows, Math.max(1, this.firstRows));
      this.blocks.push(new Float32Array(this.lastCapacity * this.days).fill(NaN));
    } else if (inBlock >= this.lastCapacity) {
      this.lastCapacity = Math.min(this.blockRows, this.lastCapacity * 2);
      const grown = new Float32Array(this.lastCapacity * this.days).fill(NaN);
      grown.set(this.blocks[b]);
      this.blocks[b] = grown;
    }
  }

  finish(): YearTable {
    const n = this.ids.length;
    const { days, blockRows } = this;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.ids[a] - this.ids[b]);
    const pixelIds = Int32Array.from(order, (i) => this.ids[i]);
    const sizeOf = (b: number) => Math.min(blockRows, n - b * blockRows) * days;
    let blocks: Float32Array[];
    if (order.every((r, i) => r === i)) {
      // The usual case (files sorted by pixel): keep the blocks, trim the last.
      blocks = this.blocks.map((blk, b) => (blk.length === sizeOf(b) ? blk : blk.slice(0, sizeOf(b))));
    } else {
      blocks = this.blocks.map((_, b) => new Float32Array(sizeOf(b)));
      const from = { year: this.year, series: this.series, days, pixelIds, blocks: this.blocks, blockRows };
      order.forEach((src, dst) => {
        const b = Math.floor(dst / blockRows);
        blocks[b].set(rowValues(from, src), (dst - b * blockRows) * days);
      });
    }
    this.blocks = [];
    return { year: this.year, series: this.series, days, pixelIds, blocks, blockRows };
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
        const values = rowValues(t, row);
        const start = Date.UTC(t.year, 0, 1);
        for (let d = win[0]; d <= win[1]; d++) {
          const v = values[d];
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
    const rows = group.map((t) =>
      Array.from(pixelIds, (id) => pixelIndex(t.pixelIds, id))
        .filter((r) => r >= 0)
        .map((r) => rowValues(t, r)),
    );
    const days = group[0].days;
    const win = dayWindow(year, days, dateRange);
    if (!win) continue;
    for (let d = win[0]; d <= win[1]; d++) {
      const date = new Date(Date.UTC(year, 0, 1) + d * DAY_MS).toISOString().slice(0, 10);
      group.forEach((t, gi) => {
        let n = 0;
        let sum = 0;
        for (const values of rows[gi]) {
          const v = values[d];
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
      const values = rowValues(t, r);
      for (let d = 0; d < t.days; d++) {
        const v = values[d];
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
  // The blocks are back to back, so the file is the same as one values array.
  return new Blob([Uint32Array.of(bytes.length + pad), bytes, new Uint8Array(pad).fill(32), t.pixelIds, ...t.blocks] as BlobPart[]);
}

/**
 * The table stored in `blob`, or null when it is corrupt or built from
 * another source. Read a block at a time: Chrome refuses to read a file of
 * 2 GiB or more into memory in one piece.
 */
export async function unpackYearTable(blob: Blob, source: string, blockRows?: number): Promise<YearTable | null> {
  try {
    const len = new Uint32Array(await blob.slice(0, 4).arrayBuffer())[0];
    const h = JSON.parse(await blob.slice(4, 4 + len).text()) as Header;
    if (h.v !== 1 || h.source !== source) return null;
    const off = 4 + len;
    if (blob.size !== off + h.n * 4 + h.n * h.days * 4) return null;
    const pixelIds = new Int32Array(await blob.slice(off, off + h.n * 4).arrayBuffer());
    const rows = blockRows ?? blockRowsFor(h.days);
    const blocks: Float32Array[] = [];
    for (let r = 0; r < h.n; r += rows) {
      const at = off + h.n * 4 + r * h.days * 4;
      const size = Math.min(rows, h.n - r) * h.days * 4;
      blocks.push(new Float32Array(await blob.slice(at, at + size).arrayBuffer()));
    }
    return { year: h.year, series: h.series, days: h.days, pixelIds, blocks, blockRows: rows };
  } catch {
    return null;
  }
}
