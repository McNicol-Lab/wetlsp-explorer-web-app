/// <reference lib="webworker" />
/** Raster overlay reads (lib/rasterRead.ts), off the main thread. */
import { serve, type HandlerContext } from '@/lib/rpc';
import { readRaster, type ReadRasterOptions } from '@/lib/rasterRead';
import type { RasterOverlayData } from '@/lib/overlay';

export type { ReadRasterOptions };

const handlers = {
  async readRaster(ctx: HandlerContext, name: string, buf: ArrayBuffer, opts: ReadRasterOptions = {}): Promise<RasterOverlayData> {
    return readRaster(name, buf, opts, (p) => ctx.progress(p));
  },
};

serve(handlers as unknown as Record<string, (ctx: HandlerContext, ...args: never[]) => unknown>);
