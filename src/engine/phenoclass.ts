/** Main-thread client for the phenology-classification worker. */
import { WorkerClient } from '@/lib/rpc';
import type { ProgressEvent, SiteManifest } from '@/lib/types';
import type { DiagnosticsOptions, Inspection } from '@/lib/phenoclass/pipeline';
import type { DiagnosticsResult, RunManifest } from '@/lib/phenoclass/model';
import type { TrainRequest, YearFile } from '@/workers/phenoclass.worker';

const client = new WorkerClient(
  () => new Worker(new URL('../workers/phenoclass.worker.ts', import.meta.url), { type: 'module' }),
);

export interface JobOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

export function yearFiles(manifest: SiteManifest, years: number[]): YearFile[] {
  return years
    .slice()
    .sort((a, b) => a - b)
    .map((year) => {
      const f = manifest.netcdf.find((n) => n.year === year);
      if (!f) throw new Error(`${manifest.siteId} has no NetCDF for ${year}.`);
      return { year, path: f.path, size: f.size, importedAt: manifest.importedAt };
    });
}

export function inspectSite(manifest: SiteManifest, years: number[], opts: JobOptions = {}): Promise<Inspection> {
  return client.call('inspect', [manifest.siteId, yearFiles(manifest, years)], opts);
}

export function diagnoseSite(
  manifest: SiteManifest,
  years: number[],
  options: DiagnosticsOptions,
  opts: JobOptions = {},
): Promise<DiagnosticsResult> {
  return client.call('diagnose', [manifest.siteId, yearFiles(manifest, years), options], opts);
}

export function trainSite(manifest: SiteManifest, years: number[], req: TrainRequest, opts: JobOptions = {}): Promise<RunManifest> {
  return client.call('train', [manifest.siteId, yearFiles(manifest, years), req], opts);
}

/** Stop the worker outright, e.g. when a site is deleted mid-job. */
export function resetPhenoclassWorker(): void {
  client.terminate();
}
