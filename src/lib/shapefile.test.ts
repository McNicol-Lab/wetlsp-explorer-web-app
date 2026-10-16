import { describe, expect, it } from 'vitest';
import {
  groupShapefileParts,
  pointInRings,
  polygonsOf,
  readDbf,
  readShpPolygons,
  ringTester,
  signedArea2,
} from './shapefile';
import { extractShapeRegions, regionDrafts, regionsToGeoJson, ringPolygon } from './regions';

/* ------------------------------------------------- tiny shapefile writer */

type Ring = number[][];

/** Clockwise square (a shapefile outer ring). */
const cw = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];
/** Counter-clockwise square (a hole). */
const ccw = (x0: number, y0: number, x1: number, y1: number): Ring => [...cw(x0, y0, x1, y1)].reverse();

function writeShp(records: Array<Ring[] | null>, type = 5): ArrayBuffer {
  const bodies = records.map((rings) => {
    if (!rings) {
      const b = new DataView(new ArrayBuffer(4));
      b.setInt32(0, 0, true);
      return b.buffer;
    }
    const pts = rings.flat();
    const b = new DataView(new ArrayBuffer(44 + rings.length * 4 + pts.length * 16));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    b.setInt32(0, type, true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.setFloat64(4 + i * 8, v, true));
    b.setInt32(36, rings.length, true);
    b.setInt32(40, pts.length, true);
    let start = 0;
    rings.forEach((r, i) => {
      b.setInt32(44 + i * 4, start, true);
      start += r.length;
    });
    pts.forEach((p, i) => {
      b.setFloat64(44 + rings.length * 4 + i * 16, p[0], true);
      b.setFloat64(44 + rings.length * 4 + i * 16 + 8, p[1], true);
    });
    return b.buffer;
  });
  const total = 100 + bodies.reduce((n, b) => n + 8 + b.byteLength, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, total / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, type, true);
  const all = records.flatMap((r) => (r ? r.flat() : []));
  if (all.length) {
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((val, i) => v.setFloat64(36 + i * 8, val, true));
  }
  let off = 100;
  bodies.forEach((b, i) => {
    v.setInt32(off, i + 1, false);
    v.setInt32(off + 4, b.byteLength / 2, false);
    out.set(new Uint8Array(b), off + 8);
    off += 8 + b.byteLength;
  });
  return out.buffer;
}

function writeDbf(fields: Array<{ name: string; type: 'C' | 'N'; length: number }>, rows: Array<Array<string | number>>, deleted: number[] = []): ArrayBuffer {
  const headerBytes = 32 + fields.length * 32 + 1;
  const recordBytes = 1 + fields.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(headerBytes + rows.length * recordBytes + 1);
  const v = new DataView(out.buffer);
  v.setUint8(0, 3);
  v.setUint32(4, rows.length, true);
  v.setUint16(8, headerBytes, true);
  v.setUint16(10, recordBytes, true);
  const enc = new TextEncoder();
  fields.forEach((f, i) => {
    out.set(enc.encode(f.name), 32 + i * 32);
    v.setUint8(32 + i * 32 + 11, f.type.charCodeAt(0));
    v.setUint8(32 + i * 32 + 16, f.length);
  });
  out[headerBytes - 1] = 0x0d;
  rows.forEach((row, r) => {
    let off = headerBytes + r * recordBytes;
    out[off++] = deleted.includes(r) ? 0x2a : 0x20;
    fields.forEach((f, i) => {
      const text = String(row[i]);
      const padded = f.type === 'N' ? text.padStart(f.length) : text.padEnd(f.length);
      out.set(enc.encode(padded).subarray(0, f.length), off);
      off += f.length;
    });
  });
  out[out.length - 1] = 0x1a;
  return out.buffer;
}

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/* ------------------------------------------------------------------ tests */

