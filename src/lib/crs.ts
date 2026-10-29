/**
 * Projected (UTM) -> WGS84 reprojection driven by the `crs_wkt` value stored in
 * `pixels_meta`, or by the `spatial_ref` attribute of the NetCDF's
 * `transverse_mercator` variable.
 *
 * Resolution order:
 *   1. an EPSG id parsed out of the WKT, mapped to a proj4 definition;
 *   2. the raw WKT handed straight to proj4 (it understands WKT1 and WKT2);
 *   3. the Transverse Mercator parameters read out of the WKT by hand.
 */
import proj4 from 'proj4';

export const WGS84 = 'EPSG:4326';

export interface CrsResolution {
  /** proj4 definition string (or the WKT itself when that is what worked). */
  def: string;
  epsg: number | null;
  /** Which branch produced `def`. The UI shows it, so a surprising choice is visible. */
  source: 'epsg' | 'wkt' | 'tmerc-params';
  name: string | null;
}

/**
 * Extract the authority code that applies to the CRS as a whole.
 *
 * Both WKT1 (`AUTHORITY["EPSG","32610"]`) and WKT2 (`ID["EPSG",32610]`) put the
 * outermost identifier last, after any nested base-CRS identifier, so the final
 * match is the one that describes the projected CRS.
 */
