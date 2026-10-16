/**
 * ESRI shapefile reader for polygon layers (`.shp` + `.dbf` + `.prj`).
 *
 * Written against the ESRI Shapefile Technical Description (1998) and the
 * dBASE III table format, rather than pulling in a library, because the app
 * needs only polygons and reads them in a worker. Supported shape types are
 * Polygon (5), PolygonZ (15) and PolygonM (25); Z and M values are ignored.
 *
 * A record's rings are kept as they are stored. Point-in-polygon uses the
 * even-odd rule over all of a record's rings, which treats holes and the
 * parts of a multipolygon correctly without classifying rings first. Rings
 * are only grouped into outer + holes for drawing (`polygonsOf`).
 */

export const POLYGON_TYPES = new Set([5, 15, 25]);

export interface ShapeRecord {
  /** 0-based position in the file, which is also the `.dbf` row. */
  index: number;
  /** [xmin, ymin, xmax, ymax] in the layer's own CRS. */
  bbox: [number, number, number, number];
  /** Flat `[x0, y0, x1, y1, …]` rings, closed (last point = first). */
  rings: Float64Array[];
}

export interface ShpHeader {
  shapeType: number;
  bbox: [number, number, number, number];
  /** File length in bytes, from the header. */
  length: number;
}

const SHP_MAGIC = 9994;

export function shapeTypeName(type: number): string {
  return (
    {
      0: 'Null',
      1: 'Point',
      3: 'Polyline',
      5: 'Polygon',
      8: 'MultiPoint',
      11: 'PointZ',
      13: 'PolylineZ',
      15: 'PolygonZ',
      18: 'MultiPointZ',
      21: 'PointM',
      23: 'PolylineM',
      25: 'PolygonM',
      28: 'MultiPointM',
      31: 'MultiPatch',
    } as Record<number, string>
  )[type] ?? `type ${type}`;
}

export function readShpHeader(buf: ArrayBuffer): ShpHeader {
  if (buf.byteLength < 100) throw new Error('This .shp file is too short to be a shapefile.');
  const v = new DataView(buf);
  if (v.getInt32(0, false) !== SHP_MAGIC) throw new Error('This is not an ESRI .shp file (bad file code).');
  return {
    length: v.getInt32(24, false) * 2,
    shapeType: v.getInt32(32, true),
    bbox: [v.getFloat64(36, true), v.getFloat64(44, true), v.getFloat64(52, true), v.getFloat64(60, true)],
  };
}

/**
 * Every polygon record. `keep(bbox)` can reject a record from its bounding
 * box before its points are copied, which is how a 9,600-polygon watershed
 * layer is cut down to the handful of polygons over one site.
 */
export function readShpPolygons(
  buf: ArrayBuffer,
  keep: (bbox: [number, number, number, number]) => boolean = () => true,
): { header: ShpHeader; records: ShapeRecord[]; total: number } {
  const header = readShpHeader(buf);
  if (!POLYGON_TYPES.has(header.shapeType) && header.shapeType !== 0) {
    throw new Error(
      `This shapefile holds ${shapeTypeName(header.shapeType)} features. Only polygon layers can become regions.`,
    );
  }
  const v = new DataView(buf);
  const end = Math.min(buf.byteLength, header.length || buf.byteLength);
  const records: ShapeRecord[] = [];
  let index = 0;
  let off = 100;
  while (off + 8 <= end) {
    const contentBytes = v.getInt32(off + 4, false) * 2;
    const rec = off + 8;
    off = rec + contentBytes;
    const i = index++;
    if (contentBytes < 4 || rec + contentBytes > end) continue;
    const type = v.getInt32(rec, true);
    if (type === 0 || !POLYGON_TYPES.has(type)) continue; // null shape
    const bbox: [number, number, number, number] = [
      v.getFloat64(rec + 4, true),
      v.getFloat64(rec + 12, true),
      v.getFloat64(rec + 20, true),
      v.getFloat64(rec + 28, true),
    ];
    if (!keep(bbox)) continue;
    const numParts = v.getInt32(rec + 36, true);
    const numPoints = v.getInt32(rec + 40, true);
    const partsAt = rec + 44;
    const pointsAt = partsAt + numParts * 4;
    if (numParts <= 0 || numPoints <= 0 || pointsAt + numPoints * 16 > rec + contentBytes) continue;
    const rings: Float64Array[] = [];
    for (let p = 0; p < numParts; p++) {
      const from = v.getInt32(partsAt + p * 4, true);
      const to = p + 1 < numParts ? v.getInt32(partsAt + (p + 1) * 4, true) : numPoints;
      if (to - from < 3) continue;
      const ring = new Float64Array((to - from) * 2);
      for (let k = from, j = 0; k < to; k++) {
        ring[j++] = v.getFloat64(pointsAt + k * 16, true);
        ring[j++] = v.getFloat64(pointsAt + k * 16 + 8, true);
      }
      rings.push(ring);
    }
    if (rings.length) records.push({ index: i, bbox, rings });
  }
  return { header, records, total: index };
}

