/**
 * The years a site is analysed over. WetLSP products are annual: a year is
 * complete when it has a phenometrics NetCDF. The time series can run past
 * those years (a partial first year of raw observations, a trailing year of
 * spline extrapolated with no observations), and those years plot as
 * misleading flat or broken lines. With NetCDF files present, only their
 * years are offered; without any, every year in the time series is.
 */
export function analysisYears(timeseriesYears: number[], netcdfYears: number[]): number[] {
  const ts = [...new Set(timeseriesYears)].sort((a, b) => a - b);
  const nc = new Set(netcdfYears);
  if (nc.size === 0) return ts;
  if (ts.length === 0) return [...nc].sort((a, b) => a - b);
  const kept = ts.filter((y) => nc.has(y));
  // A time series that shares no year with the NetCDFs is still worth plotting.
  return kept.length > 0 ? kept : ts;
}
