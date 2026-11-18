/**
 * Per-pixel values of a NetCDF phenometric layer, for colouring the Pixel Map.
 *
 * The layer is read at full resolution and each pixel takes the cell its
 * projected x/y falls in, using the slice's own bounding box (rows north-up,
 * as the Phenometrics view draws them). Fill values stay NaN: a pixel with no
 * estimate is shown as missing, never as zero.
 */
import { readRaster, MAX_CELL_BUDGET } from '@/engine/netcdf';
import type { PixelGeometry, RasterSlice, SiteManifest } from '@/lib/types';

export interface PixelLayerValues {
  layer: string;
  year: number;
  /** One value per geometry index; NaN where the layer has no estimate. */
  values: Float32Array;
  /** Range over finite pixel values, or null when none are finite. */
  domain: [number, number] | null;
  finite: number;
  /** Pixels outside the raster's extent (should be 0). */
  outside: number;
  /**
   * Share of pixels whose computed cell equals geometry.cell, when the file
   * gives cells. Pipelines number cells from 0 or (R/terra) from 1; the better
   * matching base is reported in `cellBase`.
   */
  cellAgreement: number | null;
  cellBase: 0 | 1 | null;
}

export function sampleSliceAtPixels(slice: RasterSlice, geometry: PixelGeometry): Omit<PixelLayerValues, 'layer' | 'year'> {
  const n = geometry.pixelId.length;
  const values = new Float32Array(n).fill(NaN);
  const bbox = slice.bboxProjected;
  if (!bbox) return { values, domain: null, finite: 0, outside: n, cellAgreement: null, cellBase: null };
  const [xmin, ymin, xmax, ymax] = bbox;
  const cw = (xmax - xmin) / slice.width;
  const ch = (ymax - ymin) / slice.height;
  let lo = Infinity;
  let hi = -Infinity;
  let finite = 0;
  let outside = 0;
  let withCell = 0;
  let agree0 = 0;
  let agree1 = 0;
  for (let i = 0; i < n; i++) {
    const col = Math.floor((geometry.x[i] - xmin) / cw);
    const row = Math.floor((ymax - geometry.y[i]) / ch);
    if (col < 0 || row < 0 || col >= slice.width || row >= slice.height) {
      outside++;
      continue;
    }
    const idx = row * slice.width + col;
    if (geometry.cell[i] >= 0 && slice.downsample === 1) {
      withCell++;
      if (geometry.cell[i] === idx) agree0++;
      else if (geometry.cell[i] === idx + 1) agree1++;
    }
    const v = slice.values[idx];
    if (!Number.isFinite(v)) continue;
    values[i] = v;
    finite++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return {
    values,
    domain: finite ? [lo, hi === lo ? lo + 1 : hi] : null,
    finite,
    outside,
    cellAgreement: withCell ? Math.max(agree0, agree1) / withCell : null,
    cellBase: withCell ? (agree1 > agree0 ? 1 : 0) : null,
  };
}

export async function readPixelLayer(
  manifest: SiteManifest,
  geometry: PixelGeometry,
  year: number,
  layer: string,
  opts: { signal?: AbortSignal; onProgress?: (p: import('@/lib/types').ProgressEvent) => void } = {},
): Promise<PixelLayerValues> {
  const slice = await readRaster(manifest, year, layer, MAX_CELL_BUDGET, opts);
  const out = { layer, year, ...sampleSliceAtPixels(slice, geometry) };
  if (import.meta.env.DEV) {
    (globalThis as { __pixelLayerCheck?: unknown }).__pixelLayerCheck = {
      layer, year, cellAgreement: out.cellAgreement, cellBase: out.cellBase, outside: out.outside, finite: out.finite, downsample: slice.downsample,
      width: slice.width, height: slice.height, bbox: slice.bboxProjected,
    };
  }
  return out;
}

/** Share of finite values at or below v (0–100), from a sorted copy. */
export function percentileOf(sorted: Float32Array | Float64Array, v: number): number | null {
  if (sorted.length < 2 || !Number.isFinite(v)) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

export function sortedFinite(values: Float32Array): Float32Array {
  return values.filter((v) => Number.isFinite(v)).sort();
}
