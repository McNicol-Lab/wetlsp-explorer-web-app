/**
 * DuckDB-WASM lifecycle and file registration.
 *
 * Parquet files are registered as OPFS `File` handles rather than buffers, so
 * DuckDB range-reads them. That is what lets a 190 MB / 28 M-row
 * `pixels_timeseries` be queried without ever materialising it.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { SiteManifest, StoredTable } from '@/lib/types';
import { readSiteFile } from '@/lib/opfs';
import { cacheEngineBundle, requireOfflineShell } from './offline';

const BASE = import.meta.env.BASE_URL;

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: `${BASE}duckdb/duckdb-mvp.wasm`,
    mainWorker: `${BASE}duckdb/duckdb-browser-mvp.worker.js`,
  },
  eh: {
    mainModule: `${BASE}duckdb/duckdb-eh.wasm`,
    mainWorker: `${BASE}duckdb/duckdb-browser-eh.worker.js`,
  },
  // The threaded `coi` bundle is intentionally absent: it is only usable on a
  // cross-origin-isolated page, and listing it would make selectBundle pick a
  // file the default build does not ship. Add it here and set
  // WETLSP_DUCKDB_COI=1 when serving with COOP/COEP headers.
};

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  bytesLoaded: number;
  bytesTotal: number;
  error?: string;
  /** `eh` normally; `coi` only when the page is cross-origin isolated. */
  variant?: string;
}

type StatusListener = (s: EngineStatus) => void;

let db: duckdb.AsyncDuckDB | null = null;
let booting: Promise<duckdb.AsyncDuckDB> | null = null;
let status: EngineStatus = { state: 'idle', bytesLoaded: 0, bytesTotal: 0 };
const listeners = new Set<StatusListener>();

export function onEngineStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function setStatus(next: Partial<EngineStatus>) {
  status = { ...status, ...next };
  for (const fn of listeners) fn(status);
}

export function engineStatus(): EngineStatus {
  return status;
}

export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (db) return db;
  booting ??= (async () => {
    setStatus({ state: 'loading', bytesLoaded: 0, bytesTotal: 0 });
    let worker: Worker | undefined;
    try {
      const bundle = await duckdb.selectBundle(BUNDLES);
      // The initial page can start DuckDB before the service worker claims it.
      // Explicitly persist BOTH assets; passive runtime caching misses that boot.
      // A storage quota failure must not prevent online exploration. The explicit
      // "Prepare for offline" action below checks again and reports any failure.
      await cacheEngineBundle(bundle).catch(() => undefined);
      worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.VoidLogger();
      const instance = new duckdb.AsyncDuckDB(logger, worker);
      await instance.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => {
        setStatus({ bytesLoaded: p.bytesLoaded, bytesTotal: p.bytesTotal });
      });
      await instance.open({
        query: { castBigIntToDouble: true, castTimestampToDate: true },
      });
      db = instance;
      setStatus({
        state: 'ready',
        variant: bundle.mainModule.includes('coi')
          ? 'coi'
          : bundle.mainModule.includes('eh')
            ? 'eh'
            : 'mvp',
      });
      return instance;
    } catch (err) {
      worker?.terminate();
      booting = null;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'error', error: message });
      throw new Error(`The query engine could not start: ${message}`);
    }
  })();
  return booting;
}

/** Warm the engine without running a query — used by "Prepare for offline". */
export async function warmEngine(): Promise<void> {
  await requireOfflineShell();
  await cacheEngineBundle(await duckdb.selectBundle(BUNDLES));
  const instance = await getDb();
  const conn = await instance.connect();
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.close();
  }
}

export function engineIsReady(): boolean {
  return status.state === 'ready';
}

/* ------------------------------------------------------------------ files */

const registered = new Map<string, Set<string>>();
/**
 * Bumped each time a site's files are dropped. DuckDB keeps what it learned
 * about a file (its parquet footer) under the file's name even after
 * `dropFile`, so a replaced site re-registered under the old name was read
 * with the old footer: "TProtocolException: Invalid data". A new name per
 * registration means nothing cached for the old files can be reused.
 */
const generation = new Map<string, number>();

/** DuckDB-visible name for one stored file. */
export function duckdbName(siteId: string, relPath: string): string {
  return `site_${siteId.replace(/[^\w.-]/g, '_')}/g${generation.get(siteId) ?? 0}/${relPath}`;
}

export function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `read_parquet([...])` over every part of a logical table. */
export function tableRef(siteId: string, table: StoredTable): string {
  const list = table.parts.map((p) => sqlStr(duckdbName(siteId, p.path))).join(', ');
  return `read_parquet([${list}], union_by_name = true)`;
}

/**
 * Register every parquet part of a site. Idempotent, and cheap on repeat calls:
 * nothing is read here, only handles are handed to DuckDB.
 */
export async function registerSite(manifest: SiteManifest): Promise<void> {
  const instance = await getDb();
  const done = registered.get(manifest.siteId) ?? new Set<string>();
  const tables = [manifest.geom, manifest.meta, manifest.timeseries].filter(
    (t): t is StoredTable => Boolean(t),
  );

  for (const table of tables) {
    for (const part of table.parts) {
      if (done.has(part.path)) continue;
      const file = await readSiteFile(manifest.siteId, part.path);
      await instance.registerFileHandle(
        duckdbName(manifest.siteId, part.path),
        file,
        duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
        true,
      );
      done.add(part.path);
    }
  }
  registered.set(manifest.siteId, done);
}

export async function unregisterSite(manifest: SiteManifest): Promise<void> {
  if (!db) return;
  const done = registered.get(manifest.siteId);
  if (!done) return;
  for (const path of done) {
    try {
      await db.dropFile(duckdbName(manifest.siteId, path));
    } catch {
      /* already gone */
    }
  }
  registered.delete(manifest.siteId);
  generation.set(manifest.siteId, (generation.get(manifest.siteId) ?? 0) + 1);
}

export function isRegistered(siteId: string): boolean {
  return registered.has(siteId);
}
