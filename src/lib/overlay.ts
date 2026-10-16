/**
 * Raster overlays: a GeoTIFF or NetCDF grid drawn over the Pixel Map.
 *
 * The worker (workers/overlay.worker.ts) reads and georeferences the file;
 * everything here is plain array work shared with the tests: pooling to a
 * cell budget, a robust colour range, colouring, and placing the grid by its
 * four corners with an estimate of how far that placement can be off.
 */
import { GREENNESS_RAMP, TIMING_RAMP, VIRIDIS_RAMP, sampleRamp } from './colorscales';
import type { LayerTransform } from './crs';

export interface RasterOverlayData {
  /** File name as imported. */
  name: string;
  format: 'GeoTIFF' | 'NetCDF';
  /** NetCDF variable or GeoTIFF band label currently shown. */
  variable: string;
  /** Everything that can be shown instead (NetCDF variables or `band N`). */
  choices: string[];
  units: string | null;
  width: number;
  height: number;
  /** Row 0 is the northern edge. NaN where there is no data. */
  values: Float32Array;
  finiteCount: number;
  min: number;
  max: number;
  /** 2nd and 98th percentiles: the default colour range. */
  p2: number;
  p98: number;
  /** Cells per side merged to fit the budget (1 = full resolution). */
  downsample: number;
  sourceWidth: number;
  sourceHeight: number;
  crsName: string | null;
  epsg: number | null;
  /** [xmin, ymin, xmax, ymax] in the raster's own CRS. */
  bboxProjected: [number, number, number, number];
  /** deck.gl BitmapLayer order: bottom-left, top-left, top-right, bottom-right. */
  corners: [number, number][];
  bboxWgs84: [number, number, number, number];
  /** Largest gap, in metres, between corner placement and true reprojection. */
  placementErrorM: number;
  notes: string[];
}

export type OverlayRamp = 'viridis' | 'greens' | 'rainbow' | 'greys';

export const OVERLAY_RAMPS: Record<OverlayRamp, string[]> = {
  viridis: VIRIDIS_RAMP,
  greens: GREENNESS_RAMP,
  rainbow: TIMING_RAMP,
  greys: ['#000000', '#ffffff'],
};

/** Mean of the finite values in each `factor × factor` block. */
export function poolMean(
  src: ArrayLike<number>,
  width: number,
  height: number,
  factor: number,
): { values: Float32Array; width: number; height: number } {
  if (factor <= 1) return { values: Float32Array.from(src), width, height };
  const ow = Math.ceil(width / factor);
  const oh = Math.ceil(height / factor);
  const sum = new Float64Array(ow * oh);
  const n = new Uint32Array(ow * oh);
  for (let y = 0; y < height; y++) {
    const oy = Math.floor(y / factor) * ow;
    for (let x = 0; x < width; x++) {
      const v = src[y * width + x];
      if (!Number.isFinite(v)) continue;
      const k = oy + Math.floor(x / factor);
      sum[k] += v;
      n[k]++;
    }
  }
  const values = new Float32Array(ow * oh);
  for (let k = 0; k < values.length; k++) values[k] = n[k] ? sum[k] / n[k] : NaN;
  return { values, width: ow, height: oh };
}

/** Block size that brings `width × height` under `maxCells`. */
export function poolFactor(width: number, height: number, maxCells: number): number {
  const n = width * height;
  return n <= maxCells ? 1 : Math.ceil(Math.sqrt(n / maxCells));
}

/** Min, max and the 2nd/98th percentiles of the finite values. */
export function valueStats(values: Float32Array): { finiteCount: number; min: number; max: number; p2: number; p98: number } {
  const finite: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  // Percentiles from an even subsample: exact enough for a colour range.
  const stride = Math.max(1, Math.floor(values.length / 200_000));
  let finiteCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    finiteCount++;
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % stride === 0) finite.push(v);
  }
  if (finiteCount === 0) return { finiteCount, min: 0, max: 0, p2: 0, p98: 0 };
  finite.sort((a, b) => a - b);
  const at = (q: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))];
  return { finiteCount, min, max, p2: at(0.02), p98: at(0.98) };
}

/** RGBA pixels for an ImageData; NaN cells are transparent. */
export function colorize(
  values: Float32Array,
  ramp: string[],
  [lo, hi]: [number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  const span = hi - lo || 1;
  // A 256-step lookup table: the ramp is sampled once, not per cell.
  const lut = Array.from({ length: 256 }, (_, i) => sampleRamp(ramp, i / 255));
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const t = Math.min(255, Math.max(0, Math.round(((v - lo) / span) * 255)));
    const c = lut[t];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Metres between two lon/lat points (equirectangular; fine at site scale). */
function metresBetween(a: [number, number], b: [number, number]): number {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * k) * 111_320;
  const y = (b[1] - a[1]) * 110_574;
  return Math.hypot(x, y);
}

/**
 * Corners of a projected box in lon/lat, and how far the edge midpoints and
 * centre land from where interpolating those corners puts them. The map
 * draws the grid by its corners; for a few-kilometre UTM raster the gap is
 * well under a metre, for a continental one it can be large, so it is shown.
 */
export function placeByCorners(
  bbox: [number, number, number, number],
  tr: Pick<LayerTransform, 'toWgs84'>,
): { corners: [number, number][]; bboxWgs84: [number, number, number, number]; errorM: number } {
  const [x0, y0, x1, y1] = bbox;
  const at = (u: number, v: number) => tr.toWgs84(x0 + (x1 - x0) * u, y0 + (y1 - y0) * v);
  const bl = at(0, 0);
  const tl = at(0, 1);
  const trc = at(1, 1);
  const br = at(1, 0);
  const lerp = (u: number, v: number): [number, number] => [
    (1 - u) * (1 - v) * bl[0] + u * (1 - v) * br[0] + u * v * trc[0] + (1 - u) * v * tl[0],
    (1 - u) * (1 - v) * bl[1] + u * (1 - v) * br[1] + u * v * trc[1] + (1 - u) * v * tl[1],
  ];
  let errorM = 0;
  for (const [u, v] of [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0.5]]) {
    errorM = Math.max(errorM, metresBetween(at(u, v), lerp(u, v)));
  }
  const lons = [bl[0], tl[0], trc[0], br[0]];
  const lats = [bl[1], tl[1], trc[1], br[1]];
  return {
    corners: [bl, tl, trc, br],
    bboxWgs84: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    errorM,
  };
}