describe('readShpPolygons', () => {
  const shp = writeShp([
    [cw(0, 0, 10, 10), ccw(4, 4, 6, 6)], // square with a hole
    null, // null shape
    [cw(20, 0, 22, 2), cw(30, 0, 32, 2)], // two-part multipolygon
  ]);

  it('reads polygons, skips null shapes and keeps record numbers', () => {
    const { records, total, header } = readShpPolygons(shp);
    expect(header.shapeType).toBe(5);
    expect(total).toBe(3);
    expect(records.map((r) => r.index)).toEqual([0, 2]);
    expect(records[0].rings).toHaveLength(2);
    expect(records[0].bbox).toEqual([0, 0, 10, 10]);
  });

  it('rejects records by bounding box before reading their points', () => {
    const { records } = readShpPolygons(shp, (b) => b[0] >= 20);
    expect(records.map((r) => r.index)).toEqual([2]);
  });

  it('reads PolygonZ the same as Polygon', () => {
    // A PolygonZ body is a Polygon body followed by Z/M arrays; ignoring them is enough.
    const { records } = readShpPolygons(writeShp([[cw(0, 0, 1, 1)]], 15));
    expect(records).toHaveLength(1);
  });

  it('refuses point layers', () => {
    expect(() => readShpPolygons(writeShp([], 1))).toThrow(/Point features/);
  });

  it('refuses files that are not shapefiles', () => {
    expect(() => readShpPolygons(new ArrayBuffer(120))).toThrow(/not an ESRI/);
  });
});

describe('point in polygon', () => {
  const { records } = readShpPolygons(
    writeShp([[cw(0, 0, 10, 10), ccw(4, 4, 6, 6)], [cw(20, 0, 22, 2), cw(30, 0, 32, 2)]]),
  );
  const [holed, multi] = records;

  it('excludes holes', () => {
    expect(pointInRings(2, 2, holed.rings)).toBe(true);
    expect(pointInRings(5, 5, holed.rings)).toBe(false);
    expect(pointInRings(11, 5, holed.rings)).toBe(false);
  });

  it('includes every part of a multipolygon and nothing between them', () => {
    expect(pointInRings(21, 1, multi.rings)).toBe(true);
    expect(pointInRings(31, 1, multi.rings)).toBe(true);
    expect(pointInRings(25, 1, multi.rings)).toBe(false);
  });

  it('the banded tester agrees with the plain ray cast on a large polygon', () => {
    // A 2,000-vertex star with a star-shaped hole: forces the banded path.
    const star = (r0: number, r1: number, n: number, dir: 1 | -1) => {
      const out = new Float64Array((n + 1) * 2);
      for (let i = 0; i <= n; i++) {
        const a = (dir * 2 * Math.PI * i) / n;
        const r = i % 2 ? r0 : r1;
        out[i * 2] = r * Math.cos(a);
        out[i * 2 + 1] = r * Math.sin(a);
      }
      return out;
    };
    const rings = [star(100, 80, 2000, -1), star(30, 20, 400, 1)];
    const fast = ringTester(rings);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 240 - 120;
    for (let i = 0; i < 5000; i++) {
      const x = rand();
      const y = rand();
      expect(fast(x, y)).toBe(pointInRings(x, y, rings));
    }
  });
});

describe('ring orientation', () => {
  it('reads clockwise as negative, as the shapefile spec defines outer rings', () => {
    expect(signedArea2(Float64Array.from(cw(0, 0, 2, 2).flat()))).toBe(-8);
    expect(signedArea2(Float64Array.from(ccw(0, 0, 2, 2).flat()))).toBe(8);
  });

  it('groups each hole with the outer ring that contains it', () => {
    const rings = [cw(0, 0, 10, 10), cw(20, 0, 30, 10), ccw(22, 2, 24, 4), ccw(2, 2, 4, 4)].map((r) =>
      Float64Array.from(r.flat()),
    );
    const polys = polygonsOf(rings);
    expect(polys).toHaveLength(2);
    expect(polys[0]).toHaveLength(2);
    expect(polys[0][1][0]).toBe(2);
    expect(polys[1][1][0]).toBe(22);
  });
});

describe('readDbf', () => {
  const dbf = writeDbf(
    [
      { name: 'ATTRIBUTE', type: 'C', length: 10 },
      { name: 'ACRES', type: 'N', length: 12 },
    ],
    [
      ['PEM1Cm', 39.93],
      ['PUBFx', ''],
      ['gone', 1],
    ],
    [2],
  );

  it('reads text and numeric fields, with blanks as null', () => {
    const t = readDbf(dbf);
    expect(t.fields.map((f) => f.name)).toEqual(['ATTRIBUTE', 'ACRES']);
    expect(t.count).toBe(3);
    expect(t.row(0)).toEqual({ ATTRIBUTE: 'PEM1Cm', ACRES: 39.93 });
    expect(t.row(1)).toEqual({ ATTRIBUTE: 'PUBFx', ACRES: null });
  });

  it('returns null for deleted and out-of-range rows', () => {
    const t = readDbf(dbf);
    expect(t.row(2)).toBeNull();
    expect(t.row(3)).toBeNull();
  });
});

