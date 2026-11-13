import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { CODE, FEATURE_ORDER, METHOD_VERSIONS, MODEL_SCHEMA, N_FEATURES, N_SUMMARY, STATUS } from './constants';
import { computeConsensus, consensusAvailable, consensusPolicy } from './consensus';
import { annualCover, consensusCover } from './cover';
import { MedianAccumulator } from './summary';
import { cellCenter, gridMismatch, resolveGrid } from './grid';
import { writeGeoTiff } from './geotiff';
import { geotiffPalette } from './palette';
import { validateModel } from './model';
import { zipStore, crc32 } from '@/lib/zipWrite';
import { listZip, openZipMember } from '@/lib/zip';

const u8 = (a: number[]) => Uint8Array.from(a);
const ones = (n: number) => new Uint8Array(n).fill(1);

describe('consensus policy v1', () => {
  // One cell per column: the four example cases from the specification and more.
  const years = [
    u8([2, 2, 2, 0, 1, 3, 0]),
    u8([2, 2, 2, 0, 2, 3, 0]),
    u8([3, 3, 0, 0, 3, 3, 0]),
    u8([0, 3, 0, 0, 4, 3, 0]),
  ];
  const fp = years.map(() => u8([1, 1, 1, 1, 1, 1, 0]));
  const r = computeConsensus(years, fp, 5);

  it('[2, 2, 3, missing] → class 2, 3 valid years, agreement 2/3', () => {
    expect(r.cls[0]).toBe(2);
    expect(r.validYears[0]).toBe(3);
    expect(r.votes[0]).toBe(2);
    expect(r.agreement[0]).toBeCloseTo(2 / 3, 6);
  });
  it('[2, 2, 3, 3] → ambiguous, never the smaller class id', () => {
    expect(r.cls[1]).toBe(CODE.AMBIGUOUS);
    expect(r.agreement[1]).toBeCloseTo(0.5, 6);
  });
  it('[2, 2, missing, missing] → insufficient coverage, not class 2', () => {
    expect(r.cls[2]).toBe(CODE.INSUFFICIENT);
    expect(r.validYears[2]).toBe(2);
  });
  it('no valid year inside the footprint → no data; outside every footprint → outside', () => {
    expect(r.cls[3]).toBe(CODE.NODATA);
    expect(r.validYears[3]).toBe(0);
    expect(Number.isNaN(r.agreement[3])).toBe(true);
    expect(r.cls[6]).toBe(CODE.NODATA);
    expect(r.validYears[6]).toBe(CODE.OUTSIDE);
  });
  it('four different classes → ambiguous; unanimous → that class with agreement 1', () => {
    expect(r.cls[4]).toBe(CODE.AMBIGUOUS);
    expect(r.cls[5]).toBe(3);
    expect(r.agreement[5]).toBe(1);
  });
  it('missing labels never vote: the notebook would have returned −1 for [−1, −1, 2, 3]', () => {
    const x = computeConsensus([u8([0]), u8([0]), u8([2]), u8([3])], [ones(1), ones(1), ones(1), ones(1)], 3);
    expect(x.cls[0]).toBe(CODE.INSUFFICIENT);
    expect(x.validYears[0]).toBe(2);
  });
  it('labels a four-year consensus only when four years go in', () => {
    expect(consensusPolicy([2024, 2021, 2023, 2022])).toMatchObject({ isFourYear: true, label: 'Four-year consensus', years: [2021, 2022, 2023, 2024] });
    expect(consensusPolicy([2021, 2022, 2023]).label).toBe('3-year consensus');
    expect(consensusAvailable(2)).toBe(false);
    expect(consensusAvailable(3)).toBe(true);
  });
});

describe('class cover uses full-resolution labels and named denominators', () => {
  it('annual: percent of classified and of footprint, with exclusion counts', () => {
    const labels = u8([1, 1, 2, 0, 0, 0, 3, 0]);
    const status = u8([0, 0, 0, STATUS.QA_REJECTED, STATUS.NO_PRODUCT, STATUS.MISSING_CYCLE1, 0, STATUS.NO_PRODUCT]);
    const c = annualCover(2024, labels, status, 3, 9);
    expect(c.classifiedCells).toBe(4);
    expect(c.footprintCells).toBe(6);
    expect(c.rows[0]).toMatchObject({ classId: 1, count: 2, pctClassified: 50, areaM2: 18 });
    expect(c.rows[0].pctFootprint).toBeCloseTo(100 / 3, 9);
    expect(c.statusCounts).toEqual([4, 2, 1, 1, 0]);
  });
  it('refuses labels that disagree with the eligibility mask', () => {
    expect(() => annualCover(2024, u8([1, 0]), u8([0, 0]), 2, null)).toThrow(/inconsistent/);
  });
  it('consensus: ambiguous and insufficient are reported, not hidden in a class', () => {
    const cls = u8([1, CODE.AMBIGUOUS, CODE.INSUFFICIENT, 0, 0]);
    const valid = u8([4, 4, 2, 0, CODE.OUTSIDE]);
    const c = consensusCover('Four-year consensus', [2021, 2022, 2023, 2024], cls, valid, 2, null);
    expect(c).toMatchObject({ classifiedCells: 1, ambiguousCells: 1, insufficientCells: 1, noValidYearCells: 1, footprintCells: 4 });
    expect(c.rows[0].pctFootprint).toBe(25);
    expect(c.rows[0].areaM2).toBeNull();
    expect(c.validYearHistogram).toEqual([1, 0, 1, 0, 2]);
  });
});