/* -------------------------------------------------------------------- dbf */

export interface DbfField {
  name: string;
  type: string;
  length: number;
  decimals: number;
}

export interface DbfTable {
  fields: DbfField[];
  count: number;
  /** One row's values, or null when the row is out of range or deleted. */
  row(index: number): Record<string, string | number | null> | null;
}

/** Text decoder for the `.cpg` code page; UTF-8 when absent or unknown. */
function decoderFor(cpg?: string | null): TextDecoder {
  const label = (cpg ?? '').trim().toLowerCase();
  const map: Record<string, string> = {
    '': 'utf-8',
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    '1252': 'windows-1252',
    ansi_1252: 'windows-1252',
    'windows-1252': 'windows-1252',
    '88591': 'iso-8859-1',
    'iso-8859-1': 'iso-8859-1',
    latin1: 'iso-8859-1',
  };
  try {
    return new TextDecoder(map[label] ?? label);
  } catch {
    return new TextDecoder('utf-8');
  }
}

export function readDbf(buf: ArrayBuffer, cpg?: string | null): DbfTable {
  const v = new DataView(buf);
  if (buf.byteLength < 32) throw new Error('This .dbf file is too short to be a dBASE table.');
  const count = v.getUint32(4, true);
  const headerBytes = v.getUint16(8, true);
  const recordBytes = v.getUint16(10, true);
  const dec = decoderFor(cpg);
  const ascii = new TextDecoder('ascii');
  const fields: DbfField[] = [];
  for (let off = 32; off + 32 <= headerBytes && v.getUint8(off) !== 0x0d; off += 32) {
    const nameBytes = new Uint8Array(buf, off, 11);
    const nul = nameBytes.indexOf(0);
    fields.push({
      name: ascii.decode(nameBytes.subarray(0, nul < 0 ? 11 : nul)).trim(),
      type: String.fromCharCode(v.getUint8(off + 11)),
      length: v.getUint8(off + 16),
      decimals: v.getUint8(off + 17),
    });
  }
  return {
    fields,
    count,
    row(index) {
      if (index < 0 || index >= count) return null;
      const start = headerBytes + index * recordBytes;
      if (start + recordBytes > buf.byteLength) return null;
      if (v.getUint8(start) === 0x2a) return null; // '*' marks a deleted row
      const out: Record<string, string | number | null> = {};
      let off = start + 1;
      for (const f of fields) {
        const text = dec.decode(new Uint8Array(buf, off, f.length)).replace(/\0/g, '').trim();
        off += f.length;
        if (f.type === 'N' || f.type === 'F') {
          const n = text === '' || /^\*+$/.test(text) ? NaN : Number(text);
          out[f.name] = Number.isFinite(n) ? n : null;
        } else if (f.type === 'L') {
          out[f.name] = /^[YyTt]$/.test(text) ? 'true' : /^[NnFf]$/.test(text) ? 'false' : null;
        } else {
          out[f.name] = text === '' ? null : text;
        }
      }
      return out;
    },
  };
}

/* ----------------------------------------------------------------- rings */