describe('groupShapefileParts', () => {
  it('groups components by base name, case-insensitively, and ignores other files', () => {
    const b = new ArrayBuffer(0);
    const layers = groupShapefileParts([
      { path: 'zip/Wetlands.SHP', data: b },
      { path: 'zip/wetlands.dbf', data: b },
      { path: 'zip/Wetlands.prj', data: new TextEncoder().encode('PROJ').buffer },
      { path: 'zip/Watershed.shp', data: b },
      { path: 'zip/__MACOSX/._Wetlands.shp', data: b },
      { path: 'zip/readme.txt', data: b },
    ]);
    expect(layers.map((l) => l.name)).toEqual(['Watershed', 'Wetlands']);
    expect(layers[1].prj).toBe('PROJ');
    expect(layers[1].dbf).toBeDefined();
  });
});

describe('extractShapeRegions', () => {
  const layer = {
    name: 'test',
    shp: writeShp([[cw(0, 0, 10, 10), ccw(4, 4, 6, 6)], null, [cw(20, 0, 22, 2), cw(30, 0, 32, 2)], [cw(50, 50, 51, 51)]]),
    dbf: writeDbf(
      [
        { name: 'ATTRIBUTE', type: 'C', length: 8 },
        { name: 'WETLAND_TY', type: 'C', length: 20 },
      ],
      [
        ['PEM1Cm', 'Emergent'],
        ['', ''],
        ['PEM1Cm', 'Emergent'],
        ['PUBFx', 'Pond'],
      ],
    ),
    prj: WGS84_PRJ,
  };
  // Pixels: in the square, in its hole, in each multipolygon part, between parts, outside everything.
  const pixels = {
    lon: [1, 5, 21, 31, 25, 100],
    lat: [1, 5, 1, 1, 1, 1],
    pixelId: Int32Array.from([10, 11, 12, 13, 14, 15]),
  };

  it('assigns pixel centres to polygons and keeps only polygons that hold pixels', () => {
    const out = extractShapeRegions(layer, pixels);
    expect(out.totalFeatures).toBe(4);
    expect(out.features.map((f) => [f.fid, Array.from(f.pixelIds)])).toEqual([
      [0, [10]],
      [2, [12, 13]],
    ]);
    expect(out.pixelsCovered).toBe(3);
    expect(out.features[0].attributes.ATTRIBUTE).toBe('PEM1Cm');
    expect(out.features[0].polygons[0]).toHaveLength(2); // outer ring + hole
    expect(out.features[1].polygons).toHaveLength(2); // two parts
  });

  it('assumes WGS 84 only when there is no .prj and the coordinates are degrees', () => {
    expect(extractShapeRegions({ ...layer, prj: undefined }, pixels).assumedWgs84).toBe(true);
    const metres = { name: 'm', shp: writeShp([[cw(500000, 4000000, 500100, 4000100)]]) };
    expect(() => extractShapeRegions(metres, pixels)).toThrow(/no \.prj/);
  });

  it('names regions by NWI code and FID, or pools them by a field', () => {
    const out = extractShapeRegions(layer, pixels);
    expect(regionDrafts(out, null).map((d) => d.name)).toEqual(['PEM1Cm #2', 'PEM1Cm #0']);
    const pooled = regionDrafts(out, 'ATTRIBUTE');
    expect(pooled).toHaveLength(1);
    expect(pooled[0].name).toBe('PEM1Cm (2 polygons)');
    expect(Array.from(pooled[0].pixelIds)).toEqual([10, 12, 13]);
    expect(pooled[0].fids).toEqual([0, 2]);
  });

  it('exports regions as GeoJSON', () => {
    const json = JSON.parse(
      regionsToGeoJson(
        [
          { id: 'r1', name: 'Box 1', source: 'drawn', polygons: ringPolygon([[0, 0], [1, 0], [1, 1]]), pixelCount: 4 },
          { id: 'r2', name: 'PEM1Cm #2', source: 'test.shp', polygons: extractShapeRegions(layer, pixels).features[1].polygons, pixelCount: 2 },
        ],
        'US-Myb',
      ),
    );
    expect(json.features[0].geometry.type).toBe('Polygon');
    expect(json.features[0].geometry.coordinates[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
    expect(json.features[1].geometry.type).toBe('MultiPolygon');
    expect(json.features[1].properties).toMatchObject({ region_id: 'r2', site_id: 'US-Myb', pixels_in_region: 2 });
  });
});
