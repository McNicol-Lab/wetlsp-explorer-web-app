/**
 * DuckDB-WASM lifecycle and file registration.
 *
 * Parquet files are registered as OPFS `File` handles rather than buffers, so
 * DuckDB range-reads them. That is what lets a 190 MB / 28 M-row
 * `pixels_timeseries` be queried without ever materialising it.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { SiteManifest, StoredTable } from '@/lib/types';
import { readSiteFile, siteFileHandle } from '@/lib/opfs';
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

/** A DuckDB instance in a worker of its own. */
async function boot(
  bundle: duckdb.DuckDBBundle,
  onProgress?: (p: duckdb.InstantiationProgress) => void,
): Promise<duckdb.AsyncDuckDB> {
  const worker = new Worker(bundle.mainWorker!);
  try {
    const instance = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker, onProgress);
    await instance.open({
      query: { castBigIntToDouble: true, castTimestampToDate: true },
    });
    return instance;
  } catch (err) {
    worker.terminate();
    throw err;
  }
}

/**
 * Another engine beside the app's own, for work that would otherwise hold
 * the app's single worker for minutes (the time series split runs several
 * side by side). The caller terminates it.
 */
export async function startEngine(): Promise<duckdb.AsyncDuckDB> {
  // The app's engine first: it caches the bundle, so this one starts offline too.
  await getDb();
  return boot(await duckdb.selectBundle(BUNDLES));
}

export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (db) return db;
  booting ??= (async () => {
    setStatus({ state: 'loading', bytesLoaded: 0, bytesTotal: 0 });
    try {
      const bundle = await duckdb.selectBundle(BUNDLES);
      // The initial page can start DuckDB before the service worker claims it.
      // Explicitly persist BOTH assets; passive runtime caching misses that boot.
      // A storage quota failure must not prevent online exploration. The explicit
      // "Prepare for offline" action below checks again and reports any failure.
      await cacheEngineBundle(bundle).catch(() => undefined);
      const instance = await boot(bundle, (p) => {
        setStatus({ bytesLoaded: p.bytesLoaded, bytesTotal: p.bytesTotal });
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
      booting = null;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'error', error: message });
      throw new Error(`The query engine could not start: ${message}`);
    }
  })();
  return booting;
}

/** Warm the engine without running a query, for "Prepare for offline". */
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

/**
 * The CRS WetLSP also writes into the geometry file's own metadata (key
 * `crs_wkt`, since September 2026), from registered DuckDB file names; null
 * when it is not there. A site without `pixels_meta` can still be mapped.
 */
export async function crsFromFileMetadata(names: string[]): Promise<string | null> {
  if (names.length === 0) return null;
  const conn = await (await getDb()).connect();
  try {
    const t = await conn.query(
      `SELECT decode(value) AS v FROM parquet_kv_metadata([${names.map(sqlStr).join(', ')}]) WHERE key = 'crs_wkt'::BLOB LIMIT 1`,
    );
    const v = t.numRows > 0 ? t.getChild('v')?.get(0) : null;
    return v ? String(v) : null;
  } finally {
    await conn.close();
  }
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
  if (manifest.timeseries) {
    // Once per registration: a second handle on a file cannot be opened.
    let opening = fastOpening.get(manifest.siteId);
    if (!opening) {
      opening = registerFast(manifest.siteId, manifest.timeseries);
      fastOpening.set(manifest.siteId, opening);
    }
    await opening;
  }
}

/*
 * The time series parts are also opened with OPFS sync access handles
 * (BROWSER_FSACCESS), which DuckDB reads in place as fast as a loaded buffer:
 * on BR-Npw parts a 329-pixel read took 0.57 s against 9.8 s through the
 * File reader, and a year scan of one part 5.6 s against 44 s. A handle locks
 * its file against writes and deletes until it is dropped (unregisterSite),
 * and another tab holding one makes opening fail: then the File-reader names
 * are used, only slower.
 */
const fast = new Map<string, Set<string> | null>();
const fastOpening = new Map<string, Promise<void>>();

/** DuckDB-visible name of a time series part opened with a sync access handle. */
export function duckdbFastName(siteId: string, relPath: string): string {
  return `site_${siteId.replace(/[^\w.-]/g, '_')}/g${generation.get(siteId) ?? 0}/fast/${relPath}`;
}

async function registerFast(siteId: string, table: StoredTable): Promise<void> {
  const instance = await getDb();
  const opened = new Set<string>();
  try {
    for (const part of table.parts) {
      const handle = await siteFileHandle(siteId, part.path);
      await instance.registerFileHandle(
        duckdbFastName(siteId, part.path),
        handle,
        duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
        true,
      );
      opened.add(part.path);
    }
    fast.set(siteId, opened);
  } catch {
    for (const path of opened) await instance.dropFile(duckdbFastName(siteId, path)).catch(() => undefined);
    fast.set(siteId, null);
  }
}

/** True when this time series part is open with a sync access handle (after registerSite). */
export function readsInPlace(siteId: string, relPath: string): boolean {
  return Boolean(fast.get(siteId)?.has(relPath));
}

/** The name to read one time series part by: its sync-access-handle name when it has one. */
export function timeseriesPartName(siteId: string, relPath: string): string {
  return readsInPlace(siteId, relPath) ? duckdbFastName(siteId, relPath) : duckdbName(siteId, relPath);
}

/** `read_parquet([...])` over the time series, by the fastest names registered (after registerSite). */
export function timeseriesRef(siteId: string, table: StoredTable): string {
  const list = table.parts.map((p) => sqlStr(timeseriesPartName(siteId, p.path))).join(', ');
  return `read_parquet([${list}], union_by_name = true)`;
}

export async function unregisterSite(manifest: SiteManifest): Promise<void> {
  if (!db) return;
  const done = registered.get(manifest.siteId);
  await fastOpening.get(manifest.siteId);
  fastOpening.delete(manifest.siteId);
  const opened = fast.get(manifest.siteId);
  fast.delete(manifest.siteId);
  // Closes the sync access handles, so the parts can be replaced or deleted.
  for (const path of opened ?? []) await db.dropFile(duckdbFastName(manifest.siteId, path)).catch(() => undefined);
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
