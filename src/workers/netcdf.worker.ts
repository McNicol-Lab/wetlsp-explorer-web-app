/// <reference lib="webworker" />
/**
 * NetCDF-4 reader.
 *
 * WetLSP annual files are NetCDF-4, i.e. HDF5 containers (magic `\x89HDF`), so
 * `netcdfjs` cannot read them; this worker uses h5wasm. It reads OPFS directly,
 * so a 50 MB raster never crosses a postMessage boundary as a whole file.
 */
import * as h5wasm from 'h5wasm';
import { serve, type HandlerContext } from '@/lib/rpc';
import { readSiteFile } from '@/lib/opfs';
import { layerInfo, phenometricScaleType } from '@/lib/layers';
import { epsgFromWkt, makeToWgs84 } from '@/lib/crs';
import { flipRowsInPlace, rowsStoredSouthUp, type GlobalAttrs } from '@/lib/orientation';
import type { NetcdfInfo, NetcdfVariable, RasterSlice } from '@/lib/types';

type AnyModule = { FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void } };

let modulePromise: Promise<AnyModule> | null = null;
async function h5ready(): Promise<AnyModule> {
  modulePromise ??= h5wasm.ready as unknown as Promise<AnyModule>;
  return modulePromise;
}

interface OpenFile {
  file: h5wasm.File;
  vfsPath: string;
  bytes: number;
  lastUsed: number;
}

const open = new Map<string, OpenFile>();
/** Keep at most this many NetCDFs resident; each costs its full size in wasm heap. */
const MAX_OPEN = 3;

const keyOf = (siteId: string, relPath: string) => `${siteId}::${relPath}`;

function evictIfNeeded() {
  while (open.size > MAX_OPEN) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of open) {
      if (v.lastUsed < oldest) {
        oldest = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) return;
    const entry = open.get(oldestKey)!;
    try {
      entry.file.close();
    } catch {
      /* already closed */
    }
    try {
      (globalThis as unknown as { __h5fs?: AnyModule['FS'] }).__h5fs?.unlink(entry.vfsPath);
    } catch {
      /* best effort */
    }
    open.delete(oldestKey);
  }
}

async function getFile(ctx: HandlerContext, siteId: string, relPath: string): Promise<h5wasm.File> {
  const key = keyOf(siteId, relPath);
  const existing = open.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.file;
  }

  ctx.progress({ phase: 'Loading NetCDF reader', fraction: null });
  const mod = await h5ready();
  (globalThis as unknown as { __h5fs?: AnyModule['FS'] }).__h5fs = mod.FS;
  ctx.throwIfCancelled();

  ctx.progress({ phase: 'Reading file', fraction: null, detail: relPath });
  const blob = await readSiteFile(siteId, relPath);
  const buf = new Uint8Array(await blob.arrayBuffer());
  ctx.throwIfCancelled();

  const magic = buf.subarray(0, 4);
  const isHdf5 = magic[0] === 0x89 && magic[1] === 0x48 && magic[2] === 0x44 && magic[3] === 0x46;
  if (!isHdf5) {
    const isClassic = magic[0] === 0x43 && magic[1] === 0x44 && magic[2] === 0x46; // "CDF"
    throw new Error(
      isClassic
        ? `"${relPath}" is a classic NetCDF-3 file. WetLSP exports are NetCDF-4 (HDF5); this file cannot be read.`
        : `"${relPath}" is not a NetCDF-4/HDF5 file.`,
    );
  }

  const vfsPath = `/${key.replace(/[^\w.-]/g, '_')}`;
  mod.FS.writeFile(vfsPath, buf);
  const file = new h5wasm.File(vfsPath, 'r');
  open.set(key, { file, vfsPath, bytes: buf.byteLength, lastUsed: Date.now() });
  evictIfNeeded();
  return file;
}

