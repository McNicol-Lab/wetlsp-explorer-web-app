/**
 * Planning the split of a large `pixels_timeseries` file into parts the
 * browser can load whole (engine/splitTimeseries.ts does the writing).
 *
 * Why: Chrome cannot read a file of 2 GiB or more into memory in one piece
 * (`NotReadableError`), and the year scan must load each part into DuckDB's
 * 4 GB WebAssembly memory to run at a usable speed: range reads of a file
 * were about 10 times slower on AU-Arc. The published files are sorted by
 * pixel, so parts are pixel ranges: each part is then read from its own row
 * groups, and one pass over the file writes all of them.
 *
 * Parts are written side by side by several DuckDB engines, so they are also
 * balanced by rows: writing costs about the same per row however well the
 * values compress. BR-Npw's sparse low pixel ids compress to almost nothing,
 * and a part sized by bytes alone held 2.6 times the rows of the others and
 * took 2.6 times as long, while the other engines sat idle.
 */

/** Files above this are split. Every published site under ~2 GB stays as it is. */
export const SPLIT_ABOVE_BYTES = 768 * 1024 ** 2;
/** Size aimed for per part: small enough to load next to everything else DuckDB holds. */
export const TARGET_PART_BYTES = 384 * 1024 ** 2;

export interface RowGroupStat {
  /** Smallest and largest `pixel_id` in the row group; null without statistics. */
  min: number | null;
  max: number | null;
  /** Bytes the row group is expected to take in the new file. */
  bytes: number;
  /** Rows in the row group; without them parts are balanced by bytes alone. */
  rows?: number;
}

/**
 * Inclusive upper bounds of the pixel ranges, ascending: n bounds make n + 1
 * parts. Row groups are taken in pixel order and a part is closed once it
 * reaches the byte target, or holds the rows an average part of that size
 * would. Null when the file has no usable statistics.
 */
export function planPixelCuts(groups: RowGroupStat[], target = TARGET_PART_BYTES): number[] | null {
  if (groups.length === 0 || groups.some((g) => g.min === null || g.max === null)) return null;
  const sorted = [...groups].sort((a, b) => a.min! - b.min! || a.max! - b.max!);
  const totalBytes = sorted.reduce((n, g) => n + g.bytes, 0);
  const totalRows = sorted.reduce((n, g) => n + (g.rows ?? 0), 0);
  const targetRows = totalRows > 0 && totalBytes > 0 ? (totalRows * target) / totalBytes : 0;
  // How full a part is, 1 = full: by bytes, or by rows when they say more.
  const weight = (bytes: number, rows: number) => Math.max(bytes / target, targetRows > 0 ? rows / targetRows : 0);
  const cuts: number[] = [];
  let bytes = 0;
  let rows = 0;
  let leftBytes = totalBytes;
  let leftRows = totalRows;
  for (const g of sorted) {
    bytes += g.bytes;
    rows += g.rows ?? 0;
    leftBytes -= g.bytes;
    leftRows -= g.rows ?? 0;
    // Do not leave a sliver of a last part behind.
    if (weight(bytes, rows) >= 1 && weight(leftBytes, leftRows) >= 1 / 4 && (cuts.length === 0 || g.max! > cuts[cuts.length - 1])) {
      cuts.push(g.max!);
      bytes = 0;
      rows = 0;
    }
  }
  return cuts;
}

export interface PartEstimate {
  /** Rows expected in the part: what writing it costs. */
  rows: number;
  /** Bytes the part is expected to take, as planned (an upper bound in practice). */
  bytes: number;
}

/**
 * Rows and bytes each part of `cuts` should get, for ordering the work and
 * measuring progress. A row group goes to the part its middle pixel falls in,
 * so a row group across a bound is counted once, roughly.
 */
export function estimateParts(groups: RowGroupStat[], cuts: number[]): PartEstimate[] {
  const out = Array.from({ length: cuts.length + 1 }, () => ({ rows: 0, bytes: 0 }));
  for (const g of groups) {
    const mid = g.min === null || g.max === null ? null : (g.min + g.max) / 2;
    let i = 0;
    if (mid !== null) while (i < cuts.length && mid > cuts[i]) i++;
    out[i].rows += g.rows ?? 0;
    out[i].bytes += g.bytes;
  }
  return out;
}

