import { describe, expect, it } from 'vitest';
import {
  crsNameFromWkt,
  epsgFromWkt,
  makeToWgs84,
  proj4DefForEpsg,
  reprojectMany,
  resolveCrs,
  tmercDefFromWkt,
} from './crs';

/** WKT2 as GDAL writes it for EPSG:32610, the CRS CA-DB2 ships with. */
const WKT2_UTM10N = `PROJCRS["WGS 84 / UTM zone 10N",
  BASEGEOGCRS["WGS 84",
    DATUM["World Geodetic System 1984",
      ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],
    PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],
    ID["EPSG",4326]],
  CONVERSION["UTM zone 10N",
    METHOD["Transverse Mercator",ID["EPSG",9807]],
    PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],
    PARAMETER["Longitude of natural origin",-123,ANGLEUNIT["degree",0.0174532925199433]],
    PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],
    PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],
    PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],
  CS[Cartesian,2],
    AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],
    AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],
  ID["EPSG",32610]]`;

const WKT1_UTM10N = `PROJCS["WGS 84 / UTM zone 10N",
  GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],
  AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],
  AUTHORITY["EPSG","4326"]],
  PROJECTION["Transverse_Mercator"],
  PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],
  PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],
  PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32610"]]`;

/** The same projection with every authority id stripped out. */
const WKT_NO_EPSG = WKT2_UTM10N.replace(/,?\s*ID\s*\[\s*"EPSG"\s*,\s*\d+\s*\]/g, '');

describe('epsgFromWkt', () => {
  it('takes the outermost id, not the nested base CRS', () => {
    expect(epsgFromWkt(WKT2_UTM10N)).toBe(32610);
    expect(epsgFromWkt(WKT1_UTM10N)).toBe(32610);
  });

  it('returns null when there is no authority id', () => {
    expect(epsgFromWkt(WKT_NO_EPSG)).toBeNull();
    expect(epsgFromWkt('')).toBeNull();
  });

  it('reads the CRS name', () => {
    expect(crsNameFromWkt(WKT2_UTM10N)).toBe('WGS 84 / UTM zone 10N');
    expect(crsNameFromWkt(WKT1_UTM10N)).toBe('WGS 84 / UTM zone 10N');
  });
});

describe('proj4DefForEpsg', () => {
  it('maps the WGS84 UTM ranges to zones, north and south', () => {
    expect(proj4DefForEpsg(32610)).toContain('+proj=utm +zone=10');
    expect(proj4DefForEpsg(32610)).not.toContain('+south');
    expect(proj4DefForEpsg(32755)).toContain('+zone=55');
    expect(proj4DefForEpsg(32755)).toContain('+south');
  });

  it('maps NAD83 UTM too', () => {
    expect(proj4DefForEpsg(26910)).toContain('+zone=10');
    expect(proj4DefForEpsg(26910)).toContain('NAD83');
  });

  it('returns null for codes it does not know', () => {
    expect(proj4DefForEpsg(2154)).toBeNull();
  });
});

describe('resolveCrs', () => {
  it('prefers the EPSG code when one is present', () => {
    const r = resolveCrs(WKT2_UTM10N);
    expect(r.epsg).toBe(32610);
    expect(r.source).toBe('epsg');
  });

  it('falls back to the projection parameters when no id is present', () => {
    const r = resolveCrs(WKT_NO_EPSG);
    expect(r.epsg).toBeNull();
    expect(['wkt', 'tmerc-params']).toContain(r.source);
  });

  it('builds a tmerc string from the WKT parameters', () => {
    const def = tmercDefFromWkt(WKT_NO_EPSG)!;
    expect(def).toContain('+proj=tmerc');
    expect(def).toContain('+lon_0=-123');
    expect(def).toContain('+k=0.9996');
    expect(def).toContain('+x_0=500000');
  });

  it('explains itself when there is no CRS at all', () => {
    expect(() => resolveCrs(null)).toThrow(/No CRS/);
    expect(() => resolveCrs('GARBAGE')).toThrow(/CRS/);
  });
});

describe('reprojection', () => {
  it('puts UTM zone 10N false-origin coordinates on the central meridian', () => {
    const { forward } = makeToWgs84(WKT2_UTM10N);
    const [lon, lat] = forward(500000, 5000000);
    // Easting 500000 is the false origin, so it must land exactly on -123.
    expect(lon).toBeCloseTo(-123, 6);
    // Northing 5,000,000 / k0 = 5,002,001 m of meridian arc. The arc to 45N on
    // WGS84 is 4,984,944 m, leaving 17,057 m -> about 0.1535 degrees further north.
    expect(lat).toBeCloseTo(45.1535, 3);
  });

  it('agrees with itself whether the EPSG id is present or not', () => {
    const withId = makeToWgs84(WKT2_UTM10N).forward(512345, 5432100);
    const withoutId = makeToWgs84(WKT_NO_EPSG).forward(512345, 5432100);
    expect(withoutId[0]).toBeCloseTo(withId[0], 7);
    expect(withoutId[1]).toBeCloseTo(withId[1], 7);
  });

  it('lands a zone-10N site in British Columbia, not in the ocean', () => {
    // CA-DB2 sits in UTM zone 10N; a 200 m footprint near 49.1N.
    const { lon, lat } = reprojectMany(
      WKT2_UTM10N,
      Float64Array.from([500000, 500200, 499800]),
      Float64Array.from([5442000, 5442200, 5441800]),
    );
    for (let i = 0; i < 3; i++) {
      expect(lon[i]).toBeGreaterThan(-124);
      expect(lon[i]).toBeLessThan(-122);
      expect(lat[i]).toBeGreaterThan(48.5);
      expect(lat[i]).toBeLessThan(49.5);
    }
  });

  it('keeps 3 m pixel spacing to well under a metre of error', () => {
    const { lon, lat } = reprojectMany(
      WKT2_UTM10N,
      Float64Array.from([500000, 500003]),
      Float64Array.from([5442000, 5442000]),
    );
    const metresPerDegLon = 111320 * Math.cos((lat[0] * Math.PI) / 180);
    const spacing = (lon[1] - lon[0]) * metresPerDegLon;
    expect(spacing).toBeGreaterThan(2.9);
    expect(spacing).toBeLessThan(3.1);
  });
});