function attrNumber(ds: h5wasm.Dataset, names: string[]): number | null {
  for (const name of names) {
    const a = ds.attrs[name];
    if (!a) continue;
    const v = a.value;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (ArrayBuffer.isView(v) && (v as { length: number }).length > 0) {
      return Number((v as unknown as ArrayLike<number>)[0]);
    }
    if (Array.isArray(v) && v.length > 0) return Number(v[0]);
  }
  return null;
}

function attrString(entity: h5wasm.Dataset | h5wasm.Group, names: string[]): string | null {
  for (const name of names) {
    const a = entity.attrs[name];
    if (!a) continue;
    const v = a.value;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return null;
}

function globalAttrs(file: h5wasm.File): GlobalAttrs {
  const out: GlobalAttrs = {};
  for (const name of ['title', 'software_repository', 'product_version']) {
    out[name] = attrString(file, [name]) ?? undefined;
  }
  return out;
}

function toFloat64(data: unknown): Float64Array | null {
  if (ArrayBuffer.isView(data)) {
    const arr = data as unknown as ArrayLike<number>;
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]);
    return out;
  }
  if (Array.isArray(data)) return Float64Array.from(data.map(Number));
  return null;
}

function describeVariables(file: h5wasm.File): {
  variables: NetcdfVariable[];
  xLen: number;
  yLen: number;
  xRange: [number, number] | null;
  yRange: [number, number] | null;
  geoTransform: number[] | null;
  spatialRef: string | null;
} {
  const names = file.keys();
  let xLen = 0;
  let yLen = 0;
  let xRange: [number, number] | null = null;
  let yRange: [number, number] | null = null;

  const coord = (name: string): { len: number; range: [number, number] | null } => {
    if (!names.includes(name)) return { len: 0, range: null };
    const ds = file.get(name) as h5wasm.Dataset;
    const vals = toFloat64(ds.value);
    if (!vals || vals.length === 0) return { len: 0, range: null };
    return { len: vals.length, range: [vals[0], vals[vals.length - 1]] };
  };
  ({ len: xLen, range: xRange } = coord('x'));
  ({ len: yLen, range: yRange } = coord('y'));

  let geoTransform: number[] | null = null;
  let spatialRef: string | null = null;
  for (const gridMapping of ['transverse_mercator', 'crs', 'spatial_ref', 'lambert_conformal_conic']) {
    if (!names.includes(gridMapping)) continue;
    const ds = file.get(gridMapping) as h5wasm.Dataset;
    spatialRef ??= attrString(ds, ['spatial_ref', 'crs_wkt', 'esri_pe_string']);
    const gt = attrString(ds, ['GeoTransform']);
    if (gt) {
      const nums = gt.trim().split(/\s+/).map(Number);
      if (nums.length === 6 && nums.every(Number.isFinite)) geoTransform = nums;
    }
    if (spatialRef) break;
  }

  const variables: NetcdfVariable[] = [];
  for (const name of names) {
    if (name === 'x' || name === 'y' || name === 'transverse_mercator' || name === 'crs') continue;
    let ds: h5wasm.Dataset;
    try {
      const entity = file.get(name);
      if (!(entity instanceof h5wasm.Dataset)) continue;
      ds = entity;
    } catch {
      continue;
    }
    const shape = ds.shape ?? [];
    if (shape.length < 2) continue;

    const info = layerInfo(name);
    variables.push({
      name,
      longName: attrString(ds, ['long_name', 'description']) ?? info.description,
      units: attrString(ds, ['units']) ?? info.units,
      scale: attrNumber(ds, ['scale', 'scale_factor']) ?? info.scale ?? 1,
      offset: attrNumber(ds, ['offset', 'add_offset']) ?? 0,
      fillValue: attrNumber(ds, ['_FillValue', 'missing_value']) ?? 32767,
      validMin: attrNumber(ds, ['valid_min']) ?? (Number.isFinite(info.validMin) ? info.validMin : null),
      validMax: attrNumber(ds, ['valid_max']) ?? (Number.isFinite(info.validMax) ? info.validMax : null),
      shape,
    });
  }

  return { variables, xLen, yLen, xRange, yRange, geoTransform, spatialRef };
}