/**
 * How many DuckDB engines split one file side by side. Each is a WebAssembly
 * worker on a core of its own, holding about 400 MB while it writes (see
 * engineMemoryMB). Measured in Chrome on a 10-core Mac: 2 engines took 55%
 * of the time of one, 4 took 34%, 6 no less than 4. Half the cores, so the
 * app and the system stay responsive; at most 2 with under 8 GB of memory.
 */
export function splitEngines(parts: number, cores?: number, memoryGB?: number): number {
  let n = Math.floor((cores || 2) / 2);
  if (memoryGB && memoryGB < 8) n = Math.min(n, memoryGB <= 2 ? 1 : 2);
  return Math.max(1, Math.min(n, 4, parts));
}

/**
 * DuckDB's memory limit for one splitting engine, in MB. Reads through the
 * File reader go through DuckDB's file cache, which otherwise grows to the
 * default limit, and a WebAssembly memory never shrinks: four engines held
 * 5.1 GB in Chrome on the 2.5 GB part of BR-Npw. At 128 MB they held 3.3 GB
 * and took no longer. Room for many of the file's largest row groups
 * (1.5 MB in every published file), so a file of huge ones still fits.
 */
export function engineMemoryMB(largestGroup: number): number {
  return Math.min(2048, Math.max(128, Math.ceil((largestGroup * 32) / 1024 ** 2)));
}

/** Equal-width bounds over [min, max], for files without row-group statistics. */
export function equalCuts(min: number, max: number, parts: number): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < parts; i++) {
    const c = Math.floor(min + ((max - min + 1) * i) / parts) - 1;
    if (c >= min && c < max && (cuts.length === 0 || c > cuts[cuts.length - 1])) cuts.push(c);
  }
  return cuts;
}

/**
 * SQL condition for part `i` of the ranges `cuts` describe. Together they
 * cover every row once. `nulls` is false when the file's statistics show no
 * row without a pixel id: an `OR pixel_id IS NULL` stops DuckDB skipping the
 * row groups outside the first range by their statistics.
 */
export function rangeWhere(cuts: number[], i: number, nulls = true): string {
  const parts: string[] = [];
  if (i > 0) parts.push(`pixel_id > ${cuts[i - 1]}`);
  if (i < cuts.length) parts.push(`pixel_id <= ${cuts[i]}`);
  if (parts.length === 0) return 'TRUE';
  // Rows without a pixel id would match no range; keep them in the first part.
  return i === 0 && nulls ? `(${parts.join(' AND ')} OR pixel_id IS NULL)` : parts.join(' AND ');
}

/**
 * Files a split left behind that the site no longer uses: parts of an earlier
 * import (re-importing writes the original again and splits it anew) and
 * DuckDB's `tmp_` files from a write that failed. `stored` and `keep` are
 * paths relative to the site's folder; anything else is never touched.
 */
export function staleSplitFiles(stored: string[], keep: Iterable<string>): string[] {
  const used = new Set(keep);
  return stored.filter((path) => {
    if (used.has(path)) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return /\.part-\d+-of-\d+\.parquet$/i.test(name) || /^tmp_.*\.parquet$/i.test(name);
  });
}

/**
 * The name of part `i` of `n`. `tag` sets one split's parts apart from those of
 * the split before it, which the site may still be using: a re-import that is
 * cancelled or fails then leaves the site's own parts alone.
 * `dir/AU_Arc_pixels_timeseries.parquet`, 0, 4, `m1x2` -> `dir/AU_Arc_pixels_timeseries.m1x2.part-1-of-4.parquet`.
 */
export function partPath(original: string, i: number, n: number, tag?: string): string {
  const stem = original.replace(/\.parquet$/i, '');
  const w = String(n).length;
  return `${stem}${tag ? `.${tag}` : ''}.part-${String(i + 1).padStart(w, '0')}-of-${n}.parquet`;
}
