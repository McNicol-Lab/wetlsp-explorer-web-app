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
}

/**
 * Inclusive upper bounds of the pixel ranges, ascending: n bounds make n + 1
 * parts. Row groups are taken in pixel order and a part is closed once it
 * reaches the target. Null when the file has no usable statistics.
 */
export function planPixelCuts(groups: RowGroupStat[], target = TARGET_PART_BYTES): number[] | null {
  if (groups.length === 0 || groups.some((g) => g.min === null || g.max === null)) return null;
  const sorted = [...groups].sort((a, b) => a.min! - b.min! || a.max! - b.max!);
  const total = sorted.reduce((n, g) => n + g.bytes, 0);
  const cuts: number[] = [];
  let inPart = 0;
  let left = total;
  for (const g of sorted) {
    inPart += g.bytes;
    left -= g.bytes;
    // Do not leave a sliver of a last part behind.
    if (inPart >= target && left >= target / 4 && (cuts.length === 0 || g.max! > cuts[cuts.length - 1])) {
      cuts.push(g.max!);
      inPart = 0;
    }
  }
  return cuts;
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

/** SQL condition for part `i` of the ranges `cuts` describe. Together they cover every row once. */
export function rangeWhere(cuts: number[], i: number): string {
  const parts: string[] = [];
  if (i > 0) parts.push(`pixel_id > ${cuts[i - 1]}`);
  if (i < cuts.length) parts.push(`pixel_id <= ${cuts[i]}`);
  if (parts.length === 0) return 'TRUE';
  // Rows without a pixel id would match no range; keep them in the first part.
  return i === 0 ? `(${parts.join(' AND ')} OR pixel_id IS NULL)` : parts.join(' AND ');
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

/** `dir/AU_Arc_pixels_timeseries.parquet`, 0, 4 -> `dir/AU_Arc_pixels_timeseries.part-1-of-4.parquet`. */
export function partPath(original: string, i: number, n: number): string {
  const stem = original.replace(/\.parquet$/i, '');
  const w = String(n).length;
  return `${stem}.part-${String(i + 1).padStart(w, '0')}-of-${n}.parquet`;
}
