/**
 * A small, dependency-free GeoTIFF writer for classification rasters.
 *
 * Why not geotiff.js's writer (already a dependency, used for reading)? Its
 * 3.0.x writer caps the IFD at 1000 bytes, cannot write a ColorMap, and has no
 * signed or rotated-grid support worth relying on. This writes exactly what the
 * classification needs and is checked against GDAL (rasterio) in tests:
 *  - single band, UInt8 (class codes, counts) or Float32 (agreement);
 *  - uncompressed strips of about 64 KB, little-endian classic TIFF (< 4 GB);
 *  - PixelIsArea georeferencing: ModelPixelScale + ModelTiepoint for north-up
 *    grids, ModelTransformation when the grid is rotated;
 *  - the CRS as an EPSG code (projected or geographic); a CRS without an EPSG
 *    code is refused rather than written wrongly;
 *  - GDAL_NODATA, and an optional palette (ColorMap) for class rasters.
 */
import type { GridSpec } from './grid';

export interface GeoTiffOptions {
  grid: Pick<GridSpec, 'width' | 'height' | 'geoTransform' | 'epsg' | 'crsWkt' | 'crsName'>;
  data: Uint8Array | Float32Array;
  /** GDAL_NODATA: a number, or 'nan'. */
  nodata: number | 'nan' | null;
  /** 256 RGB triples (0–255) for a UInt8 palette raster. */
  palette?: Array<[number, number, number]>;
  description?: string;
  software?: string;
}

const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 } as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

interface Entry {
  tag: number;
  type: number;
  values: number[] | string;
}

/** Geographic EPSG codes the app knows; anything else is treated as projected. */
function isGeographic(epsg: number, wkt: string | null): boolean {
  if (epsg === 4326 || epsg === 4269 || epsg === 4258 || epsg === 4283) return true;
  return wkt ? /^\s*(GEOGCRS|GEOGCS|GEODCRS)\b/i.test(wkt) : false;
}

export function geotiffSupport(grid: Pick<GridSpec, 'epsg'>): string | null {
  if (grid.epsg === null) {
    return "GeoTIFF needs a map projection with an EPSG code, and this file doesn't have one.";
  }
  return null;
}

