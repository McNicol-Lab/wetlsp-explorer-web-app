/**
 * Grid geometry for the classification rasters.
 *
 * Every array the analysis keeps is north-up and row-major: row 0 is the
 * northern edge. `resolveGrid` works out whether the stored rows need
 * reversing to get there (WetLSP v001 files store rows south-first under
 * north-up coordinates) and the GDAL GeoTransform of the north-up grid.
 */
import { epsgFromWkt, crsNameFromWkt } from '@/lib/crs';

export interface GridSpec {
  width: number;
  height: number;
  /** GDAL order, for the north-up grid: x = g0 + col·g1 + row·g2; y = g3 + col·g4 + row·g5. */
  geoTransform: [number, number, number, number, number, number];
  /** Reverse stored rows to make them north-up. */
  flipRows: boolean;
  crsWkt: string | null;
  epsg: number | null;
  crsName: string | null;
  /** Where the georeferencing came from. */
  source: 'coordinates' | 'geotransform';
  /** Planar area of one cell in square metres, or null when the CRS is not in metres. */
  cellAreaM2: number | null;
}

export interface GridInputs {
  width: number;
  height: number;
  x: ArrayLike<number> | null;
  y: ArrayLike<number> | null;
  /** GDAL GeoTransform attribute, if any. */
  geoTransform: number[] | null;
  crsWkt: string | null;
  /** True for files whose data rows are stored in reverse of their coordinates (WetLSP v001). */
  rowsReversed: boolean;
}

function regularStep(v: ArrayLike<number>, what: string): number {
  const n = v.length;
  const step = (v[n - 1] - v[0]) / (n - 1);
  if (!Number.isFinite(step) || step === 0) throw new Error(`The ${what} coordinates do not advance.`);
  const tol = Math.abs(step) * 1e-3;
  for (let i = 1; i < n; i++) {
    if (Math.abs(v[i] - v[i - 1] - step) > tol) {
      throw new Error(`The ${what} coordinates are not evenly spaced, so the grid cannot be written as a raster.`);
    }
  }
  return step;
}

/** True when the CRS is projected in metres, so cell areas are planar square metres. */
export function crsIsMetric(wkt: string | null, epsg: number | null): boolean {
  if (epsg !== null) {
    if (epsg === 4326 || epsg === 4269 || epsg === 4258) return false;
    if ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760)) return true;
    if (epsg >= 26901 && epsg <= 26923) return true;
    if (epsg >= 25828 && epsg <= 25838) return true;
    if (epsg === 5070 || epsg === 3857) return true;
  }
  if (!wkt) return false;
  const projected = /^\s*(PROJCRS|PROJCS)\b/i.test(wkt);
  return projected && /(LENGTHUNIT|UNIT)\s*\[\s*"(metre|meter|m)"/i.test(wkt);
}

