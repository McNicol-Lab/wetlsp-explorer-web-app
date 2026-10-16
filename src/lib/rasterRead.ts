/**
 * Reads a user's raster for the Pixel Map overlay: GeoTIFF through geotiff.js,
 * NetCDF-4 through h5wasm (the same reader the phenometric views use). Runs
 * in workers/overlay.worker.ts; kept here so tests can call it directly.
 *
 * Georeferencing: a GeoTIFF's model tiepoint / pixel scale and its EPSG
 * GeoKey; a NetCDF's coordinate variables (cell centres) or GDAL
 * GeoTransform, with its CRS from the variable's `grid_mapping` (or degrees
 * when the coordinates are longitude/latitude).
 */
import { fromArrayBuffer } from 'geotiff';
import * as h5wasm from 'h5wasm';
import { layerTransform } from './crs';
import { flipRowsInPlace, rowsStoredSouthUp } from './orientation';
import { placeByCorners, poolFactor, poolMean, valueStats, type RasterOverlayData } from './overlay';
import type { ProgressEvent } from './types';

type Progress = (p: ProgressEvent) => void;

export interface ReadRasterOptions {
  /** NetCDF variable or `band N`; the first is used when absent. */
  choice?: string;
  maxCells?: number;
}

const DEFAULT_MAX_CELLS = 1_500_000;

export async function readGeoTiff(
  progress: Progress,
  name: string,
  buf: ArrayBuffer,
  opts: ReadRasterOptions,
): Promise<RasterOverlayData> {
  progress({ phase: 'Reading GeoTIFF', fraction: null, detail: name });
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  const choices = Array.from({ length: bands }, (_, i) => `band ${i + 1}`);
  const choice = opts.choice && choices.includes(opts.choice) ? opts.choice : choices[0];
  const band = choices.indexOf(choice);
  const notes: string[] = [];

  let bbox: number[];
  try {
    bbox = image.getBoundingBox();
  } catch {
    throw new Error(`${name} has no georeferencing (no tiepoint or transformation), so it cannot be placed on the map.`);
  }
  const keys = image.getGeoKeys() ?? {};
  const code = Number(keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? NaN);
  if (!Number.isFinite(code) || code === 32767) {
    throw new Error(
      `${name} uses a custom coordinate system without an EPSG code. Export it from QGIS or GDAL with an EPSG CRS (for example WGS 84 or UTM) and import it again.`,
    );
  }
  const tr = layerTransform(code, name);
  if ((image.fileDirectory as unknown as Record<string, unknown>).ModelTransformation) {
    notes.push('The file carries a model transformation; any rotation in it is ignored.');
  }

  const factor = poolFactor(width, height, opts.maxCells ?? DEFAULT_MAX_CELLS);
  const outW = Math.ceil(width / factor);
  const outH = Math.ceil(height / factor);
  progress({ phase: 'Decoding', fraction: null, detail: `${outW}×${outH}` });
  // geotiff.js resamples while decoding, so a large file never needs a full-size array.
  const data = (await image.readRasters({
    samples: [band],
    width: outW,
    height: outH,
    resampleMethod: 'nearest',
    interleave: true,
  })) as unknown as ArrayLike<number>;
  const noData = image.getGDALNoData();
  const values = new Float32Array(outW * outH);
  for (let i = 0; i < values.length; i++) {
    const v = Number(data[i]);
    values[i] = (noData !== null && v === noData) || !Number.isFinite(v) ? NaN : v;
  }
  if (factor > 1) notes.push(`Shown at 1/${factor} resolution (nearest cell) to stay responsive.`);

  const place = placeByCorners([bbox[0], bbox[1], bbox[2], bbox[3]], tr);
  return {
    name,
    format: 'GeoTIFF',
    variable: choice,
    choices,
    units: null,
    width: outW,
    height: outH,
    values,
    ...valueStats(values),
    downsample: factor,
    sourceWidth: width,
    sourceHeight: height,
    crsName: tr.name,
    epsg: tr.epsg,
    bboxProjected: [bbox[0], bbox[1], bbox[2], bbox[3]],
    corners: place.corners,
    bboxWgs84: place.bboxWgs84,
    placementErrorM: place.errorM,
    notes,
  };
}

/* ---------------------------------------------------------------- netcdf */

type H5Module = { FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void } };

