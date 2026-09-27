/** Main-thread client for the h5wasm NetCDF worker. */
import { WorkerClient } from '@/lib/rpc';
import type { NetcdfInfo, ProgressEvent, RasterSlice, SiteManifest } from '@/lib/types';

export const DEFAULT_CELL_BUDGET = 50_000;
export const MAX_CELL_BUDGET = 4_000_000;

const client = new WorkerClient(
  () => new Worker(new URL('../workers/netcdf.worker.ts', import.meta.url), { type: 'module' }),
);

export interface NetcdfOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

const infoCache = new Map<string, Promise<NetcdfInfo>>();
const cacheKey = (siteId: string, year: number) => `${siteId}::${year}`;

function fileFor(manifest: SiteManifest, year: number) {
  const entry = manifest.netcdf.find((n) => n.year === year);
  if (!entry) {
    throw new Error(`${manifest.siteId} has no WetLSP NetCDF for ${year}.`);
  }
  return entry;
}

export function getNetcdfInfo(
  manifest: SiteManifest,
  year: number,
  opts: NetcdfOptions = {},
): Promise<NetcdfInfo> {
  const key = cacheKey(manifest.siteId, year);
  const hit = infoCache.get(key);
  if (hit) return hit;
  const entry = fileFor(manifest, year);
  // Deliberately NOT cancellable. The promise is cached and handed to every
  // consumer, so honouring one caller's AbortSignal would reject it for all of
  // them, including components that are still waiting. Opening a file is
  // bounded work and the result is reused, so there is nothing to gain.
  const promise = client
    .call<NetcdfInfo>('info', [manifest.siteId, entry.path, year], {
      onProgress: opts.onProgress,
    })
    .catch((err) => {
      infoCache.delete(key);
      throw err;
    });
  infoCache.set(key, promise);
  return promise;
}

export function readRaster(
  manifest: SiteManifest,
  year: number,
  layer: string,
  maxCells = DEFAULT_CELL_BUDGET,
  opts: NetcdfOptions = {},
): Promise<RasterSlice> {
  const entry = fileFor(manifest, year);
  return client.call<RasterSlice>(
    'readLayer',
    [manifest.siteId, entry.path, layer, Math.min(maxCells, MAX_CELL_BUDGET)],
    opts,
  );
}

export async function releaseSite(siteId: string): Promise<void> {
  for (const key of [...infoCache.keys()]) {
    if (key.startsWith(`${siteId}::`)) infoCache.delete(key);
  }
  try {
    await client.call('release', [siteId]);
  } catch {
    /* worker may not have booted yet */
  }
}

/** Layers present in every one of the given site-years: the comparison set. */
export function intersectLayers(infos: NetcdfInfo[]): string[] {
  if (infos.length === 0) return [];
  let shared = new Set(infos[0].variables.map((v) => v.name));
  for (const info of infos.slice(1)) {
    const next = new Set(info.variables.map((v) => v.name));
    shared = new Set([...shared].filter((n) => next.has(n)));
  }
  return [...shared];
}