export function epsgFromWkt(wkt: string): number | null {
  if (!wkt) return null;
  const matches = [
    ...wkt.matchAll(/(?:ID|AUTHORITY)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi),
  ];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

export function crsNameFromWkt(wkt: string): string | null {
  const m = wkt.match(/^\s*(?:PROJCRS|PROJCS|GEOGCRS|GEOGCS)\s*\[\s*"([^"]+)"/i);
  return m ? m[1] : null;
}

/** proj4 string for the EPSG codes that WetLSP exports actually use. */
export function proj4DefForEpsg(code: number): string | null {
  if (code === 4326) return '+proj=longlat +datum=WGS84 +no_defs';
  if (code === 4269) return '+proj=longlat +datum=NAD83 +no_defs';
  // NAD83 / Conus Albers: USGS and NWI national products.
  if (code === 5070)
    return '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs';
  if (code === 3857)
    return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';

  // WGS84 / UTM north + south
  if (code >= 32601 && code <= 32660)
    return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  if (code >= 32701 && code <= 32760)
    return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  // NAD83 / UTM north (common for North American sites)
  if (code >= 26901 && code <= 26923)
    return `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`;
  // ETRS89 / UTM north
  if (code >= 25828 && code <= 25838)
    return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  // WGS72 / UTM north + south
  if (code >= 32201 && code <= 32260)
    return `+proj=utm +zone=${code - 32200} +ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263 +units=m +no_defs`;
  if (code >= 32301 && code <= 32360)
    return `+proj=utm +zone=${code - 32300} +south +ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263 +units=m +no_defs`;
  return null;
}

function numericParam(wkt: string, names: string[]): number | null {
  for (const name of names) {
    const re = new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+]+)`, 'i');
    const m = wkt.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Last-resort: rebuild a +proj=tmerc string from the WKT's own parameters. */
export function tmercDefFromWkt(wkt: string): string | null {
  if (!/Transverse[_ ]Mercator/i.test(wkt)) return null;
  const lat0 = numericParam(wkt, ['Latitude of natural origin', 'latitude_of_origin']);
  const lon0 = numericParam(wkt, ['Longitude of natural origin', 'central_meridian']);
  const k = numericParam(wkt, ['Scale factor at natural origin', 'scale_factor']);
  const x0 = numericParam(wkt, ['False easting', 'false_easting']);
  const y0 = numericParam(wkt, ['False northing', 'false_northing']);
  if (lon0 === null) return null;

  const spheroid = wkt.match(/(?:SPHEROID|ELLIPSOID)\s*\[\s*"([^"]+)"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  let datum = '+datum=WGS84';
  if (spheroid) {
    const a = Number(spheroid[2]);
    const invf = Number(spheroid[3]);
    if (/WGS[\s_]*84/i.test(spheroid[1])) datum = '+datum=WGS84';
    else if (/GRS[\s_]*1980/i.test(spheroid[1])) datum = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0';
    else datum = `+a=${a} +rf=${invf} +towgs84=0,0,0,0,0,0,0`;
  }

  return [
    '+proj=tmerc',
    `+lat_0=${lat0 ?? 0}`,
    `+lon_0=${lon0}`,
    `+k=${k ?? 1}`,
    `+x_0=${x0 ?? 0}`,
    `+y_0=${y0 ?? 0}`,
    datum,
    '+units=m',
    '+no_defs',
  ].join(' ');
}

function defWorks(def: string): boolean {
  try {
    const out = proj4(def, WGS84, [500000, 5000000]);
    return Number.isFinite(out[0]) && Number.isFinite(out[1]);
  } catch {
    return false;
  }
}

/** Resolve a WKT string to something proj4 can transform with. Throws if nothing works. */
export function resolveCrs(wkt: string | null | undefined): CrsResolution {
  const name = wkt ? crsNameFromWkt(wkt) : null;
  if (!wkt || !wkt.trim()) {
    throw new Error(
      'No CRS found (`crs_wkt` in pixels_meta or in the geometry file). Pixel coordinates cannot be placed on a map.',
    );
  }

  const epsg = epsgFromWkt(wkt);
  if (epsg !== null) {
    const def = proj4DefForEpsg(epsg);
    if (def && defWorks(def)) return { def, epsg, source: 'epsg', name };
  }

  if (defWorks(wkt)) return { def: wkt, epsg, source: 'wkt', name };

  const tm = tmercDefFromWkt(wkt);
  if (tm && defWorks(tm)) return { def: tm, epsg, source: 'tmerc-params', name };

  throw new Error(
    `Could not interpret the site CRS${
      epsg ? ` (EPSG:${epsg})` : ''
    }. Pixel coordinates cannot be placed on a map.`,
  );
}

/** Build a reusable forward transformer from projected metres to lon/lat. */
export function makeToWgs84(wkt: string | null | undefined): {
  resolution: CrsResolution;
  forward(x: number, y: number): [number, number];
} {
  const resolution = resolveCrs(wkt);
  const tr = proj4(resolution.def, WGS84);
  return {
    resolution,
    forward(x: number, y: number) {
      const out = tr.forward([x, y]);
      return [out[0], out[1]];
    },
  };
}

/** Bulk reprojection of packed x/y arrays; returns packed lon/lat. */
export function reprojectMany(
  wkt: string | null | undefined,
  xs: Float64Array | number[],
  ys: Float64Array | number[],
): { lon: Float64Array; lat: Float64Array; resolution: CrsResolution } {
  const { resolution, forward } = makeToWgs84(wkt);
  const n = xs.length;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [lo, la] = forward(xs[i], ys[i]);
    lon[i] = lo;
    lat[i] = la;
  }
  return { lon, lat, resolution };
}

export interface LayerTransform {
  name: string | null;
  epsg: number | null;
  /** True when the layer is in degrees, so no projection is involved. */
  geographic: boolean;
  toWgs84(x: number, y: number): [number, number];
  fromWgs84(lon: number, lat: number): [number, number];
}

/**
 * Transform for an imported layer (a shapefile `.prj`, a GeoTIFF's EPSG code,
 * a NetCDF `spatial_ref`). Unlike `resolveCrs`, any projection proj4
 * understands is accepted, not only the UTM family WetLSP sites use: the
 * National Wetlands Inventory ships Albers Equal Area in ESRI WKT with no
 * EPSG id. `what` names the source in error messages.
 */
export function layerTransform(crs: string | number | null | undefined, what: string): LayerTransform {
  if (crs === null || crs === undefined || (typeof crs === 'string' && !crs.trim())) {
    throw new Error(`${what} has no coordinate reference system.`);
  }
  const epsg = typeof crs === 'number' ? crs : epsgFromWkt(crs);
  const candidates = [
    epsg !== null ? proj4DefForEpsg(epsg) : null,
    typeof crs === 'string' ? crs : null,
    typeof crs === 'string' ? tmercDefFromWkt(crs) : null,
  ].filter((d): d is string => Boolean(d));
  for (const def of candidates) {
    let tr: proj4.Converter;
    try {
      tr = proj4(def, WGS84);
      const probe = tr.inverse([-96, 40]);
      if (!probe.every(Number.isFinite)) continue;
    } catch {
      continue;
    }
    const geographic = /^\s*(GEOGCS|GEOGCRS)\b|\+proj=longlat/i.test(def);
    return {
      name: typeof crs === 'string' ? crsNameFromWkt(crs) : `EPSG:${crs}`,
      epsg,
      geographic,
      toWgs84: (x, y) => tr.forward([x, y]) as [number, number],
      fromWgs84: (lon, lat) => tr.inverse([lon, lat]) as [number, number],
    };
  }
  throw new Error(
    `${what} uses a coordinate reference system this app cannot interpret${epsg ? ` (EPSG:${epsg})` : ''}. ` +
      'Reproject it to WGS 84 (EPSG:4326) or UTM in QGIS and import it again.',
  );
}
