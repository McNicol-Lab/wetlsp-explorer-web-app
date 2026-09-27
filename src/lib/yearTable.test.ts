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
  unpackYearTable,
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
    expect(t2024.values[0 * 366 + 0]).toBeCloseTo(0.5);
    expect(Number.isNaN(t2024.values[0 * 366 + 1])).toBe(true);
    expect(t2024.values[1 * 366 + 2]).toBeCloseTo(0.3);
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
    const buf = await packYearTable(t2024, 'src-1').arrayBuffer();
    const back = unpackYearTable(buf, 'src-1')!;
    expect(Array.from(back.pixelIds)).toEqual([3, 7]);
    expect(back.values[366 + 2]).toBeCloseTo(0.3);
    expect(unpackYearTable(buf, 'src-2')).toBeNull();
    expect(unpackYearTable(buf.slice(0, buf.byteLength - 4), 'src-1')).toBeNull();
  });
});
