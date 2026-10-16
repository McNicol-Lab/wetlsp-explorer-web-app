/** Client for the raster overlay worker (workers/overlay.worker.ts). */
import { WorkerClient } from '@/lib/rpc';
import type { RasterOverlayData } from '@/lib/overlay';
import type { ReadRasterOptions } from '@/workers/overlay.worker';
import type { QueryOptions } from './queries';

const worker = new WorkerClient(
  () => new Worker(new URL('../workers/overlay.worker.ts', import.meta.url), { type: 'module' }),
);

/** Read and georeference a GeoTIFF or NetCDF for the Pixel Map overlay. */
export async function readRasterOverlay(
  file: File,
  opts: ReadRasterOptions & QueryOptions = {},
): Promise<RasterOverlayData> {
  const buf = await file.arrayBuffer();
  return worker.call<RasterOverlayData>(
    'readRaster',
    [file.name, buf, { choice: opts.choice, maxCells: opts.maxCells }],
    { signal: opts.signal, onProgress: opts.onProgress, transfer: [buf] },
  );
}
