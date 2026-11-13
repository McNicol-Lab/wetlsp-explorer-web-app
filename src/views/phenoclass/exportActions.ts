/** Browser downloads for a saved run; the bytes come from `lib/phenoclass/exports`. */
import { downloadBlob } from '@/lib/export';
import { useAppStore } from '@/store/useAppStore';
import {
  annualGeoTiff,
  bundleEntries,
  consensusGeoTiffs,
  coverCsv,
  coverJson,
  modelJson,
  runSlug,
  summaryCsv,
  waveformCsv,
  type RunArrays,
} from '@/lib/phenoclass/exports';
import { geotiffSupport } from '@/lib/phenoclass/geotiff';
import type { RunManifest } from '@/lib/phenoclass/model';
import { zipStore } from '@/lib/zipWrite';

const tiff = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/tiff' });
const text = (s: string, type: string) => new Blob([s], { type });

async function guarded(title: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    useAppStore.getState().toast({ kind: 'error', title, detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Why GeoTIFFs cannot be written for this run, or null. */
export function geotiffBlocker(run: RunManifest, stale: string | null): string | null {
  return stale ? `Out of date: ${stale}` : geotiffSupport(run.grid);
}

export function downloadAnnualTif(run: RunManifest, arrays: RunArrays, year: number): Promise<void> {
  return guarded('GeoTIFF export failed', () => {
    const labels = arrays.labels[String(year)];
    if (!labels) throw new Error(`This run has no ${year} map.`);
    downloadBlob(tiff(annualGeoTiff(run, year, labels)), `${runSlug(run)}_classes_${year}.tif`);
  });
}

export function downloadConsensusTif(run: RunManifest, arrays: RunArrays, which: 'class' | 'valid' | 'agreement'): Promise<void> {
  return guarded('GeoTIFF export failed', () => {
    if (!arrays.consensus) throw new Error('This run has no consensus map.');
    const name = { class: 'consensus_class.tif', valid: 'consensus_valid_years.tif', agreement: 'consensus_agreement.tif' }[which];
    const t = consensusGeoTiffs(run, arrays.consensus).find((x) => x.name === name)!;
    downloadBlob(tiff(t.bytes), `${runSlug(run)}_${name}`);
  });
}

export function downloadCoverCsv(run: RunManifest): Promise<void> {
  return guarded('CSV export failed', () => downloadBlob(text(coverCsv(run), 'text/csv;charset=utf-8'), `${runSlug(run)}_class_cover.csv`));
}

export function downloadCoverJson(run: RunManifest): Promise<void> {
  return guarded('Class cover export failed', () =>
    downloadBlob(text(coverJson(run), 'application/json'), `${runSlug(run)}_class_cover.json`),
  );
}

export function downloadSummaryCsv(run: RunManifest): Promise<void> {
  return guarded('CSV export failed', () => downloadBlob(text(summaryCsv(run), 'text/csv;charset=utf-8'), `${runSlug(run)}_class_summary.csv`));
}

export function downloadWaveformCsv(run: RunManifest, population: string): Promise<void> {
  return guarded('CSV export failed', () =>
    downloadBlob(text(waveformCsv(run, population), 'text/csv;charset=utf-8'), `${runSlug(run)}_waveforms_${population}.csv`),
  );
}

export function downloadModelJson(run: RunManifest): Promise<void> {
  return guarded('Model export failed', () => downloadBlob(text(modelJson(run), 'application/json'), `${runSlug(run)}_model.json`));
}

export function downloadManifestJson(run: RunManifest): Promise<void> {
  return guarded('Manifest export failed', () =>
    downloadBlob(text(JSON.stringify(run, null, 2), 'application/json'), `${runSlug(run)}_manifest.json`),
  );
}

export function downloadBundle(run: RunManifest, arrays: RunArrays, pngs: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }> = []): Promise<void> {
  return guarded('Bundle export failed', () => {
    const blob = zipStore(bundleEntries(run, arrays, pngs));
    downloadBlob(blob, `${runSlug(run)}.zip`);
    useAppStore.getState().toast({
      kind: 'success',
      title: 'ZIP saved',
      detail: `${run.siteId}, ${(blob.size / 1e6).toFixed(1)} MB.`,
      ttl: 3500,
    });
  });
}
