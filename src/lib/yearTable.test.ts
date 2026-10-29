import { describe, expect, it } from 'vitest';
import {
  buildYearTable,
  dailySummary,
  daysInYear,
  distinctPixels,
  extractBundle,
  packYearTable,
  pixelMeans,
  quantileCont,
  rowValues,
  unpackYearTable,
  YearTableBuilder,
  type YearTable,
} from './yearTable';

// Two pixels in 2024 (leap year): pixel 7 on days 0-2, pixel 3 on days 0 and 2.
const t2024 = buildYearTable(2024, 'spline', [7, 7, 7, 3, 3], [0, 1, 2, 0, 2], [0.1, 0.2, 0.3, 0.5, 0.7]);
const t2023 = buildYearTable(2023, 'spline', [3], [364], [0.9]);
const raw = buildYearTable(2024, 'raw', [7], [1], [0.25]);

describe('year tables', () => {
  it('knows leap years', () => {
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2023)).toBe(365);
    expect(t2024.days).toBe(366);
  });

  it('sorts pixels and leaves missing days as NaN', () => {
    expect(Array.from(t2024.pixelIds)).toEqual([3, 7]);
    expect(rowValues(t2024, 0)[0]).toBeCloseTo(0.5);
    expect(Number.isNaN(rowValues(t2024, 0)[1])).toBe(true);
    expect(rowValues(t2024, 1)[2]).toBeCloseTo(0.3);
  });

  // Large sites span many blocks; use 3-pixel blocks so the edges are exercised.
  const blocky = (ids: number[]): YearTable => {
    const b = new YearTableBuilder(2023, 'spline', 1, 3);
    for (const id of ids) b.add(id, id % 365, id / 100);
    return b.finish();
  };
  const sorted = Array.from({ length: 10 }, (_, i) => i * 10);

  it('keeps rows in blocks without changing what is read', () => {
    for (const ids of [sorted, [...sorted].reverse(), [40, 0, 90, 10, 80, 20, 70, 30, 60, 50]]) {
      const t = blocky(ids);
      expect(t.blocks.map((b) => b.length / 365)).toEqual([3, 3, 3, 1]);
      expect(Array.from(t.pixelIds)).toEqual(sorted);
      sorted.forEach((id, r) => {
        const row = rowValues(t, r);
        expect(row.length).toBe(365);
        expect(row[id % 365]).toBeCloseTo(id / 100);
        expect(row.filter((v) => !Number.isNaN(v)).length).toBe(1);
      });
    }
    expect(pixelMeans([blocky(sorted)]).get(90)).toBeCloseTo(0.9);
    expect(dailySummary([blocky(sorted)], [50, 60]).map((r) => r.n)).toEqual([1, 1]);
  });

  it('matches DuckDB quantile_cont', () => {
    // SELECT quantile_cont(x, 0.25) FROM (VALUES (1),(2),(3),(4)) t(x) -> 1.75
    expect(quantileCont([1, 2, 3, 4], 4, 0.25)).toBeCloseTo(1.75);
    expect(quantileCont([1, 2, 3, 4], 4, 0.75)).toBeCloseTo(3.25);
    expect(quantileCont([5], 1, 0.25)).toBe(5);
  });

  it('returns rows ordered by series, pixel, date, skipping gaps', () => {
    const b = extractBundle([t2024, raw], [7, 3], null, 1000);
    expect(b.seriesNames).toEqual(['raw', 'spline']);
    expect(Array.from(b.pixelId)).toEqual([7, 3, 3, 7, 7, 7]);
    expect(Array.from(b.seriesIdx)).toEqual([0, 1, 1, 1, 1, 1]);
    expect(new Date(b.time[0]).toISOString().slice(0, 10)).toBe('2024-01-02');
    expect(b.evi[1]).toBeCloseTo(0.5);
    expect(b.pixelsLoaded).toBe(2);
  });

  it('applies the date range and the row limit', () => {
    const b = extractBundle([t2024], [3, 7], ['2024-01-02', '2024-01-03'], 1000);
    expect(Array.from(b.pixelId)).toEqual([3, 7, 7]);
    expect(extractBundle([t2024], [3, 7], null, 2).rows).toBe(2);
    expect(extractBundle([t2024], [3, 7], ['2025-01-01', '2025-02-01'], 1000).rows).toBe(0);
  });

  it('summarises by date then series with mean, IQR and count', () => {
    const rows = dailySummary([t2024, raw], [3, 7]);
    expect(rows.slice(0, 3).map((r) => `${r.date} ${r.series} ${r.n}`)).toEqual([
      '2024-01-01 spline 2',
      '2024-01-02 raw 1',
      '2024-01-02 spline 1',
    ]);
    expect(rows[0].mean).toBeCloseTo(0.3);
    expect(rows[0].q25).toBeCloseTo(0.2);
    expect(rows[0].q75).toBeCloseTo(0.4);
    // Years come out in calendar order.
    expect(dailySummary([t2024, t2023], [3])[0].date).toBe('2023-12-31');
  });

  it('lists pixels with data and their means across years', () => {
    expect(Array.from(distinctPixels([t2024, t2023]))).toEqual([3, 7]);
    const m = pixelMeans([t2024, t2023]);
    expect(m.get(7)).toBeCloseTo(0.2);
    expect(m.get(3)).toBeCloseTo((0.5 + 0.7 + 0.9) / 3);
  });

  it('round-trips through storage and rejects stale or corrupt files', async () => {
    const blob = packYearTable(t2024, 'src-1');
    const back = (await unpackYearTable(blob, 'src-1'))!;
    expect(Array.from(back.pixelIds)).toEqual([3, 7]);
    expect(rowValues(back, 1)[2]).toBeCloseTo(0.3);
    expect(await unpackYearTable(blob, 'src-2')).toBeNull();
    expect(await unpackYearTable(blob.slice(0, blob.size - 4), 'src-1')).toBeNull();
  });

  it('stores several blocks as one values array, as files written before blocks did', async () => {
    const t = blocky(sorted);
    const blob = packYearTable(t, 'src');
    // Header, 10 ids, then 10 × 365 values with no gaps between blocks.
    const len = new Uint32Array(await blob.slice(0, 4).arrayBuffer())[0];
    expect(blob.size).toBe(4 + len + 10 * 4 + 10 * 365 * 4);
    const back = (await unpackYearTable(blob, 'src', 4))!;
    expect(back.blocks.map((b) => b.length / 365)).toEqual([4, 4, 2]);
    sorted.forEach((id, r) => expect(rowValues(back, r)[id % 365]).toBeCloseTo(id / 100));
  });
});