export function writeGeoTiff(opts: GeoTiffOptions): Uint8Array {
  const { grid, data } = opts;
  const { width, height } = grid;
  const problem = geotiffSupport(grid);
  if (problem) throw new Error(problem);
  if (data.length !== width * height) throw new Error(`Raster has ${data.length} cells; the grid has ${width * height}.`);
  const float = data instanceof Float32Array;
  const bytesPerSample = float ? 4 : 1;
  if (opts.palette && float) throw new Error('A palette needs an 8-bit raster.');
  const imageBytes = width * height * bytesPerSample;
  if (imageBytes > 3.9e9) throw new Error('This raster is too large for a classic (non-Big) TIFF.');

  const rowBytes = width * bytesPerSample;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(65536 / rowBytes)));
  const strips = Math.ceil(height / rowsPerStrip);
  const stripCounts: number[] = [];
  for (let s = 0; s < strips; s++) stripCounts.push(Math.min(rowsPerStrip, height - s * rowsPerStrip) * rowBytes);

  const g = grid.geoTransform;
  const rotated = g[2] !== 0 || g[4] !== 0;
  const geographic = isGeographic(grid.epsg!, grid.crsWkt);
  const citation = toAscii(`${grid.crsName ?? `EPSG:${grid.epsg}`}|`);
  // GeoKeyDirectory: header, then (key, location, count, value), sorted by key.
  const keys: number[][] = [
    [1024, 0, 1, geographic ? 2 : 1], // GTModelTypeGeoKey
    [1025, 0, 1, 1], // GTRasterTypeGeoKey: PixelIsArea
    [1026, 34737, citation.length, 0], // GTCitationGeoKey
    geographic ? [2048, 0, 1, grid.epsg!] : [3072, 0, 1, grid.epsg!],
  ].sort((a, b) => a[0] - b[0]);
  const geoKeys = [1, 1, 0, keys.length, ...keys.flat()];

  const entries: Entry[] = [
    { tag: 256, type: TYPE.LONG, values: [width] },
    { tag: 257, type: TYPE.LONG, values: [height] },
    { tag: 258, type: TYPE.SHORT, values: [bytesPerSample * 8] },
    { tag: 259, type: TYPE.SHORT, values: [1] },
    { tag: 262, type: TYPE.SHORT, values: [opts.palette ? 3 : 1] },
    ...(opts.description ? [{ tag: 270, type: TYPE.ASCII, values: toAscii(opts.description) }] : []),
    { tag: 273, type: TYPE.LONG, values: new Array(strips).fill(0) },
    { tag: 277, type: TYPE.SHORT, values: [1] },
    { tag: 278, type: TYPE.LONG, values: [rowsPerStrip] },
    { tag: 279, type: TYPE.LONG, values: stripCounts },
    { tag: 284, type: TYPE.SHORT, values: [1] },
    ...(opts.software ? [{ tag: 305, type: TYPE.ASCII, values: toAscii(opts.software) }] : []),
    ...(opts.palette ? [{ tag: 320, type: TYPE.SHORT, values: colorMap(opts.palette) }] : []),
    { tag: 339, type: TYPE.SHORT, values: [float ? 3 : 1] },
    ...(rotated
      ? [{ tag: 34264, type: TYPE.DOUBLE, values: [g[1], g[2], 0, g[0], g[4], g[5], 0, g[3], 0, 0, 0, 0, 0, 0, 0, 1] }]
      : [
          { tag: 33550, type: TYPE.DOUBLE, values: [g[1], -g[5], 0] },
          { tag: 33922, type: TYPE.DOUBLE, values: [0, 0, 0, g[0], g[3], 0] },
        ]),
    { tag: 34735, type: TYPE.SHORT, values: geoKeys },
    { tag: 34737, type: TYPE.ASCII, values: citation },
    ...(opts.nodata !== null ? [{ tag: 42113, type: TYPE.ASCII, values: String(opts.nodata) }] : []),
  ].sort((a, b) => a.tag - b.tag);

  // Layout: header (8) | IFD | out-of-line values | strips.
  const ifdSize = 2 + entries.length * 12 + 4;
  const valueBytes = (e: Entry) => (typeof e.values === 'string' ? e.values.length + 1 : e.values.length) * TYPE_SIZE[e.type];
  let extra = 0;
  const offsets = new Map<Entry, number>();
  const extraStart = 8 + ifdSize;
  for (const e of entries) {
    const n = valueBytes(e);
    if (n > 4) {
      offsets.set(e, extraStart + extra);
      extra += n + (n % 2); // word-align
    }
  }
  const dataStart = extraStart + extra;
  const stripOffsets: number[] = [];
  let pos = dataStart;
  for (const c of stripCounts) {
    stripOffsets.push(pos);
    pos += c;
  }
  const stripEntry = entries.find((e) => e.tag === 273)!;
  stripEntry.values = stripOffsets;

  const total = dataStart + imageBytes;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const out = new Uint8Array(buf);
  dv.setUint8(0, 0x49);
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  let p = 8;
  dv.setUint16(p, entries.length, true);
  p += 2;
  for (const e of entries) {
    const count = typeof e.values === 'string' ? e.values.length + 1 : e.values.length;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, count, true);
    const target = offsets.get(e);
    if (target === undefined) writeValues(dv, p + 8, e);
    else {
      dv.setUint32(p + 8, target, true);
      writeValues(dv, target, e);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // no next IFD

  if (float) {
    const f = data as Float32Array;
    for (let i = 0; i < f.length; i++) dv.setFloat32(dataStart + i * 4, f[i], true);
  } else {
    out.set(data as Uint8Array, dataStart);
  }
  return out;
}

const ASCII_SUBSTITUTES: Record<string, string> = { '…': '...', '−': '-', '–': '-', '—': '-', '≥': '>=', '≤': '<=', '×': 'x', '²': '2', '⁴': '4', '·': '.' };

/** TIFF ASCII fields are 7-bit: transliterate the few symbols we use, replace the rest. */
export function toAscii(s: string): string {
  return Array.from(s, (ch) => (ch.charCodeAt(0) < 128 ? ch : (ASCII_SUBSTITUTES[ch] ?? '?'))).join('');
}

function writeValues(dv: DataView, at: number, e: Entry): void {
  if (typeof e.values === 'string') {
    for (let i = 0; i < e.values.length; i++) dv.setUint8(at + i, e.values.charCodeAt(i));
    dv.setUint8(at + e.values.length, 0);
    return;
  }
  const size = TYPE_SIZE[e.type];
  e.values.forEach((v, i) => {
    const o = at + i * size;
    if (e.type === TYPE.BYTE) dv.setUint8(o, v);
    else if (e.type === TYPE.SHORT) dv.setUint16(o, v, true);
    else if (e.type === TYPE.LONG) dv.setUint32(o, v, true);
    else dv.setFloat64(o, v, true);
  });
}

/** TIFF ColorMap: all reds, then greens, then blues, each scaled to 0–65535. */
function colorMap(palette: Array<[number, number, number]>): number[] {
  const full = Array.from({ length: 256 }, (_, i) => palette[i] ?? [0, 0, 0]);
  return [0, 1, 2].flatMap((ch) => full.map((rgb) => rgb[ch] * 257));
}
