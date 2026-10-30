import { describe, expect, it } from 'vitest';
import {
  engineMemoryMB,
  equalCuts,
  estimateParts,
  partPath,
  planPixelCuts,
  rangeWhere,
  splitEngines,
  staleSplitFiles,
  type RowGroupStat,
} from './splitPlan';

/** Which part a pixel id lands in, by evaluating the same bounds as `rangeWhere`. */
function partOf(cuts: number[], id: number | null): number[] {
  return Array.from({ length: cuts.length + 1 }, (_, i) => i).filter((i) => {
    if (id === null) return i === 0;
    return (i === 0 || id > cuts[i - 1]) && (i === cuts.length || id <= cuts[i]);
  });
}

describe('split plan', () => {
  // Like the published files: sorted by pixel, neighbouring row groups overlapping a little.
  const groups: RowGroupStat[] = Array.from({ length: 40 }, (_, i) => ({
    min: i * 1000 - (i % 3 === 0 ? 0 : 50),
    max: i * 1000 + 999,
    bytes: 10,
  }));

  it('closes a part at each target, in pixel order, without a sliver at the end', () => {
    const cuts = planPixelCuts(groups, 100)!;
    expect(cuts).toEqual([9999, 19999, 29999]);
    // 37 groups at target 100: the last part would be 70, kept separate (>= 25).
    expect(planPixelCuts(groups.slice(0, 37), 100)).toEqual([9999, 19999, 29999]);
    // 31 groups: a 10-byte tail is folded into the third part.
    expect(planPixelCuts(groups.slice(0, 31), 100)).toEqual([9999, 19999]);
  });

  it('also closes a part on rows, where the values compress to almost nothing', () => {
    // Ten sparse row groups (1 byte, 100 rows each), then ten dense ones (10 bytes, 100 rows).
    const mixed: RowGroupStat[] = Array.from({ length: 20 }, (_, i) => ({
      min: i * 100,
      max: i * 100 + 99,
      bytes: i < 10 ? 1 : 10,
      rows: 100,
    }));
    // By bytes alone the sparse groups and half the dense ones would make one part.
    expect(planPixelCuts(mixed.map(({ rows: _, ...g }) => g), 50)).toEqual([1399]);
    // 110 bytes and 2,000 rows: a 50-byte part holds about 909 rows on average.
    const cuts = planPixelCuts(mixed, 50)!;
    expect(cuts).toEqual([999, 1499]);
    const parts = estimateParts(mixed, cuts);
    expect(parts.map((p) => p.rows)).toEqual([1000, 500, 500]);
    expect(parts.map((p) => p.bytes)).toEqual([10, 50, 50]);
    expect(Math.max(...parts.map((p) => p.rows))).toBeLessThan(2 * Math.min(...parts.map((p) => p.rows)) + 1);
  });

  it('counts every row group once when estimating parts', () => {
    const cuts = planPixelCuts(groups, 100)!;
    const parts = estimateParts(groups, cuts);
    expect(parts).toHaveLength(cuts.length + 1);
    expect(parts.reduce((n, p) => n + p.bytes, 0)).toBe(400);
    expect(estimateParts(groups, [])).toEqual([{ rows: 0, bytes: 400 }]);
  });

  it('ignores the order row groups are listed in', () => {
    expect(planPixelCuts([...groups].reverse(), 100)).toEqual(planPixelCuts(groups, 100));
  });

  it('needs statistics', () => {
    expect(planPixelCuts([{ min: null, max: 5, bytes: 1 }], 1)).toBeNull();
    expect(planPixelCuts([], 1)).toBeNull();
  });

  it('puts every pixel id, and a missing one, in exactly one part', () => {
    for (const cuts of [[], [10], [10, 20, 30], equalCuts(407214, 939102, 4)]) {
      for (const id of [null, -5, 0, 10, 11, 20, 29, 30, 31, 407214, 600000, 939102, 2 ** 31 - 1]) {
        expect(partOf(cuts, id)).toHaveLength(1);
      }
      // The SQL says the same as partOf.
      for (let i = 0; i <= cuts.length; i++) {
        const sql = rangeWhere(cuts, i);
        if (i === 0 && cuts.length > 0) expect(sql).toContain('IS NULL');
        if (i > 0) expect(sql).toContain(`pixel_id > ${cuts[i - 1]}`);
        if (i < cuts.length) expect(sql).toContain(`pixel_id <= ${cuts[i]}`);
      }
    }
    expect(rangeWhere([], 0)).toBe('TRUE');
    // Without null pixel ids the first range is a plain bound DuckDB can skip row groups by.
    expect(rangeWhere([10, 20], 0, false)).toBe('pixel_id <= 10');
    expect(rangeWhere([10, 20], 1, false)).toBe(rangeWhere([10, 20], 1));
  });

  it('gives each engine room for many of the largest row groups, 128 MB to 2 GB', () => {
    expect(engineMemoryMB(1.5 * 1024 ** 2)).toBe(128); // every published file
    expect(engineMemoryMB(0)).toBe(128);
    expect(engineMemoryMB(16 * 1024 ** 2)).toBe(512);
    expect(engineMemoryMB(500 * 1024 ** 2)).toBe(2048);
  });

  it('uses half the cores, at most four engines, fewer with little memory', () => {
    expect(splitEngines(18, 10, 8)).toBe(4);
    expect(splitEngines(18, 4, 8)).toBe(2);
    expect(splitEngines(18, 10, 4)).toBe(2);
    expect(splitEngines(18, 10, 2)).toBe(1);
    expect(splitEngines(3, 16, 8)).toBe(3);
    expect(splitEngines(18, undefined, undefined)).toBe(1);
    expect(splitEngines(0, 10, 8)).toBe(1);
  });

  it('spreads equal-width bounds over the ids', () => {
    expect(equalCuts(1, 100, 4)).toEqual([25, 50, 75]);
    expect(equalCuts(5, 5, 4)).toEqual([]);
  });

  it('names parts after the file they came from', () => {
    expect(partPath('AU_Arc_pixels_timeseries.parquet', 0, 4)).toBe('AU_Arc_pixels_timeseries.part-1-of-4.parquet');
    expect(partPath('pixels_timeseries_ds/p.parquet', 9, 12)).toBe('pixels_timeseries_ds/p.part-10-of-12.parquet');
    // Tagged per split, and still recognised as split output when stale.
    const tagged = partPath('BR_Npw_pixels_timeseries-001.parquet', 0, 18, 'mhe4x1k2');
    expect(tagged).toBe('BR_Npw_pixels_timeseries-001.mhe4x1k2.part-01-of-18.parquet');
    expect(staleSplitFiles([tagged], [])).toEqual([tagged]);
    expect(staleSplitFiles([tagged], [tagged])).toEqual([]);
  });

  it('finds parts and tmp files a site no longer uses, and nothing else', () => {
    const keep = ['BR_Npw_pixels_timeseries-001.part-01-of-16.parquet', 'BR_Npw_pixels_geom.parquet'];
    const stored = [
      ...keep,
      'BR_Npw_pixels_timeseries-001.part-12-of-12.parquet', // an earlier import's split
      'tmp_BR_Npw_pixels_timeseries-001.part-02-of-16.parquet', // a failed DuckDB write
      'BR_Npw_pixels_timeseries-001.parquet', // not split output: left alone
      'BR-Npw-wetlsp-2024.nc',
      'pixels_timeseries_ds/p.part-3-of-4.parquet',
    ];
    expect(staleSplitFiles(stored, keep)).toEqual([
      'BR_Npw_pixels_timeseries-001.part-12-of-12.parquet',
      'tmp_BR_Npw_pixels_timeseries-001.part-02-of-16.parquet',
      'pixels_timeseries_ds/p.part-3-of-4.parquet',
    ]);
  });
});