/**
 * Mean-pool (continuous layers) or modal-pool (QA classes, where averaging class
 * labels would be meaningless) down to the requested cell budget.
 */
function pool(
  src: Float32Array,
  width: number,
  height: number,
  factor: number,
  discrete: boolean,
): { values: Float32Array; width: number; height: number } {
  if (factor <= 1) return { values: src, width, height };
  const ow = Math.ceil(width / factor);
  const oh = Math.ceil(height / factor);
  const out = new Float32Array(ow * oh);

  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * factor;
    const y1 = Math.min(height, y0 + factor);
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * factor;
      const x1 = Math.min(width, x0 + factor);
      if (discrete) {
        const counts = new Map<number, number>();
        let bestVal = Number.NaN;
        let bestCount = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const v = src[y * width + x];
            if (!Number.isFinite(v)) continue;
            const c = (counts.get(v) ?? 0) + 1;
            counts.set(v, c);
            if (c > bestCount) {
              bestCount = c;
              bestVal = v;
            }
          }
        }
        out[oy * ow + ox] = bestVal;
      } else {
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const v = src[y * width + x];
            if (Number.isFinite(v)) {
              sum += v;
              n++;
            }
          }
        }
        out[oy * ow + ox] = n === 0 ? Number.NaN : sum / n;
      }
    }
  }
  return { values: out, width: ow, height: oh };
}