export function resolveGrid(g: GridInputs): GridSpec {
  const { width, height } = g;
  if (!(width > 0 && height > 0)) throw new Error('The grid has no cells.');
  let gt: [number, number, number, number, number, number];
  let flip = false;
  let source: GridSpec['source'];

  if (g.x && g.y && g.x.length === width && g.y.length === height && width > 1 && height > 1) {
    source = 'coordinates';
    const dx = regularStep(g.x, 'x');
    const dy = regularStep(g.y, 'y');
    if (dx < 0) throw new Error('The x coordinates run east to west; that layout is not supported.');
    // The y coordinate of stored row i.
    const rowY = (i: number) => (g.rowsReversed ? g.y![height - 1 - i] : g.y![i]);
    flip = rowY(0) < rowY(height - 1);
    const ady = Math.abs(dy);
    const yTop = Math.max(g.y[0], g.y[height - 1]) + ady / 2;
    const xLeft = g.x[0] - dx / 2;
    gt = [xLeft, dx, 0, yTop, 0, -ady];
    if (g.geoTransform && g.geoTransform.length === 6) {
      const [ox, px, rx, oy, ry, py] = g.geoTransform;
      const tol = Math.max(Math.abs(dx), ady) * 1e-3;
      // A north-up GeoTransform must describe the same edges as the coordinates.
      const consistent =
        rx === 0 &&
        ry === 0 &&
        Math.abs(px - dx) <= tol &&
        Math.abs(Math.abs(py) - ady) <= tol &&
        Math.abs(ox - xLeft) <= tol &&
        Math.abs((py < 0 ? oy : oy + py * height) - yTop) <= tol;
      if (!consistent) {
        throw new Error(
          'The file\'s GeoTransform attribute and its x/y coordinates describe different grids, so its georeferencing cannot be trusted.',
        );
      }
    }
  } else if (g.geoTransform && g.geoTransform.length === 6) {
    source = 'geotransform';
    const [ox, px, rx, oy, ry, py] = g.geoTransform;
    const rotated = rx !== 0 || ry !== 0;
    // Stored row 0 is at the top when the y step is negative, unless the rows are reversed.
    const southFirst = (py > 0) !== g.rowsReversed;
    if (rotated && southFirst) {
      throw new Error('This rotated grid stores its rows south-first; re-export it north-up to classify it.');
    }
    flip = !rotated && southFirst;
    if (flip) {
      // After reversing rows, the old last row is the top edge.
      const top = py > 0 ? oy + py * height : oy;
      gt = [ox, px, 0, top, 0, -Math.abs(py)];
    } else {
      gt = [ox, px, rx, oy, ry, py];
    }
  } else {
    throw new Error('The file has neither x/y coordinates nor a GeoTransform, so it cannot be georeferenced.');
  }

  const epsg = g.crsWkt ? epsgFromWkt(g.crsWkt) : null;
  const det = Math.abs(gt[1] * gt[5] - gt[2] * gt[4]);
  return {
    width,
    height,
    geoTransform: gt,
    flipRows: flip,
    crsWkt: g.crsWkt,
    epsg,
    crsName: g.crsWkt ? crsNameFromWkt(g.crsWkt) : null,
    source,
    cellAreaM2: crsIsMetric(g.crsWkt, epsg) ? det : null,
  };
}

/** Why two years cannot share one model's maps, or null when they can. */
export function gridMismatch(a: GridSpec, b: GridSpec): string | null {
  if (a.width !== b.width || a.height !== b.height) {
    return `Grid size differs: ${a.width}×${a.height} vs ${b.width}×${b.height}.`;
  }
  const tol = Math.max(Math.abs(a.geoTransform[1]), Math.abs(a.geoTransform[5])) * 1e-3;
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a.geoTransform[i] - b.geoTransform[i]) > tol) return 'The grids are offset or have different cell sizes.';
  }
  if (a.epsg !== null && b.epsg !== null && a.epsg !== b.epsg) return `CRS differs: EPSG:${a.epsg} vs EPSG:${b.epsg}.`;
  if ((a.epsg === null || b.epsg === null) && (a.crsWkt ?? '') !== (b.crsWkt ?? '')) return 'The coordinate reference systems differ.';
  return null;
}

/** Reverse the rows of a row-major grid, in place, for any typed array. */
export function flipRows<T extends { length: number; subarray(a: number, b: number): T; set(a: T, o: number): void; slice(a: number, b: number): T }>(
  values: T,
  width: number,
  height: number,
): T {
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const a = top * width;
    const b = bottom * width;
    const tmp = values.slice(a, a + width);
    values.set(values.subarray(b, b + width), a);
    values.set(tmp, b);
  }
  return values;
}

/** Projected coordinates of a cell centre in the north-up grid. */
export function cellCenter(g: GridSpec, col: number, row: number): [number, number] {
  const t = g.geoTransform;
  const c = col + 0.5;
  const r = row + 0.5;
  return [t[0] + c * t[1] + r * t[2], t[3] + c * t[4] + r * t[5]];
}
