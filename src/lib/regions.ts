/**
 * Regions: named groups of pixels compared side by side in the Time Series.
 *
 * A region comes from a rectangle or lasso drawn on the Pixel Map, or from a
 * polygon in an imported shapefile (for example a National Wetlands
 * Inventory layer). Membership is by pixel centre: a pixel belongs to a
 * polygon when its centre falls inside it, holes excluded. That is the rule
 * GeoPandas `sjoin(predicate="within")` and `sf::st_within` apply to the
 * pixel points, so counts can be checked against either.
 *
 * Point-in-polygon runs in the shapefile's own CRS: the pixels are projected
 * into it (tens of thousands of points) instead of reprojecting the layer's
 * vertices (1.6 million for one NWI watershed). Only the polygons that hold
 * pixels are reprojected, for drawing.
 */
import {
  POLYGON_TYPES,
  groupShapefileParts,
  polygonsOf,
  readDbf,
  readShpHeader,
  readShpPolygons,
  ringTester,
  shapeTypeName,
  signedArea2,
  type DbfTable,
  type ShapefileParts,
} from './shapefile';
import { layerTransform } from './crs';

export type Attributes = Record<string, string | number | null>;
/** Polygons → rings → [lon, lat] points. */
export type LonLatPolygons = number[][][][];

/** Okabe–Ito, then extras: distinguishable for common colour-vision deficiencies. */
export const REGION_COLORS = [
  '#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9',
  '#6b4c9a', '#8c6d31', '#333333', '#f0439a', '#1b9e77', '#7570b3',
];

/** At most this many regions are drawn on one chart; more is unreadable. */
export const MAX_COMPARED_REGIONS = REGION_COLORS.length;

export interface ShapeLayerSummary {
  name: string;
  shapeType: string;
  polygons: boolean;
  features: number | null;
  fields: string[];
  crsName: string | null;
  missing: string[];
}

export interface ShapeFeature {
  /** 0-based record number: the FID QGIS and GeoPandas show for a shapefile. */
  fid: number;
  attributes: Attributes;
  pixelIds: Int32Array;
  polygons: LonLatPolygons;
  /** Polygon area in the layer's CRS units squared; null for geographic layers. */
  area: number | null;
}

export interface ShapeExtraction {
  layer: string;
  crsName: string | null;
  /** True when there was no `.prj` and degrees were assumed. */
  assumedWgs84: boolean;
  fields: string[];
  totalFeatures: number;
  /** Features whose bounding box overlaps the site. */
  nearSite: number;
  /** The whole layer's extent in lon/lat: [west, south, east, north]. */
  layerBboxWgs84: [number, number, number, number];
  features: ShapeFeature[];
  /** Pixels inside at least one feature. */
  pixelsCovered: number;
}

/** What each layer in a set of files is, before anything heavy is read. */
export function summarizeLayers(layers: ShapefileParts[]): ShapeLayerSummary[] {
  return layers.map((l) => {
    const missing = (['shp', 'dbf', 'prj'] as const).filter((k) => !l[k]);
    let shapeType = 'unknown';
    let polygons = false;
    let features: number | null = null;
    let fields: string[] = [];
    let crsName: string | null = null;
    try {
      if (l.shp) {
        const h = readShpHeader(l.shp);
        shapeType = shapeTypeName(h.shapeType);
        polygons = POLYGON_TYPES.has(h.shapeType);
      }
      if (l.shx) features = Math.max(0, (l.shx.byteLength - 100) / 8);
      if (l.dbf) {
        const t = readDbf(l.dbf, l.cpg);
        features ??= t.count;
        fields = t.fields.map((f) => f.name);
      }
      if (l.prj) crsName = layerTransform(l.prj, l.name).name;
    } catch {
      /* reported when the layer is actually read */
    }
    return { name: l.name, shapeType, polygons, features, fields, crsName, missing };
  });
}

/** Indices of `xs` sorted by value, for range scans by bounding box. */
function sortedOrder(xs: Float64Array): Uint32Array {
  const order = new Uint32Array(xs.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => xs[a] - xs[b]);
  return order;
}

