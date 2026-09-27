/**
 * Sample sites, downloaded on request from the lab's public data release
 * (github.com/McNicol-Lab/wetlsp-sample-data, tag v2): annual phenometrics
 * and spline-smoothed daily EVI only.
 *
 * The list of sites and files ships inside the app (`sample-index.json`, written
 * by `npm run samples:publish`), so the "Download sample sites" button shows
 * sizes instantly and works on first launch. GitHub release files carry no
 * CORS headers, so the desktop app's local server fetches them
 * (`/remote-samples/<asset>`) and streams each one straight into offline
 * storage through the ordinary importer. The dev and preview servers do the
 * same. The hosted web build has no such server, so it does not offer them.
 */
import type { IngestEntry } from './ingest';
import index from './sample-index.json';

export interface SampleSite {
  siteId: string;
  name: string;
  description: string;
  bytes: number;
  files: Array<{ path: string; size: number; asset: string }>;
}

export const SAMPLE_RELEASE_URL = `https://github.com/${index.repo}/releases/tag/${index.tag}`;

/** Desktop builds and the local dev/preview servers can reach the release. */
export const samplesAvailable =
  import.meta.env.MODE === 'desktop' || import.meta.env.DEV || import.meta.env.VITE_SAMPLES === '1';

export function sampleSites(): SampleSite[] {
  return samplesAvailable ? (index.sites as SampleSite[]) : [];
}

/** Importer entries that stream each file from the release via the local server. */
export function sampleEntries(sample: SampleSite): IngestEntry[] {
  return sample.files.map((f) => ({
    path: `${sample.siteId}/${f.path}`,
    size: f.size,
    retryable: true,
    open: async () => {
      let res: Response;
      try {
        res = await fetch(`${import.meta.env.BASE_URL}remote-samples/${encodeURIComponent(f.asset)}`, {
          cache: 'no-store',
        });
      } catch {
        throw new Error('The sample sites could not be downloaded. Check the internet connection and try again.');
      }
      if (res.status === 502) {
        throw new Error('No internet connection. Connect to the internet, then download the sample sites again.');
      }
      if (!res.ok || !res.body) {
        throw new Error(`${sample.siteId}: ${f.path} is not available for download (HTTP ${res.status}).`);
      }
      return res.body;
    },
  }));
}
