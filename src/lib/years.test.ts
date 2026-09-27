import { describe, expect, it } from 'vitest';
import { analysisYears } from './years';

describe('analysisYears', () => {
  it('drops time-series years without a NetCDF (partial 2020, spline-only 2025)', () => {
    expect(analysisYears([2020, 2021, 2022, 2023, 2024, 2025], [2021, 2022, 2023, 2024])).toEqual([
      2021, 2022, 2023, 2024,
    ]);
  });

  it('keeps every time-series year when there are no NetCDFs', () => {
    expect(analysisYears([2025, 2020, 2021, 2021], [])).toEqual([2020, 2021, 2025]);
  });

  it('falls back to NetCDF years when there is no time series', () => {
    expect(analysisYears([], [2024, 2022])).toEqual([2022, 2024]);
  });

  it('keeps the time series when it shares no year with the NetCDFs', () => {
    expect(analysisYears([2019, 2020], [2023])).toEqual([2019, 2020]);
  });
});