function lowerBound(order: Uint32Array, xs: Float64Array, value: number): number {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[order[mid]] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every polygon of `parts` that holds at least one of the site's pixels,
 * with the pixel ids inside it.
 */
export function extractShapeRegions(
  parts: ShapefileParts,
  pixels: { lon: ArrayLike<number>; lat: ArrayLike<number>; pixelId: ArrayLike<number> },
  onCancelCheck: () => void = () => undefined,
): ShapeExtraction {
  if (!parts.shp) throw new Error(`${parts.name}: the .shp file is missing.`);
  const header = readShpHeader(parts.shp);
  if (!POLYGON_TYPES.has(header.shapeType)) {
    throw new Error(
      `${parts.name} holds ${shapeTypeName(header.shapeType)} features. Only polygon layers can become regions.`,
    );
  }

  let assumedWgs84 = false;
  let crs: string | number | undefined = parts.prj;
  if (!crs) {
    const [x0, y0, x1, y1] = header.bbox;
    if (x0 >= -180 && x1 <= 180 && y0 >= -90 && y1 <= 90) {
      crs = 4326;
      assumedWgs84 = true;
    } else {
      throw new Error(
        `${parts.name} has no .prj file, so its coordinates cannot be placed. Include the .prj that came with the .shp.`,
      );
    }
  }
  const tr = layerTransform(crs, `${parts.name}.prj`);

  const n = pixels.pixelId.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = tr.fromWgs84(pixels.lon[i], pixels.lat[i]);
    px[i] = x;
    py[i] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const { records, total } = readShpPolygons(
    parts.shp,
    ([x0, y0, x1, y1]) => x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY,
  );
  const dbf: DbfTable | null = parts.dbf ? readDbf(parts.dbf, parts.cpg) : null;
  const order = sortedOrder(px);
  const covered = new Uint8Array(n);
  const features: ShapeFeature[] = [];

  for (const rec of records) {
    onCancelCheck();
    const [x0, y0, x1, y1] = rec.bbox;
    const hits: number[] = [];
    const inside = ringTester(rec.rings);
    for (let k = lowerBound(order, px, x0); k < order.length; k++) {
      const i = order[k];
      if (px[i] > x1) break;
      if (py[i] < y0 || py[i] > y1) continue;
      if (inside(px[i], py[i])) {
        hits.push(pixels.pixelId[i]);
        covered[i] = 1;
      }
    }
    if (hits.length === 0) continue;
    const grouped = polygonsOf(rec.rings);
    features.push({
      fid: rec.index,
      attributes: dbf?.row(rec.index) ?? {},
      pixelIds: Int32Array.from(hits).sort(),
      polygons: grouped.map((poly) =>
        poly.map((ring) => {
          const pts: number[][] = new Array(ring.length / 2);
          for (let j = 0; j < pts.length; j++) pts[j] = tr.toWgs84(ring[j * 2], ring[j * 2 + 1]);
          return pts;
        }),
      ),
      // Outer rings are clockwise (negative), holes counter-clockwise.
      area: tr.geographic ? null : -rec.rings.reduce((s, r) => s + signedArea2(r), 0) / 2,
    });
  }

  let pixelsCovered = 0;
  for (let i = 0; i < n; i++) pixelsCovered += covered[i];
  // Edges and corners, since a projected box is not a lon/lat box.
  const [hx0, hy0, hx1, hy1] = header.bbox;
  const ring = [0, 0.5, 1].flatMap((u) => [0, 0.5, 1].map((v) => tr.toWgs84(hx0 + (hx1 - hx0) * u, hy0 + (hy1 - hy0) * v)));
  const layerBboxWgs84: [number, number, number, number] = [
    Math.min(...ring.map((p) => p[0])),
    Math.min(...ring.map((p) => p[1])),
    Math.max(...ring.map((p) => p[0])),
    Math.max(...ring.map((p) => p[1])),
  ];
  return {
    layer: parts.name,
    layerBboxWgs84,
    crsName: tr.name,
    assumedWgs84,
    fields: dbf?.fields.map((f) => f.name) ?? [],
    totalFeatures: total,
    nearSite: records.length,
    features,
    pixelsCovered,
  };
}

/* ------------------------------------------------------------- location */

/** Kilometres from a point to the nearest edge of a lon/lat box (0 inside it). */
export function kmToBox([lon, lat]: [number, number], [w, s, e, n]: [number, number, number, number]): number {
  const cLon = Math.min(e, Math.max(w, lon));
  const cLat = Math.min(n, Math.max(s, lat));
  const k = Math.PI / 180;
  const a =
    Math.sin(((cLat - lat) * k) / 2) ** 2 + Math.cos(lat * k) * Math.cos(cLat * k) * Math.sin(((cLon - lon) * k) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** `38.01–38.76°N, 121.33–122.25°W` (each range written low to high in magnitude). */
export function formatBox([w, s, e, n]: [number, number, number, number]): string {
  const range = (a: number, b: number, pos: string, neg: string) => {
    if (a >= 0 === b >= 0) {
      const [lo, hi] = [Math.abs(a), Math.abs(b)].sort((x, y) => x - y);
      return `${lo.toFixed(2)}–${hi.toFixed(2)}°${a >= 0 ? pos : neg}`;
    }
    return `${Math.abs(a).toFixed(2)}°${neg}–${b.toFixed(2)}°${pos}`;
  };
  return `${range(s, n, 'N', 'S')}, ${range(w, e, 'E', 'W')}`;
}

/** True for a National Wetlands Inventory layer (its standard attribute fields). */
export function isNwiLayer(fields: string[]): boolean {
  return fields.includes('ATTRIBUTE') && fields.includes('WETLAND_TY');
}

/* --------------------------------------------------------------- naming */

const NAME_FIELDS = /^(name|label|title|site_?name|site_?id|id|code|class|type)$/i;

/** A short label: the NWI wetland code, else a name-like field, else the FID. */
export function featureLabel(f: Pick<ShapeFeature, 'fid' | 'attributes'>): string {
  const a = f.attributes;
  if (typeof a.ATTRIBUTE === 'string' && a.ATTRIBUTE) return `${a.ATTRIBUTE} #${f.fid}`;
  const key = Object.keys(a).find((k) => NAME_FIELDS.test(k) && a[k] !== null && String(a[k]).length <= 40);
  return key ? `${a[key]} #${f.fid}` : `Feature #${f.fid}`;
}

/** One line of context under the label, e.g. NWI's wetland type. */
export function featureDescription(f: Pick<ShapeFeature, 'attributes'>): string | null {
  const a = f.attributes;
  if (typeof a.WETLAND_TY === 'string') return a.WETLAND_TY;
  return null;
}

/* ------------------------------------------------------------- grouping */

export interface RegionDraft {
  name: string;
  description: string | null;
  attributes: Attributes;
  pixelIds: Int32Array;
  polygons: LonLatPolygons;
  /** The shapefile FIDs merged into this region. */
  fids: number[];
}

function unionSorted(arrays: Int32Array[]): Int32Array {
  if (arrays.length === 1) return arrays[0];
  const all = new Set<number>();
  for (const a of arrays) for (const id of a) all.add(id);
  return Int32Array.from(all).sort();
}

/**
 * One region per feature, or one per distinct value of `field` (all
 * `PEM1Cm` polygons pooled as one region, say). Regions come out largest
 * first, so the ones compared by default are the ones with most pixels.
 */
export function regionDrafts(extraction: ShapeExtraction, field: string | null): RegionDraft[] {
  let drafts: RegionDraft[];
  if (!field) {
    drafts = extraction.features.map((f) => ({
      name: featureLabel(f),
      description: featureDescription(f),
      attributes: { fid: f.fid, ...f.attributes, ...(f.area !== null ? { area_layer_units2: Math.round(f.area) } : {}) },
      pixelIds: f.pixelIds,
      polygons: f.polygons,
      fids: [f.fid],
    }));
  } else {
    const groups = new Map<string, ShapeFeature[]>();
    for (const f of extraction.features) {
      const key = f.attributes[field] === null || f.attributes[field] === undefined ? '(blank)' : String(f.attributes[field]);
      const list = groups.get(key);
      if (list) list.push(f);
      else groups.set(key, [f]);
    }
    drafts = [...groups].map(([key, list]) => ({
      name: `${key} (${list.length} polygon${list.length === 1 ? '' : 's'})`,
      description: featureDescription(list[0]),
      attributes: { [field]: key, polygons: list.length },
      pixelIds: unionSorted(list.map((f) => f.pixelIds)),
      polygons: list.flatMap((f) => f.polygons),
      fids: list.map((f) => f.fid),
    }));
  }
  return drafts.sort((a, b) => b.pixelIds.length - a.pixelIds.length);
}

/* --------------------------------------------------------------- export */

export interface RegionGeometry {
  id: string;
  name: string;
  source: string;
  attributes?: Attributes;
  polygons: LonLatPolygons;
  pixelCount: number;
}

/** Regions as a GeoJSON FeatureCollection (WGS 84), for QGIS or R/Python. */
export function regionsToGeoJson(regions: RegionGeometry[], siteId: string): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    name: `${siteId}_regions`,
    features: regions.map((r) => ({
      type: 'Feature',
      properties: {
        region_id: r.id,
        region_name: r.name,
        source: r.source,
        site_id: siteId,
        pixels_in_region: r.pixelCount,
        ...(r.attributes ?? {}),
      },
      geometry:
        r.polygons.length === 1
          ? { type: 'Polygon', coordinates: r.polygons[0] }
          : { type: 'MultiPolygon', coordinates: r.polygons },
    })),
  });
}

/** Lon/lat ring of a screen rectangle or lasso, closed, as one polygon. */
export function ringPolygon(ring: number[][]): LonLatPolygons {
  const closed = ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
    ? [...ring, ring[0]]
    : ring;
  return [[closed]];
}

export { groupShapefileParts };