/** Even-odd point-in-polygon over every ring of one record. */
export function pointInRings(px: number, py: number, rings: Float64Array[]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2];
      const yi = ring[i * 2 + 1];
      const xj = ring[j * 2];
      const yj = ring[j * 2 + 1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * `pointInRings` for many points against one large polygon. A ray cast only
 * crosses edges whose y-span contains the point, so edges are bucketed into
 * horizontal bands and a point tests only its band's edges. NWI polygons
 * run to tens of thousands of vertices; without the index, one of them over
 * 18,000 pixels took three seconds.
 */
export function ringTester(rings: Float64Array[]): (px: number, py: number) => boolean {
  let edges = 0;
  for (const r of rings) edges += r.length / 2;
  if (edges <= 64) return (px, py) => pointInRings(px, py, rings);

  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < minY) minY = r[i];
      if (r[i] > maxY) maxY = r[i];
    }
  }
  const bands = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(edges) * 2)));
  const height = (maxY - minY) / bands || 1;
  const band = (y: number) => Math.min(bands - 1, Math.max(0, Math.floor((y - minY) / height)));

  // Two passes into flat arrays: count per band, then fill.
  const counts = new Uint32Array(bands + 1);
  const each = (fn: (x1: number, y1: number, x2: number, y2: number) => void) => {
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) fn(r[j * 2], r[j * 2 + 1], r[i * 2], r[i * 2 + 1]);
    }
  };
  each((_x1, y1, _x2, y2) => {
    if (y1 === y2) return; // horizontal edges never cross a horizontal ray
    for (let b = band(Math.min(y1, y2)), e = band(Math.max(y1, y2)); b <= e; b++) counts[b + 1]++;
  });
  for (let b = 0; b < bands; b++) counts[b + 1] += counts[b];
  const coords = new Float64Array(counts[bands] * 4);
  const fill = counts.slice(0, bands);
  each((x1, y1, x2, y2) => {
    if (y1 === y2) return;
    for (let b = band(Math.min(y1, y2)), e = band(Math.max(y1, y2)); b <= e; b++) {
      const k = fill[b]++ * 4;
      coords[k] = x1;
      coords[k + 1] = y1;
      coords[k + 2] = x2;
      coords[k + 3] = y2;
    }
  });

  return (px, py) => {
    if (py < minY || py > maxY) return false;
    const b = band(py);
    let inside = false;
    for (let k = counts[b] * 4, end = counts[b + 1] * 4; k < end; k += 4) {
      const xj = coords[k];
      const yj = coords[k + 1];
      const xi = coords[k + 2];
      const yi = coords[k + 3];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

/** Twice the signed area; negative is clockwise (y up), the shapefile outer ring. */
export function signedArea2(ring: Float64Array): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    // Edge j -> i: (xj - xi)(yj + yi) sums to +2·area counter-clockwise.
    a += (ring[j * 2] - ring[i * 2]) * (ring[j * 2 + 1] + ring[i * 2 + 1]);
  }
  return a;
}

/**
 * Rings grouped as polygons: each clockwise (outer) ring followed by the
 * counter-clockwise holes that fall inside it, as deck.gl's PolygonLayer and
 * GeoJSON expect. Orientation is read in the layer's own CRS, where the
 * shapefile rule holds. A record with no clockwise ring (written by a tool
 * that ignored the rule) has every ring treated as an outer ring.
 */
export function polygonsOf(rings: Float64Array[]): Float64Array[][] {
  const outers: Float64Array[][] = [];
  const holes: Float64Array[] = [];
  for (const r of rings) {
    if (signedArea2(r) < 0) outers.push([r]);
    else holes.push(r);
  }
  if (outers.length === 0) return rings.map((r) => [r]);
  for (const h of holes) {
    const owner = outers.find((poly) => pointInRings(h[0], h[1], [poly[0]])) ?? outers[0];
    owner.push(h);
  }
  return outers;
}

/* ---------------------------------------------------------------- layers */

export interface ShapefileParts {
  /** Base name shared by the components, e.g. `HU8_18020163_Wetlands`. */
  name: string;
  shp?: ArrayBuffer;
  shx?: ArrayBuffer;
  dbf?: ArrayBuffer;
  prj?: string;
  cpg?: string;
}

/** Group loose files (`a.shp`, `a.dbf`, `a.prj`, …) into layers by base name. */
export function groupShapefileParts(
  files: Array<{ path: string; data: ArrayBuffer }>,
): ShapefileParts[] {
  const layers = new Map<string, ShapefileParts>();
  const text = new TextDecoder('utf-8');
  for (const f of files) {
    const file = f.path.split('/').pop() ?? f.path;
    const m = file.match(/^(.*)\.(shp|shx|dbf|prj|cpg)$/i);
    if (!m || file.startsWith('._')) continue;
    const key = m[1].toLowerCase();
    const layer = layers.get(key) ?? { name: m[1] };
    const ext = m[2].toLowerCase() as 'shp' | 'shx' | 'dbf' | 'prj' | 'cpg';
    if (ext === 'prj' || ext === 'cpg') layer[ext] = text.decode(f.data);
    else layer[ext] = f.data;
    layers.set(key, layer);
  }
  return [...layers.values()].sort((a, b) => a.name.localeCompare(b.name));
}