const handlers = {
  async info(ctx: HandlerContext, siteId: string, relPath: string, year: number): Promise<NetcdfInfo> {
    const file = await getFile(ctx, siteId, relPath);
    const d = describeVariables(file);
    // Grid dims come from the coordinate variables when present, otherwise from
    // the first data variable's own shape.
    const firstShape = d.variables[0]?.shape ?? [];
    const height = d.yLen || firstShape[firstShape.length - 2] || 0;
    const width = d.xLen || firstShape[firstShape.length - 1] || 0;
    return {
      siteId,
      year,
      variables: d.variables,
      width,
      height,
      geoTransform: d.geoTransform,
      spatialRef: d.spatialRef,
      xRange: d.xRange,
      yRange: d.yRange,
    };
  },

  async readLayer(
    ctx: HandlerContext,
    siteId: string,
    relPath: string,
    layer: string,
    maxCells: number,
  ): Promise<RasterSlice> {
    const file = await getFile(ctx, siteId, relPath);
    ctx.throwIfCancelled();

    const entity = file.get(layer);
    if (!(entity instanceof h5wasm.Dataset)) {
      throw new Error(`Layer "${layer}" is not in this file.`);
    }
    const ds = entity;
    const shape = ds.shape ?? [];
    const height = shape[shape.length - 2] ?? 0;
    const width = shape[shape.length - 1] ?? 0;
    if (!width || !height) throw new Error(`Layer "${layer}" has no 2-D grid.`);

    const info = layerInfo(layer);
    const fillValue = attrNumber(ds, ['_FillValue', 'missing_value']) ?? 32767;
    const scale = attrNumber(ds, ['scale', 'scale_factor']) ?? info.scale ?? 1;
    const offset = attrNumber(ds, ['offset', 'add_offset']) ?? 0;
    const validMin = attrNumber(ds, ['valid_min']);
    const validMax = attrNumber(ds, ['valid_max']);

    ctx.progress({ phase: 'Reading layer', fraction: null, detail: layer });
    // A leading singleton dimension (time) is common; take the first slab.
    const raw =
      shape.length > 2
        ? ds.slice(shape.map((_, i) => (i < shape.length - 2 ? [0, 1] : [])) as [][])
        : ds.value;
    const src = raw as unknown as ArrayLike<number> | null;
    if (!src) throw new Error(`Layer "${layer}" returned no data.`);
    ctx.throwIfCancelled();

    const n = width * height;
    const values = new Float32Array(n);
    let min = Infinity;
    let max = -Infinity;
    let finiteCount = 0;
    for (let i = 0; i < n; i++) {
      const rawV = Number(src[i]);
      // Mask fill first, then valid range, then apply scale + offset.
      if (rawV === fillValue || !Number.isFinite(rawV)) {
        values[i] = Number.NaN;
        continue;
      }
      if ((validMin !== null && rawV < validMin) || (validMax !== null && rawV > validMax)) {
        values[i] = Number.NaN;
        continue;
      }
      const v = rawV * scale + offset;
      values[i] = v;
      finiteCount++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (finiteCount === 0) {
      min = 0;
      max = 0;
    }
    // Everything downstream draws row 0 at the top (north). Reorder before
    // pooling so the pooled blocks line up with the northern edge.
    if (rowsStoredSouthUp(globalAttrs(file))) flipRowsInPlace(values, width, height);

    const budget = Math.max(1000, maxCells);
    const factor = n <= budget ? 1 : Math.ceil(Math.sqrt(n / budget));
    const discrete = phenometricScaleType(layer) === 'qa';
    ctx.progress({ phase: 'Downsampling', fraction: null, detail: `${factor}× mean pool` });
    const pooled = pool(values, width, height, factor, discrete);
    ctx.throwIfCancelled();

    // Georeference the grid from the coordinate variables (preferred: they are
    // cell centres) or the GeoTransform (cell edges).
    const d = describeVariables(file);
    let bboxProjected: [number, number, number, number] | null = null;
    if (d.xRange && d.yRange) {
      const halfX = d.xLen > 1 ? Math.abs(d.xRange[1] - d.xRange[0]) / (2 * (d.xLen - 1)) : 0;
      const halfY = d.yLen > 1 ? Math.abs(d.yRange[1] - d.yRange[0]) / (2 * (d.yLen - 1)) : 0;
      bboxProjected = [
        Math.min(d.xRange[0], d.xRange[1]) - halfX,
        Math.min(d.yRange[0], d.yRange[1]) - halfY,
        Math.max(d.xRange[0], d.xRange[1]) + halfX,
        Math.max(d.yRange[0], d.yRange[1]) + halfY,
      ];
    } else if (d.geoTransform) {
      const [ox, px, , oy, , py] = d.geoTransform;
      const x1 = ox + px * width;
      const y1 = oy + py * height;
      bboxProjected = [Math.min(ox, x1), Math.min(oy, y1), Math.max(ox, x1), Math.max(oy, y1)];
    }

    let bboxWgs84: [number, number, number, number] | null = null;
    if (bboxProjected && d.spatialRef) {
      try {
        const { forward } = makeToWgs84(d.spatialRef);
        const corners = [
          forward(bboxProjected[0], bboxProjected[1]),
          forward(bboxProjected[2], bboxProjected[1]),
          forward(bboxProjected[2], bboxProjected[3]),
          forward(bboxProjected[0], bboxProjected[3]),
        ];
        const lons = corners.map((c) => c[0]);
        const lats = corners.map((c) => c[1]);
        bboxWgs84 = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
      } catch {
        bboxWgs84 = null;
      }
    }

    return {
      layer,
      width: pooled.width,
      height: pooled.height,
      values: pooled.values,
      min: finiteCount ? min : 0,
      max: finiteCount ? max : 0,
      finiteCount,
      bboxProjected,
      bboxWgs84,
      downsample: factor,
    };
  },

  async epsgOf(ctx: HandlerContext, siteId: string, relPath: string): Promise<number | null> {
    const file = await getFile(ctx, siteId, relPath);
    const d = describeVariables(file);
    return d.spatialRef ? epsgFromWkt(d.spatialRef) : null;
  },

  async release(_ctx: HandlerContext, siteId: string, relPath?: string): Promise<void> {
    for (const [k, v] of [...open]) {
      if (!k.startsWith(`${siteId}::`)) continue;
      if (relPath && k !== keyOf(siteId, relPath)) continue;
      try {
        v.file.close();
      } catch {
        /* already closed */
      }
      open.delete(k);
    }
  },
};

serve(handlers as unknown as Record<string, (ctx: HandlerContext, ...args: never[]) => unknown>);
