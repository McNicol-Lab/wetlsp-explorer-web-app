import { describe, expect, it } from 'vitest';
import { percentileOf, sampleSliceAtPixels } from './pixelMetric';
import type { PixelGeometry, RasterSlice } from '@/lib/types';

// A 2 × 2 grid over x 0–20, y 0–20, rows north-up: row 0 is y 10–20.
const slice = {
  layer: 'OGI', width: 2, height: 2,
  values: Float32Array.from([1, 2, 3, NaN]),
  min: 1, max: 3, finiteCount: 3,
  bboxProjected: [0, 0, 20, 20], bboxWgs84: null, downsample: 1,
} as RasterSlice;

function geom(points: Array<[number, number, number]>): PixelGeometry {
  return {
    pixelId: Int32Array.from(points.map((_, i) => i)),
    cell: Int32Array.from(points.map((p) => p[2])),
    x: Float64Array.from(points.map((p) => p[0])),
    y: Float64Array.from(points.map((p) => p[1])),
    lon: new Float64Array(points.length), lat: new Float64Array(points.length),
    crsSource: 'test', crsName: null, epsg: null,
  };
}

describe('sampleSliceAtPixels', () => {
  it('reads the cell under each pixel, north-up, and keeps fills as NaN', () => {
    const g = geom([[5, 15, 0], [15, 15, 1], [5, 5, 2], [15, 5, 3], [25, 5, -1]]);
    const r = sampleSliceAtPixels(slice, g);
    expect(Array.from(r.values.slice(0, 3))).toEqual([1, 2, 3]);
    expect(Number.isNaN(r.values[3])).toBe(true);
    expect(r.outside).toBe(1);
    expect(r.finite).toBe(3);
    expect(r.cellAgreement).toBe(1);
    expect(r.cellBase).toBe(0);
  });

  it('recognises 1-based (R/terra) cell numbers', () => {
    const g = geom([[5, 15, 1], [15, 15, 2], [5, 5, 3]]);
    const r = sampleSliceAtPixels(slice, g);
    expect(r.cellAgreement).toBe(1);
    expect(r.cellBase).toBe(1);
  });

  it('gives percentiles over finite values', () => {
    const sorted = Float32Array.from([1, 2, 3, 4]);
    expect(percentileOf(sorted, 2)).toBe(50);
    expect(percentileOf(sorted, NaN)).toBeNull();
  });
});
