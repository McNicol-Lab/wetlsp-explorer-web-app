/**
 * Map layers (shapefiles, GeoTIFFs, NetCDF rasters) that arrive through the
 * site importer: Open dataset, Upload folder or a window drop. They are not
 * sites, so they wait here for the Pixel Map, which turns shapefiles into
 * regions and rasters into its overlay (views/pixelMapLayers.tsx).
 */
import { create } from 'zustand';
import { isSiteData } from './detect';
import type { IngestEntry } from './ingest';

/** Files waiting for the Pixel Map importer, and what it is busy with. */
export const useMapImportQueue = create<{ files: File[] | null; busy: string | null }>(() => ({
  files: null,
  busy: null,
}));

const MAP_LAYER = /\.(shp|shx|dbf|prj|cpg|tiff?|nc4?)$/i;
const MAP_LAYER_MAIN = /\.(shp|tiff?|nc4?)$/i;

/**
 * Entries that are map layers rather than site data: shapefile components and
 * rasters. A WetLSP `<site>-wetlsp-<year>.nc` is site data and stays a site.
 */
export function mapLayerEntries<T extends { path: string }>(entries: T[]): T[] {
  const layers = entries.filter((e) => MAP_LAYER.test(e.path) && !isSiteData(e.path));
  return layers.some((e) => MAP_LAYER_MAIN.test(e.path)) ? layers : [];
}

/** True when nothing in the batch is site data, only map layers. */
export function isMapLayersOnly(entries: Array<{ path: string }>): boolean {
  return mapLayerEntries(entries).length > 0 && !entries.some((e) => isSiteData(e.path));
}

/** Read entries (files on disk or archive members) as File objects named by their base name. */
export async function entriesToFiles(entries: IngestEntry[]): Promise<File[]> {
  const out: File[] = [];
  for (const e of entries) {
    const name = e.path.split('/').pop() ?? e.path;
    if (e.file) out.push(new File([e.file], name));
    else if (e.open) out.push(new File([await new Response(await e.open()).blob()], name));
  }
  return out;
}
