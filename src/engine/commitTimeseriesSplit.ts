import type { SiteManifest } from '@/lib/types';
import { saveManifest } from '@/lib/idb';
import { deleteSiteFile, storedPath } from '@/lib/opfs';

/** Publish the replacement file list before releasing any original files. */
export async function commitTimeseriesSplit(previous: SiteManifest, next: SiteManifest): Promise<void> {
  await saveManifest(next);
  const keep = new Set(next.timeseries?.parts.map((p) => storedPath(p.path)) ?? []);
  for (const part of previous.timeseries?.parts ?? []) {
    if (!keep.has(storedPath(part.path))) {
      // Cleanup failure must not turn a successfully saved split into a failure.
      // The saved manifest already points to complete, verified parts.
      await deleteSiteFile(previous.siteId, part.path).catch(() => undefined);
    }
  }
}
