import { describe, expect, it } from 'vitest';
import { yearAvailability } from './AvailabilityStrip';
import type { CatalogSite, SiteManifest } from '@/lib/types';

const manifest = {
  siteId: 'US-Uaf',
  timeseries: { parts: [], totalBytes: 1 },
  netcdf: [2021, 2022, 2023, 2024].map((year) => ({ year, path: `US-Uaf-wetlsp-${year}.nc`, size: 10 })),
} as unknown as SiteManifest;

describe('yearAvailability', () => {
  it('marks a year full only when both EVI rows and its NetCDF exist', () => {
    const out = yearAvailability(manifest, [2021, 2022, 2023], undefined);
    expect(out.map((y) => [y.year, y.state])).toEqual([
      [2021, 'full'], [2022, 'full'], [2023, 'full'], [2024, 'partial'],
    ]);
    expect(out[3].detail).toContain('no rows for this year');
  });

  it('keeps catalog-only years distinct from imported ones', () => {
    const record = { site_id: 'US-Uaf', years: { 2020: true, 2021: true } } as unknown as CatalogSite;
    const out = yearAvailability(null, [], record);
    expect(out.map((y) => y.state)).toEqual(['catalog', 'catalog']);
  });
});
