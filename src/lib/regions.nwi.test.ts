/**
 * Real-data check: the National Wetlands Inventory layer for watershed
 * HU8_18020163 against US-Myb's 31,402 pixels.
 *
 * The expected counts come from GeoPandas 1.2 (`sjoin(predicate="within")`
 * of the pixel centres, reprojected from EPSG:32610 to the layer's Albers
 * CRS by PROJ). The NWI layer is 26 MB and the pixels are lab data, so this
 * only runs when both are given:
 *
 *   NWI_DIR=~/Desktop/HU8_18020163_Watershed MYB_PIXELS=us-myb-pixels.json npx vitest run regions.nwi
 *
 * `MYB_PIXELS` is `{crs_wkt, pixel_id[], x[], y[]}` from US-Myb's pixels_geom_ds
 * and pixels_meta_ds; validation/README.md shows the DuckDB query.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractShapeRegions, groupShapefileParts, regionDrafts } from './regions';
import { reprojectMany } from './crs';

const NWI_DIR = process.env.NWI_DIR;
const MYB_PIXELS = process.env.MYB_PIXELS;

/** GeoPandas reference: FID → pixels inside. */
const EXPECTED: Record<number, number> = { 7429: 6592, 7431: 18096, 7433: 1841, 7787: 2982, 9099: 13 };

describe.skipIf(!NWI_DIR || !MYB_PIXELS)('NWI HU8_18020163 × US-Myb', () => {
  const load = () => {
    const base = join(NWI_DIR!, 'HU8_18020163_Wetlands');
    const file = (ext: string) => {
      const b = readFileSync(`${base}.${ext}`);
      return { path: `HU8_18020163_Wetlands.${ext}`, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    };
    const [layer] = groupShapefileParts(['shp', 'shx', 'dbf', 'prj', 'cpg'].map(file));
    const px = JSON.parse(readFileSync(MYB_PIXELS!, 'utf8')) as { crs_wkt: string; pixel_id: number[]; x: number[]; y: number[] };
    const { lon, lat } = reprojectMany(px.crs_wkt, px.x, px.y);
    return { layer, pixels: { lon, lat, pixelId: Int32Array.from(px.pixel_id) } };
  };

  it('matches the GeoPandas per-polygon pixel counts exactly', () => {
    const { layer, pixels } = load();
    const t0 = performance.now();
    const out = extractShapeRegions(layer, pixels);
    const ms = performance.now() - t0;
    console.log(`extractShapeRegions: ${out.totalFeatures} features, ${out.nearSite} near site, ${ms.toFixed(0)} ms`);

    expect(out.totalFeatures).toBe(9611);
    // Bounding boxes overlapping the site: 13. GeoPandas finds 10 whose actual
    // geometry meets the site's box; the prefilter is deliberately coarser.
    expect(out.nearSite).toBe(13);
    const got = Object.fromEntries(out.features.map((f) => [f.fid, f.pixelIds.length]));
    expect(got).toEqual(EXPECTED);
    expect(out.pixelsCovered).toBe(29524);
    const f7431 = out.features.find((f) => f.fid === 7431)!;
    expect(f7431.attributes.ATTRIBUTE).toBe('PEM1Cm');
    expect(f7431.attributes.WETLAND_TY).toBe('Freshwater Emergent Wetland');
  });

  it('pools polygons by NWI code', () => {
    const { layer, pixels } = load();
    const drafts = regionDrafts(extractShapeRegions(layer, pixels), 'ATTRIBUTE');
    expect(drafts.map((d) => [d.attributes.ATTRIBUTE, d.pixelIds.length])).toEqual([
      ['PEM1Cm', 6592 + 18096 + 1841],
      ['PEM1Bh', 2982],
      ['PUBFx', 13],
    ]);
  });
});
