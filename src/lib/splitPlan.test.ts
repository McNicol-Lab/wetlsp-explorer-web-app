import { describe, expect, it } from 'vitest';
import { equalCuts, partPath, planPixelCuts, rangeWhere, type RowGroupStat } from './splitPlan';

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
  });

  it('spreads equal-width bounds over the ids', () => {
    expect(equalCuts(1, 100, 4)).toEqual([25, 50, 75]);
    expect(equalCuts(5, 5, 4)).toEqual([]);
  });

  it('names parts after the file they came from', () => {
    expect(partPath('AU_Arc_pixels_timeseries.parquet', 0, 4)).toBe('AU_Arc_pixels_timeseries.part-1-of-4.parquet');
    expect(partPath('pixels_timeseries_ds/p.parquet', 9, 12)).toBe('pixels_timeseries_ds/p.part-10-of-12.parquet');
  });
});
