/// <reference lib="webworker" />
/**
 * Coordinate work kept off the main thread: bulk UTM -> WGS84 reprojection and
 * polygon hit-testing for pixel selection.
 */
import { serve, type HandlerContext } from '@/lib/rpc';
import { reprojectMany, type CrsResolution } from '@/lib/crs';

export interface ReprojectResult {
  lon: Float64Array;
  lat: Float64Array;
  resolution: CrsResolution;
  bounds: [number, number, number, number];
}

/** Ray-casting point-in-polygon; `ring` is a flat [x0,y0,x1,y1,…] list. */
function pointInRing(px: number, py: number, ring: Float64Array): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const handlers = {
  async reproject(
    ctx: HandlerContext,
    wkt: string | null,
    xs: Float64Array,
    ys: Float64Array,
  ): Promise<ReprojectResult> {
    ctx.progress({ phase: 'Reprojecting pixels', fraction: null, detail: `${xs.length} pixels` });
    const { lon, lat, resolution } = reprojectMany(wkt, xs, ys);
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (let i = 0; i < lon.length; i++) {
      if (lon[i] < minLon) minLon = lon[i];
      if (lon[i] > maxLon) maxLon = lon[i];
      if (lat[i] < minLat) minLat = lat[i];
      if (lat[i] > maxLat) maxLat = lat[i];
    }
    return {
      lon,
      lat,
      resolution,
      bounds: lon.length ? [minLon, minLat, maxLon, maxLat] : [0, 0, 0, 0],
    };
  },

  /**
   * Every pixel inside a polygon. A bounding-box prefilter runs first (the
   * Shiny app's guard), so a lasso over 14k pixels never costs 14k ray casts. The
   * caller draws a random sample when there are more than it can plot.
   */
  async pixelsInPolygon(
    ctx: HandlerContext,
    lon: Float64Array,
    lat: Float64Array,
    pixelId: Int32Array,
    ring: Float64Array,
  ): Promise<Int32Array> {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < minX) minX = ring[i];
      if (ring[i] > maxX) maxX = ring[i];
      if (ring[i + 1] < minY) minY = ring[i + 1];
      if (ring[i + 1] > maxY) maxY = ring[i + 1];
    }

    const hits: number[] = [];
    for (let i = 0; i < pixelId.length; i++) {
      const x = lon[i];
      const y = lat[i];
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (pointInRing(x, y, ring)) hits.push(pixelId[i]);
      if ((i & 0xfff) === 0) ctx.throwIfCancelled();
    }

    return Int32Array.from(hits);
  },
};

serve(handlers as unknown as Record<string, (ctx: HandlerContext, ...args: never[]) => unknown>);