describe('exact class medians', () => {
  const lo = new Float64Array(N_SUMMARY).fill(0);
  const hi = new Float64Array(N_SUMMARY).fill(100);
  const row = (v: number) => {
    const r = new Float32Array(N_FEATURES).fill(v);
    r[10] = v % 2;
    return r;
  };
  it('odd and even counts follow NumPy (mean of the two middle values)', () => {
    const acc = new MedianAccumulator(2, lo, hi);
    for (const v of [5, 1, 9]) acc.add(0, row(v), 0, v);
    for (const v of [4, 1, 7, 2]) acc.add(1, row(v), 0, v);
    expect(acc.median(0, 0)).toBe(5);
    expect(acc.median(1, 0)).toBe(3);
    expect(acc.median(1, N_SUMMARY - 1)).toBe(3);
    const s = acc.summaries();
    expect(s[0]).toMatchObject({ classId: 1, count: 3 });
    expect(s[0].cycle2Fraction).toBe(1);
    expect(s[1].cycle2Fraction).toBe(0.5);
  });
  it('an empty class has null medians', () => {
    const acc = new MedianAccumulator(2, lo, hi);
    acc.add(0, row(3), 0, 3);
    expect(acc.summaries()[1].medians[FEATURE_ORDER[0]]).toBeNull();
  });
});

describe('grid orientation and georeferencing', () => {
  const x = [100.5, 103.5, 106.5];
  const yDesc = [209.5, 206.5];
  it('WetLSP v001: north-up coordinates over south-first rows → flip, north-up transform', () => {
    const g = resolveGrid({ width: 3, height: 2, x, y: yDesc, geoTransform: [99, 3, 0, 211, 0, -3], crsWkt: 'PROJCRS["WGS 84 / UTM zone 10N",LENGTHUNIT["metre",1],ID["EPSG",32610]]', rowsReversed: true });
    expect(g.flipRows).toBe(true);
    expect(g.geoTransform).toEqual([99, 3, 0, 211, 0, -3]);
    expect(g.epsg).toBe(32610);
    expect(g.cellAreaM2).toBe(9);
    expect(cellCenter(g, 0, 0)).toEqual([100.5, 209.5]);
  });
  it('a correct north-up file is not flipped; an ascending-y file is', () => {
    expect(resolveGrid({ width: 3, height: 2, x, y: yDesc, geoTransform: null, crsWkt: null, rowsReversed: false }).flipRows).toBe(false);
    const asc = resolveGrid({ width: 3, height: 2, x, y: [206.5, 209.5], geoTransform: null, crsWkt: null, rowsReversed: false });
    expect(asc.flipRows).toBe(true);
    expect(asc.geoTransform[3]).toBe(211);
    expect(asc.cellAreaM2).toBeNull();
  });
  it('refuses a GeoTransform that contradicts the coordinates', () => {
    expect(() => resolveGrid({ width: 3, height: 2, x, y: yDesc, geoTransform: [99, 3, 0, 214, 0, -3], crsWkt: null, rowsReversed: false })).toThrow(/different grids/);
  });
  it('keeps rotation from a GeoTransform-only grid', () => {
    const g = resolveGrid({ width: 3, height: 2, x: null, y: null, geoTransform: [99, 3, 0.5, 211, 0.5, -3], crsWkt: null, rowsReversed: false });
    expect(g.geoTransform).toEqual([99, 3, 0.5, 211, 0.5, -3]);
    expect(g.flipRows).toBe(false);
  });
  it('detects years on different grids', () => {
    const a = resolveGrid({ width: 3, height: 2, x, y: yDesc, geoTransform: null, crsWkt: null, rowsReversed: false });
    const b = resolveGrid({ width: 3, height: 2, x: x.map((v) => v + 3), y: yDesc, geoTransform: null, crsWkt: null, rowsReversed: false });
    expect(gridMismatch(a, a)).toBeNull();
    expect(gridMismatch(a, b)).toMatch(/offset/);
  });
});

