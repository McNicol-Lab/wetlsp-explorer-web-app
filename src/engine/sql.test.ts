/**
 * The guardrail tests. `pixels_timeseries` is 28 M rows for one site, so these
 * check that no code path can build a query without a year, a series and a
 * bounded pixel list.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PIXEL_SAMPLE,
  MAX_RESULT_ROWS,
  UnboundedQueryError,
  buildDailySummarySql,
  buildDistinctPixelsSql,
  buildFactsSql,
  buildPixelMeanSql,
  buildPixelTraceSql,
  buildTimeseriesSql,
  buildWhere,
} from './sql';

const REF = "read_parquet(['site_CA-DB2/CA_DB2_pixels_timeseries.parquet'], union_by_name = true)";
const base = { years: [2021], series: ['spline'], pixelIds: [1, 2, 3] };

describe('buildWhere', () => {
  it('always filters year, series and pixel id', () => {
    const where = buildWhere(base);
    expect(where).toContain('year IN (2021)');
    expect(where).toContain("series IN ('spline')");
    expect(where).toContain('pixel_id IN (1, 2, 3)');
  });

  it('adds an inclusive date range when one is given', () => {
    const where = buildWhere({ ...base, dateRange: ['2023-06-01', '2023-09-30'] });
    expect(where).toContain("date BETWEEN DATE '2023-06-01' AND DATE '2023-09-30'");
  });

  it('refuses an empty pixel list', () => {
    expect(() => buildWhere({ ...base, pixelIds: [] })).toThrow(UnboundedQueryError);
  });

  it('refuses more pixels than the cap', () => {
    const tooMany = Array.from({ length: MAX_PIXEL_SAMPLE + 1 }, (_, i) => i);
    expect(() => buildWhere({ ...base, pixelIds: tooMany })).toThrow(/exceeds the 5000 cap/);
  });

  it('accepts exactly the cap', () => {
    const atCap = Array.from({ length: MAX_PIXEL_SAMPLE }, (_, i) => i);
    expect(() => buildWhere({ ...base, pixelIds: atCap })).not.toThrow();
  });

  it('refuses an empty series or year list', () => {
    expect(() => buildWhere({ ...base, series: [] })).toThrow(UnboundedQueryError);
    expect(() => buildWhere({ ...base, years: [] })).toThrow(UnboundedQueryError);
  });

  it('rejects non-integer pixel ids rather than interpolating them', () => {
    expect(() => buildWhere({ ...base, pixelIds: [1.5] })).toThrow(/not an integer/);
  });

  it('rejects a malformed date range instead of passing it through', () => {
    expect(() =>
      buildWhere({ ...base, dateRange: ["2021-01-01'; DROP TABLE x; --", '2021-12-31'] }),
    ).toThrow(/ISO/);
  });

  it('escapes quotes in series names', () => {
    expect(buildWhere({ ...base, series: ["o'dd"] })).toContain("series IN ('o''dd')");
  });
});

describe('every timeseries query is bounded', () => {
  it('per-pixel rows carry a LIMIT and all three filters', () => {
    const sql = buildTimeseriesSql(REF, base);
    expect(sql).toMatch(/LIMIT \d+/);
    expect(sql).toContain('year IN (2021)');
    expect(sql).toContain('pixel_id IN (1, 2, 3)');
  });

  it('caps the row limit at the hard ceiling even when asked for more', () => {
    const sql = buildTimeseriesSql(REF, base, 999_000_000);
    expect(sql).toContain(`LIMIT ${MAX_RESULT_ROWS}`);
  });

  it('daily summary aggregates in SQL, not in JS', () => {
    const sql = buildDailySummarySql(REF, base);
    expect(sql).toContain('avg(evi)');
    expect(sql).toContain('quantile_cont(evi, 0.25)');
    expect(sql).toContain('quantile_cont(evi, 0.75)');
    expect(sql).toContain('GROUP BY 1, 2');
    expect(sql).toMatch(/LIMIT \d+/);
  });

  it('a single-pixel trace goes through the same guard', () => {
    expect(buildPixelTraceSql(REF, 42, [2021], ['raw'])).toContain('pixel_id IN (42)');
    expect(() => buildPixelTraceSql(REF, 1.2, [2021], ['raw'])).toThrow();
  });

  it('distinct pixels and per-pixel means still require a year and a series', () => {
    expect(buildDistinctPixelsSql(REF, [2021], ['spline'])).toContain('SELECT DISTINCT pixel_id');
    expect(() => buildDistinctPixelsSql(REF, [], ['spline'])).toThrow(UnboundedQueryError);
    expect(() => buildPixelMeanSql(REF, [2021], [])).toThrow(UnboundedQueryError);
    const means = buildPixelMeanSql(REF, [2021], ['spline']);
    expect(means).toContain('GROUP BY 1');
    expect(means).toMatch(/LIMIT \d+/);
  });

  it('the one unfiltered statement is a grouped aggregate, not a row scan', () => {
    const sql = buildFactsSql(REF);
    expect(sql).toContain('GROUP BY 1, 2');
    expect(sql).not.toMatch(/SELECT\s+\*/);
    expect(sql).toContain('count(*)');
  });

  it('no builder can emit a bare SELECT *', () => {
    const statements = [
      buildTimeseriesSql(REF, base),
      buildDailySummarySql(REF, base),
      buildDistinctPixelsSql(REF, [2021], ['spline']),
      buildPixelMeanSql(REF, [2021], ['spline']),
      buildFactsSql(REF),
    ];
    for (const sql of statements) expect(sql).not.toMatch(/SELECT\s+\*/i);
  });
});
