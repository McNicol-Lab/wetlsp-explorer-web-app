/**
 * Decode one WetLSP annual NetCDF-4 (an HDF5 file opened with h5wasm) into
 * full-resolution, north-up variable arrays plus its grid. Shared by the
 * analysis worker and the real-data tests, so both read files identically.
 */
import * as h5wasm from 'h5wasm';
import { REQUIRED_VARIABLES } from './constants';
import type { VariableData, YearInput } from './features';
import { flipRows, resolveGrid, type GridSpec } from './grid';
import { rowsStoredSouthUp } from '@/lib/orientation';

function attrNumber(ds: h5wasm.Dataset, names: string[]): number | null {
  for (const name of names) {
    const a = ds.attrs[name];
    if (!a) continue;
    const v = a.value as unknown;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (ArrayBuffer.isView(v) && (v as unknown as ArrayLike<number>).length > 0) return Number((v as unknown as ArrayLike<number>)[0]);
    if (Array.isArray(v) && v.length > 0) return Number(v[0]);
  }
  return null;
}

function attrString(entity: h5wasm.Dataset | h5wasm.Group, names: string[]): string | null {
  for (const name of names) {
    const a = entity.attrs[name];
    if (!a) continue;
    const v = a.value as unknown;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return null;
}

function numbers(ds: h5wasm.Dataset): Float64Array | null {
  const v = ds.value as unknown;
  if (ArrayBuffer.isView(v)) return Float64Array.from(v as unknown as ArrayLike<number>, Number);
  if (Array.isArray(v)) return Float64Array.from(v.map(Number));
  return null;
}

function dataset(file: h5wasm.File, name: string): h5wasm.Dataset | null {
  try {
    const e = file.get(name);
    return e instanceof h5wasm.Dataset ? e : null;
  } catch {
    return null;
  }
}

/** Typed array with a slice() that returns the same type, for in-place row flips. */
type Grid = Int16Array | Int32Array | Uint8Array | Uint16Array | Float32Array | Float64Array | Int8Array | Uint32Array;

export interface DecodedYear {
  input: YearInput;
  grid: GridSpec;
  /** Variables found but not 2-D on the grid, and similar notes. */
  notes: string[];
}

export function decodeYear(file: h5wasm.File, year: number): DecodedYear {
  const names = file.keys();
  const notes: string[] = [];
  const globals: Record<string, string | undefined> = {};
  for (const k of ['title', 'software_repository', 'product_version']) globals[k] = attrString(file, [k]) ?? undefined;

  // Grid size from the first required variable that exists.
  let width = 0;
  let height = 0;
  for (const v of REQUIRED_VARIABLES) {
    const ds = dataset(file, v);
    const shape = ds?.shape ?? [];
    if (shape.length >= 2) {
      height = shape[shape.length - 2];
      width = shape[shape.length - 1];
      break;
    }
  }
  if (!width || !height) throw new Error(`${year}: no phenometric variable with a 2-D grid was found.`);

  // CRS and GeoTransform: the variables' grid_mapping, then the usual names.
  const qa = dataset(file, 'QA');
  const mapping = [qa ? attrString(qa, ['grid_mapping']) : null, 'transverse_mercator', 'crs', 'spatial_ref', 'lambert_conformal_conic']
    .filter((n): n is string => Boolean(n) && names.includes(n!));
  let crsWkt: string | null = null;
  let geoTransform: number[] | null = null;
  for (const m of mapping) {
    const ds = dataset(file, m);
    if (!ds) continue;
    crsWkt ??= attrString(ds, ['spatial_ref', 'crs_wkt', 'esri_pe_string']);
    const gt = attrString(ds, ['GeoTransform']);
    if (gt && !geoTransform) {
      const nums = gt.trim().split(/\s+/).map(Number);
      if (nums.length === 6 && nums.every(Number.isFinite)) geoTransform = nums;
    }
    if (crsWkt) break;
  }
  const xs = names.includes('x') ? dataset(file, 'x') : null;
  const ys = names.includes('y') ? dataset(file, 'y') : null;
  const grid = resolveGrid({
    width,
    height,
    x: xs ? numbers(xs) : null,
    y: ys ? numbers(ys) : null,
    geoTransform,
    crsWkt,
    rowsReversed: rowsStoredSouthUp(globals),
  });

  const vars: Record<string, VariableData> = {};
  for (const name of REQUIRED_VARIABLES) {
    const ds = dataset(file, name);
    if (!ds) continue;
    const shape = ds.shape ?? [];
    if (shape.length < 2 || shape[shape.length - 2] !== height || shape[shape.length - 1] !== width) {
      notes.push(`${name} is not on the ${width}×${height} grid.`);
      continue;
    }
    // A leading singleton dimension (time) is common; take its first slab.
    const raw = (shape.length > 2 ? ds.slice(shape.map((_, i) => (i < shape.length - 2 ? [0, 1] : [])) as [][]) : ds.value) as unknown;
    if (!ArrayBuffer.isView(raw)) {
      notes.push(`${name} could not be read as numbers.`);
      continue;
    }
    const values = raw as unknown as Grid;
    if (grid.flipRows) flipRows(values, width, height);
    vars[name] = {
      values,
      fill: attrNumber(ds, ['_FillValue', 'missing_value']),
      validMin: attrNumber(ds, ['valid_min']),
      validMax: attrNumber(ds, ['valid_max']),
      scale: attrNumber(ds, ['scale', 'scale_factor']) ?? 1,
      offset: attrNumber(ds, ['offset', 'add_offset']) ?? 0,
    };
  }
  return { input: { year, width, height, vars }, grid, notes };
}

/** SHA-256 of a file's bytes, hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type H5Module = { FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void } };
let counter = 0;

/** Open bytes as an h5wasm File, run `fn`, and always release the in-memory copy. */
export async function withH5File<T>(bytes: Uint8Array, fn: (f: h5wasm.File) => T | Promise<T>): Promise<T> {
  const mod = (await h5wasm.ready) as unknown as H5Module;
  const isHdf5 = bytes[0] === 0x89 && bytes[1] === 0x48 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (!isHdf5) throw new Error('Not a NetCDF-4 (HDF5) file.');
  const path = `/phenoclass-${Date.now()}-${counter++}.nc`;
  mod.FS.writeFile(path, bytes);
  const file = new h5wasm.File(path, 'r');
  try {
    return await fn(file);
  } finally {
    try {
      file.close();
    } catch {
      /* already closed */
    }
    try {
      mod.FS.unlink(path);
    } catch {
      /* best effort */
    }
  }
}