describe('GeoTIFF writer (read back with geotiff.js; GDAL checks run in scripts/phenoclass_validate_geotiff.py)', () => {
  const grid = { width: 5, height: 3, geoTransform: [606360.036162853, 3, 0, 4213587, 0, -3] as [number, number, number, number, number, number], epsg: 32610, crsWkt: null, crsName: 'WGS 84 / UTM zone 10N' };
  it('UInt8 class raster: dimensions, values, CRS, transform, nodata and palette', async () => {
    const data = u8([0, 1, 2, 3, 4, 5, 6, 7, 253, 254, 0, 1, 1, 1, 0]);
    const bytes = writeGeoTiff({ grid, data, nodata: 0, palette: geotiffPalette(7) });
    const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const img = await tiff.getImage();
    expect([img.getWidth(), img.getHeight()]).toEqual([5, 3]);
    expect(Array.from((await img.readRasters())[0] as Uint8Array)).toEqual(Array.from(data));
    expect(img.getOrigin()).toEqual([606360.036162853, 4213587, 0]);
    expect(img.getResolution()).toEqual([3, -3, 0]);
    expect(img.getGeoKeys()).toMatchObject({ GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32610 });
    expect(img.getGDALNoData()).toBe(0);
    const fd = img.getFileDirectory();
    expect(await fd.loadValue('PhotometricInterpretation')).toBe(3);
    const cmap = Array.from((await fd.loadValue('ColorMap')) as ArrayLike<number>);
    expect(cmap).toHaveLength(768);
    // Class 1 is #2a78d6: red, green and blue thirds of the map, scaled ×257.
    expect([cmap[1], cmap[257], cmap[513]]).toEqual([0x2a * 257, 0x78 * 257, 0xd6 * 257]);
  });
  it('Float32 agreement raster with NaN nodata', async () => {
    const data = Float32Array.from([0.5, 1, Number.NaN, 0.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.25]);
    const bytes = writeGeoTiff({ grid, data, nodata: 'nan' });
    const img = await (await fromArrayBuffer(bytes.buffer as ArrayBuffer)).getImage();
    const back = (await img.readRasters())[0] as Float32Array;
    expect(Number.isNaN(back[2])).toBe(true);
    expect(back[14]).toBeCloseTo(0.25, 7);
    expect(Number.isNaN(img.getGDALNoData() as number)).toBe(true);
  });
  it('writes many strips for a larger raster and reads them back exactly', async () => {
    const big = { ...grid, width: 700, height: 333 };
    const data = new Uint8Array(700 * 333).map((_, i) => (i * 7) % 9);
    const bytes = writeGeoTiff({ grid: big, data, nodata: 0 });
    const img = await (await fromArrayBuffer(bytes.buffer as ArrayBuffer)).getImage();
    expect(Array.from((await img.readRasters())[0] as Uint8Array)).toEqual(Array.from(data));
  });
  it('refuses a CRS without an EPSG code rather than writing it wrongly', () => {
    expect(() => writeGeoTiff({ grid: { ...grid, epsg: null }, data: new Uint8Array(15), nodata: 0 })).toThrow(/EPSG/);
  });
});

describe('ZIP writer', () => {
  it('round-trips through the app\'s own reader with correct CRCs', async () => {
    const tif = new Uint8Array(70_000).map((_, i) => i % 251);
    const blob = zipStore([
      { path: 'README.md', data: '# hello' },
      { path: 'geotiff/class-2024.tif', data: tif },
    ]);
    const members = await listZip(blob);
    expect(members.map((m) => m.path)).toEqual(['README.md', 'geotiff/class-2024.tif']);
    const stream = await openZipMember(blob, members[1]);
    const back = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(crc32(back)).toBe(crc32(tif));
    expect(back.length).toBe(tif.length);
  });
});

describe('model import validation', () => {
  const good = {
    schema: MODEL_SCHEMA,
    schemaVersion: 1,
    method: METHOD_VERSIONS,
    featureOrder: [...FEATURE_ORDER],
    siteId: 'US-Myb',
    qaPolicy: { validQaCodes: [1, 2, 3, 4], cycle1MaxQa: 3, cycle2MaxQa: 3, doyPeriod: 365 },
    scaler: { mean: new Array(21).fill(0), scale: new Array(21).fill(1), variance: new Array(21).fill(1), nSamples: 10 },
    kmeans: { k: 2, centers: [new Array(21).fill(0), new Array(21).fill(1)] },
    featureUnits: { storedScale: { EVImax: 0.0001 }, units: [] },
  };
  it('accepts a well-formed model for the same site', () => {
    expect(validateModel(good, 'US-Myb', { EVImax: 0.0001 }).kmeans.k).toBe(2);
  });
  it.each([
    ['another site', { siteId: 'CA-EM2' }, /site-specific/],
    ['reordered features', { featureOrder: [...FEATURE_ORDER].reverse() }, /Feature order/],
    ['non-finite centroids', { kmeans: { k: 2, centers: [new Array(21).fill(Number.NaN), new Array(21).fill(1)] } }, /Centroids/],
    ['a zero scale', { scaler: { ...good.scaler, scale: new Array(21).fill(0) } }, /positive/],
    ['k out of range', { kmeans: { k: 12, centers: [] } }, /k must be/],
    ['a different timing convention', { qaPolicy: { ...good.qaPolicy, doyPeriod: 366 } }, /365-day/],
  ])('rejects %s', (_label, patch, re) => {
    expect(() => validateModel({ ...good, ...patch }, 'US-Myb')).toThrow(re);
  });
  it('rejects a model whose stored EVI scale differs from the data', () => {
    expect(() => validateModel(good, 'US-Myb', { EVImax: 0.001 })).toThrow(/scale/);
  });
});
