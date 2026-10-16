/**
 * Raster overlay reads, checked against GDAL. The fixtures were written with
 * rasterio 1.4 (GDAL) and netCDF4; `utm10n.reference.json` holds what GDAL
 * itself reports for them: corner coordinates reprojected to WGS 84, and
 * the value its `index()` finds under a probe point. NetCDF expectations are
 * netCDF4-python's own unpacked (masked and scaled) values.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRaster } from './rasterRead';
import { colorize, placeByCorners, poolMean, valueStats } from './overlay';
import { layerTransform } from './crs';

const FIX = join(__dirname, '__fixtures__');
const buf = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const ref = JSON.parse(readFileSync(join(FIX, 'utm10n.reference.json'), 'utf8')) as {
  corners: [number, number][];
  r: number;
  c: number;
  value: number;
  band2: number;
};

describe('GeoTIFF (GDAL-written, EPSG:32610)', () => {
  it('places the grid where GDAL does and reads the same cell values', async () => {
    const d = await readRaster('utm10n.tif', buf(join(FIX, 'utm10n.tif')));
    expect(d.format).toBe('GeoTIFF');
    expect([d.width, d.height, d.downsample]).toEqual([40, 30, 1]);
    expect(d.epsg).toBe(32610);
    d.corners.forEach((c, i) => {
      expect(c[0]).toBeCloseTo(ref.corners[i][0], 7);
      expect(c[1]).toBeCloseTo(ref.corners[i][1], 7);
    });
    expect(d.values[ref.r * d.width + ref.c]).toBe(ref.value);
    expect(Number.isNaN(d.values[0])).toBe(true); // GDAL nodata -9999
    expect(d.finiteCount).toBe(40 * 30 - 1);
    expect(d.placementErrorM).toBeLessThan(0.01);
    expect(d.choices).toEqual(['band 1', 'band 2']);
  });

  it('reads another band on request', async () => {
    const d = await readRaster('utm10n.tif', buf(join(FIX, 'utm10n.tif')), { choice: 'band 2' });
    expect(d.variable).toBe('band 2');
    expect(d.values[ref.r * d.width + ref.c]).toBe(ref.band2);
  });

  it('downsamples to the cell budget', async () => {
    const d = await readRaster('utm10n.tif', buf(join(FIX, 'utm10n.tif')), { maxCells: 300 });
    expect(d.downsample).toBe(2);
    expect([d.width, d.height]).toEqual([20, 15]);
    expect(d.sourceWidth).toBe(40);
  });
});

describe('NetCDF-4 (CF, latitude ascending)', () => {
  it('turns south-first rows north-up, drops fill, applies scale, takes the first time step', async () => {
    const d = await readRaster('cf.nc', buf(join(FIX, 'cf_lat_ascending.nc')));
    expect(d.format).toBe('NetCDF');
    expect(d.variable).toBe('flood');
    expect(d.choices).toEqual(['flood']);
    expect(d.units).toBe('cm');
    expect([d.width, d.height]).toEqual([80, 50]);
    expect(d.epsg).toBe(4326);
    // Stored value = lat_index·100 + lon_index, scale 0.5. Row 0 must be the northernmost (index 49).
    expect(d.values[0 * 80 + 3]).toBe((49 * 100 + 3) * 0.5);
    expect(d.values[49 * 80 + 3]).toBe(3 * 0.5);
    // The fill cell at (lat 5, lon 5) lands on row 49 - 5 after the flip.
    expect(Number.isNaN(d.values[44 * 80 + 5])).toBe(true);
    expect(d.bboxWgs84[0]).toBeCloseTo(-121.8005, 9);
    expect(d.bboxWgs84[3]).toBeCloseTo(38.0495, 9);
    expect(d.notes.join(' ')).toMatch(/first slice/);
  });

  it('refuses classic NetCDF-3 with a way forward', async () => {
    const classic = new TextEncoder().encode('CDF\x01\0\0\0\0').buffer;
    await expect(readRaster('old.nc', classic)).rejects.toThrow(/nccopy -k nc4/);
  });
});

describe('overlay helpers', () => {
  it('pools block means and ignores missing cells', () => {
    const p = poolMean(Float32Array.from([1, 3, NaN, 5, NaN, NaN, NaN, NaN, 9]), 3, 3, 2);
    expect([p.width, p.height]).toEqual([2, 2]);
    // Blocks: {1, 3, 5, NaN} → 3; {NaN, NaN} → none; {NaN, NaN} → none; {9} → 9.
    expect(Array.from(p.values).map((v) => (Number.isNaN(v) ? null : v))).toEqual([3, null, null, 9]);
  });

  it('computes a robust colour range', () => {
    const v = Float32Array.from({ length: 1000 }, (_, i) => i);
    v[0] = NaN;
    const s = valueStats(v);
    expect(s).toMatchObject({ finiteCount: 999, min: 1, max: 999 });
    expect(s.p2).toBeCloseTo(21, 0);
    expect(s.p98).toBeCloseTo(979, 0);
  });

  it('colours cells and leaves missing ones transparent', () => {
    const rgba = colorize(Float32Array.from([0, NaN, 1]), ['#000000', '#ffffff'], [0, 1]);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it('reports no placement error for a lon/lat grid and some for a continental Albers one', () => {
    expect(placeByCorners([-122, 37, -121, 38], layerTransform(4326, 't')).errorM).toBe(0);
    const conus = placeByCorners([-2_300_000, 300_000, 2_200_000, 3_100_000], layerTransform(5070, 't'));
    expect(conus.errorM).toBeGreaterThan(10_000);
  });
});

/* Local-only: large and real files. */
const BIG = process.env.OVERLAY_BIG_TIF;
const WETLSP_NC = process.env.WETLSP_NC;

describe.skipIf(!BIG)('2000×1500 GeoTIFF', () => {
  it('reads at reduced resolution without a full-size array', async () => {
    const d = await readRaster('big.tif', buf(BIG!));
    expect(d.downsample).toBe(2);
    expect([d.width, d.height]).toEqual([1000, 750]);
    // Value = row + col; nearest resampling keeps an exact source cell.
    expect(d.values[0]).toBe(0);
  });
});

describe.skipIf(!WETLSP_NC)('WetLSP phenometric NetCDF', () => {
  it('reads a v001 file, flips it north-up and places it in UTM', async () => {
    const d = await readRaster('site-wetlsp.nc', buf(WETLSP_NC!), { choice: 'EVImax' });
    expect(d.variable).toBe('EVImax');
    expect(d.choices).toContain('OGI');
    expect(d.crsName).toMatch(/UTM/);
    expect(d.finiteCount).toBeGreaterThan(1000);
    console.log(`WetLSP overlay: ${d.width}×${d.height}, ${d.finiteCount} finite, range ${d.min}–${d.max}, bbox ${d.bboxWgs84.map((v) => v.toFixed(5)).join(', ')}`);
  });
});