function attr(entity: h5wasm.Dataset | h5wasm.Group, names: string[]): unknown {
  for (const n of names) {
    const a = entity.attrs[n];
    if (a) return a.value;
  }
  return undefined;
}

function attrNum(entity: h5wasm.Dataset, names: string[]): number | null {
  const v = attr(entity, names);
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (ArrayBuffer.isView(v) && (v as unknown as ArrayLike<number>).length) return Number((v as unknown as ArrayLike<number>)[0]);
  if (Array.isArray(v) && v.length) return Number(v[0]);
  return null;
}

function attrStr(entity: h5wasm.Dataset | h5wasm.Group, names: string[]): string | null {
  const v = attr(entity, names);
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

const COORD_NAMES = /^(x|y|lon|lat|longitude|latitude|time|crs|spatial_ref|transverse_mercator|lambert_.*|albers_.*|polar_stereographic|band|bnds|.*_bnds|.*_bounds)$/i;

function numbers(ds: h5wasm.Dataset): Float64Array | null {
  const v = ds.value as unknown;
  if (ArrayBuffer.isView(v)) return Float64Array.from(v as unknown as ArrayLike<number>, Number);
  if (Array.isArray(v)) return Float64Array.from(v.map(Number));
  return null;
}

export async function readNetcdf(
  progress: Progress,
  name: string,
  buf: ArrayBuffer,
  opts: ReadRasterOptions,
): Promise<RasterOverlayData> {
  const bytes = new Uint8Array(buf);
  const hdf5 = bytes[0] === 0x89 && bytes[1] === 0x48 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (!hdf5) {
    const classic = bytes[0] === 0x43 && bytes[1] === 0x44 && bytes[2] === 0x46;
    throw new Error(
      classic
        ? `${name} is a classic NetCDF-3 file, which this reader cannot open. Convert it with \`nccopy -k nc4 in.nc out.nc\`, or export a GeoTIFF.`
        : `${name} is not a NetCDF-4 (HDF5) file.`,
    );
  }
  progress({ phase: 'Reading NetCDF', fraction: null, detail: name });
  const mod = (await h5wasm.ready) as unknown as H5Module;
  const vfs = `/overlay-${Date.now()}.nc`;
  mod.FS.writeFile(vfs, bytes);
  const file = new h5wasm.File(vfs, 'r');
  try {
    const keys = file.keys();
    const datasets = new Map<string, h5wasm.Dataset>();
    for (const k of keys) {
      try {
        const e = file.get(k);
        if (e instanceof h5wasm.Dataset) datasets.set(k, e);
      } catch {
        /* unreadable entry */
      }
    }
    const choices = [...datasets].filter(([k, d]) => (d.shape?.length ?? 0) >= 2 && !COORD_NAMES.test(k)).map(([k]) => k);
    if (choices.length === 0) throw new Error(`${name} has no 2-D grid variable to draw.`);
    const variable = opts.choice && choices.includes(opts.choice) ? opts.choice : choices[0];
    const ds = datasets.get(variable)!;
    const shape = ds.shape!;
    const height = shape[shape.length - 2];
    const width = shape[shape.length - 1];
    const notes: string[] = [];
    if (shape.length > 2) notes.push(`${variable} has ${shape.length} dimensions; the first slice of the leading ones is shown.`);

    // Coordinates: cell centres from x/y or lon/lat with matching lengths.
    const coord = (names: string[], len: number) => {
      for (const n of names) {
        const d = datasets.get(n);
        if (d && d.shape?.length === 1 && d.shape[0] === len) return { name: n, values: numbers(d) };
      }
      return null;
    };
    const xs = coord(['x', 'lon', 'longitude'], width);
    const ys = coord(['y', 'lat', 'latitude'], height);
    const degrees = Boolean(xs && /^lon/.test(xs.name) && ys && /^lat/.test(ys.name));

    // CRS: the variable's grid_mapping, then the usual grid-mapping names.
    let crs: string | number | null = null;
    let geoTransform: number[] | null = null;
    const mappingNames = [attrStr(ds, ['grid_mapping']), 'crs', 'spatial_ref', 'transverse_mercator'].filter(Boolean) as string[];
    for (const m of mappingNames) {
      const g = datasets.get(m);
      if (!g) continue;
      crs ??= attrStr(g, ['spatial_ref', 'crs_wkt', 'esri_pe_string']) ?? attrNum(g, ['epsg_code', 'EPSG']);
      const gt = attrStr(g, ['GeoTransform']);
      if (gt) {
        const nums = gt.trim().split(/\s+/).map(Number);
        if (nums.length === 6 && nums.every(Number.isFinite)) geoTransform = nums;
      }
      if (crs) break;
    }
    if (!crs && degrees) crs = 4326;
    const tr = layerTransform(crs, name);

    let bbox: [number, number, number, number];
    let yAscending = false;
    if (xs?.values && ys?.values && xs.values.length > 1 && ys.values.length > 1) {
      const hx = Math.abs(xs.values[1] - xs.values[0]) / 2;
      const hy = Math.abs(ys.values[1] - ys.values[0]) / 2;
      yAscending = ys.values[ys.values.length - 1] > ys.values[0];
      bbox = [
        Math.min(xs.values[0], xs.values[width - 1]) - hx,
        Math.min(ys.values[0], ys.values[height - 1]) - hy,
        Math.max(xs.values[0], xs.values[width - 1]) + hx,
        Math.max(ys.values[0], ys.values[height - 1]) + hy,
      ];
    } else if (geoTransform) {
      const [ox, px, , oy, , py] = geoTransform;
      yAscending = py > 0;
      bbox = [Math.min(ox, ox + px * width), Math.min(oy, oy + py * height), Math.max(ox, ox + px * width), Math.max(oy, oy + py * height)];
    } else {
      throw new Error(`${name}: ${variable} has no x/y (or lon/lat) coordinates or GeoTransform, so it cannot be placed.`);
    }

    progress({ phase: 'Reading variable', fraction: null, detail: variable });
    const raw = (shape.length > 2
      ? ds.slice(shape.map((_, i) => (i < shape.length - 2 ? [0, 1] : [])) as [][])
      : ds.value) as unknown as ArrayLike<number>;
    const fill = attrNum(ds, ['_FillValue', 'missing_value']);
    const scale = attrNum(ds, ['scale_factor', 'scale']) ?? 1;
    const offset = attrNum(ds, ['add_offset', 'offset']) ?? 0;
    const full = new Float32Array(width * height);
    for (let i = 0; i < full.length; i++) {
      const v = Number(raw[i]);
      full[i] = (fill !== null && v === fill) || !Number.isFinite(v) ? NaN : v * scale + offset;
    }

    // Row 0 must be the northern edge. Ascending y (south first) is common in
    // NetCDF; WetLSP v001 files are south-up despite descending coordinates.
    const globals: Record<string, string | undefined> = {};
    for (const g of ['title', 'software_repository', 'product_version']) globals[g] = attrStr(file, [g]) ?? undefined;
    if (yAscending || rowsStoredSouthUp(globals)) flipRowsInPlace(full, width, height);

    const factor = poolFactor(width, height, opts.maxCells ?? DEFAULT_MAX_CELLS);
    const pooled = poolMean(full, width, height, factor);
    if (factor > 1) notes.push(`Shown at 1/${factor} resolution (block means) to stay responsive.`);
    const place = placeByCorners(bbox, tr);
    return {
      name,
      format: 'NetCDF',
      variable,
      choices,
      units: attrStr(ds, ['units']),
      width: pooled.width,
      height: pooled.height,
      values: pooled.values,
      ...valueStats(pooled.values),
      downsample: factor,
      sourceWidth: width,
      sourceHeight: height,
      crsName: tr.name,
      epsg: tr.epsg,
      bboxProjected: bbox,
      corners: place.corners,
      bboxWgs84: place.bboxWgs84,
      placementErrorM: place.errorM,
      notes,
    };
  } finally {
    try {
      file.close();
      mod.FS.unlink(vfs);
    } catch {
      /* best effort */
    }
  }
}

/** Read a GeoTIFF or NetCDF by its file name. */
export function readRaster(name: string, buf: ArrayBuffer, opts: ReadRasterOptions = {}, progress: Progress = () => undefined): Promise<RasterOverlayData> {
  if (/\.nc4?$/i.test(name)) return readNetcdf(progress, name, buf, opts);
  if (/\.tiff?$/i.test(name)) return readGeoTiff(progress, name, buf, opts);
  return Promise.reject(new Error(`${name}: only GeoTIFF (.tif, .tiff) and NetCDF (.nc) rasters can be overlaid.`));
}
