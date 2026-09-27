/**
 * Year tables (see lib/yearTable.ts): built from one scan of
 * `pixels_timeseries`, kept in memory and in offline storage, and prepared in
 * the background as soon as a site opens, newest year first. A chart then
 * waits for a scan only the first time a year is ever used, and not at all
 * once the background pass has reached it.
 */
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getDb, sqlStr } from './duckdb';
import { CancelledError } from '@/lib/rpc';
import { deleteCacheFiles, readCacheFile, readSiteFile, writeCacheFile } from '@/lib/opfs';
import { packYearTable, unpackYearTable, YearTableBuilder, type YearTable } from '@/lib/yearTable';
import type { ProgressEvent, SiteManifest } from '@/lib/types';

export interface LoadOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

/**
 * 20 MB each for a 14,000-pixel site, 46 MB for a 31,000-pixel one. Four is
 * what compare-years needs for one site; older tables reload from storage.
 */
const MEMORY_LIMIT = 4;
const memory = new Map<string, YearTable>();
const building = new Map<string, Promise<YearTable>>();

const key = (siteId: string, year: number, series: string) => `${siteId}|${year}|${series}`;
const fileKey = (siteId: string, year: number, series: string) =>
  `ts-v1-${siteId}-${year}-${series.replace(/[^\w-]/g, '_')}.bin`;
/** Changes whenever the site's time series is replaced. */
const sourceOf = (m: SiteManifest) => `${m.importedAt}:${m.timeseries?.totalBytes ?? 0}`;

function remember(k: string, t: YearTable) {
  memory.delete(k);
  memory.set(k, t);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}

/** The table for one site-year-series: memory, then offline storage, then a scan. */
export function loadYearTable(
  manifest: SiteManifest,
  year: number,
  series: string,
  opts: LoadOptions = {},
): Promise<YearTable> {
  return loadYearTables(manifest, [year], series, opts).then((m) => m.get(year)!);
}

/**
 * Tables for several years of one series. Years already in memory or storage
 * come from there; the rest are built together in a single scan, which costs
 * little more than one year because every row group holds every year.
 */
export async function loadYearTables(
  manifest: SiteManifest,
  years: number[],
  series: string,
  opts: LoadOptions = {},
): Promise<Map<number, YearTable>> {
  const out = new Map<number, YearTable>();
  const waits: Array<Promise<void>> = [];
  const missing: number[] = [];
  for (const year of new Set(years)) {
    const k = key(manifest.siteId, year, series);
    const hit = memory.get(k);
    if (hit) {
      remember(k, hit);
      out.set(year, hit);
      continue;
    }
    const pending = building.get(k);
    if (pending) waits.push(pending.then((t) => void out.set(year, t)));
    else missing.push(year);
  }

  if (missing.length) {
    // Offline storage first, then one scan for whatever is still missing.
    const stored = await Promise.all(missing.map((y) => readStored(manifest, y, series)));
    const toScan = missing.filter((_, i) => !stored[i]);
    stored.forEach((t, i) => {
      if (!t) return;
      remember(key(manifest.siteId, missing[i], series), t);
      out.set(missing[i], t);
    });
    if (toScan.length) {
      const scanned = scan(manifest, toScan, series, opts);
      for (const y of toScan) {
        const k = key(manifest.siteId, y, series);
        const one = scanned.then((m) => m.get(y)!);
        building.set(k, one);
        void one.catch(() => undefined).finally(() => building.get(k) === one && building.delete(k));
        waits.push(one.then((t) => void out.set(y, t)));
      }
    }
  }
  // Several callers can share one build; each may stop waiting on its own.
  const all = Promise.all(waits);
  await (opts.signal ? abortable(all, opts.signal) : all);
  return out;
}

async function readStored(manifest: SiteManifest, year: number, series: string): Promise<YearTable | null> {
  const cached = await readCacheFile(fileKey(manifest.siteId, year, series));
  return cached ? unpackYearTable(await cached.arrayBuffer(), sourceOf(manifest)) : null;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let scanId = 0;

/**
 * One pass over the time series for the given years: pixel, day of year and
 * value, streamed straight into each year's table. The parquet parts are
 * handed to DuckDB as in-memory buffers for the scan: range reads from
 * offline storage made the same scan several times slower.
 */
async function scan(
  manifest: SiteManifest,
  years: number[],
  series: string,
  opts: LoadOptions,
): Promise<Map<number, YearTable>> {
  if (!manifest.timeseries) throw new Error('This site has no `pixels_timeseries` table.');
  const label = years.length === 1 ? String(years[0]) : `${Math.min(...years)}–${Math.max(...years)}`;
  const phase = `Preparing ${label} (first time only)`;
  opts.onProgress?.({ phase, fraction: null });

  const db = await getDb();
  const names: string[] = [];
  const builders = new Map(years.map((y) => [y, new YearTableBuilder(y, series, 4096)]));
  try {
    for (const part of manifest.timeseries.parts) {
      const file = await readSiteFile(manifest.siteId, part.path);
      const name = `yearscan_${++scanId}.parquet`;
      await db.registerFileBuffer(name, new Uint8Array(await file.arrayBuffer()));
      names.push(name);
    }
    const sql = [
      "SELECT pixel_id, year, datediff('day', make_date(year, 1, 1), CAST(date AS DATE)) AS d, evi",
      `FROM read_parquet([${names.map(sqlStr).join(', ')}], union_by_name = true)`,
      `WHERE year IN (${years.map(Number).join(', ')}) AND series = ${sqlStr(series)} AND evi IS NOT NULL`,
    ].join('\n');
    const conn: AsyncDuckDBConnection = await db.connect();
    let rows = 0;
    try {
      const reader = await conn.send(sql, true);
      for await (const batch of reader) {
        const id = batch.getChild('pixel_id')!.toArray() as ArrayLike<number>;
        const yr = batch.getChild('year')!.toArray() as ArrayLike<number>;
        const d = batch.getChild('d')!.toArray() as ArrayLike<number>;
        const v = batch.getChild('evi')!.toArray() as ArrayLike<number>;
        let b = builders.get(Number(yr[0]))!;
        for (let i = 0; i < batch.numRows; i++) {
          if (Number(yr[i]) !== b.year) b = builders.get(Number(yr[i]))!;
          b.add(id[i], d[i], v[i]);
        }
        rows += batch.numRows;
        opts.onProgress?.({ phase, fraction: null, detail: `${rows.toLocaleString('en-US')} rows` });
      }
    } finally {
      await conn.close();
    }
  } finally {
    for (const n of names) await db.dropFile(n).catch(() => undefined);
  }

  const out = new Map<number, YearTable>();
  for (const [year, b] of builders) {
    const table = b.finish();
    out.set(year, table);
    remember(key(manifest.siteId, year, series), table);
    // Storage is an optimisation; the table is usable either way.
    await writeCacheFile(fileKey(manifest.siteId, year, series), packYearTable(table, sourceOf(manifest))).catch(
      () => undefined,
    );
  }
  return out;
}

/* ---------------------------------------------------------- background */

let prefetching: { siteId: string; controller: AbortController } | null = null;

/**
 * Prepare every year of a site's default series in the background, newest
 * first, one scan at a time. Starting another site's pass stops this one
 * after its current scan; a chart asking for a year that is mid-build shares
 * that build instead of starting another.
 */
export function prefetchSite(manifest: SiteManifest, years: number[], series: string): void {
  if (!manifest.timeseries || years.length === 0) return;
  if (prefetching?.siteId === manifest.siteId) return;
  prefetching?.controller.abort();
  const controller = new AbortController();
  prefetching = { siteId: manifest.siteId, controller };
  void (async () => {
    try {
      // The newest year first, on its own, because it is what the charts
      // open on; then every other year together in one more pass.
      const newest = Math.max(...years);
      await loadYearTables(manifest, [newest], series, { signal: controller.signal });
      await loadYearTables(manifest, years.filter((y) => y !== newest), series, { signal: controller.signal });
    } catch {
      /* stopped, or a chart will surface the error if the user asks for it */
    }
    if (prefetching?.controller === controller) prefetching = null;
  })();
}

/** Drop a site's tables from memory and storage, e.g. before it is removed or replaced. */
export async function forgetYearTables(siteId: string): Promise<void> {
  if (prefetching?.siteId === siteId) {
    prefetching.controller.abort();
    prefetching = null;
  }
  for (const k of [...memory.keys()]) if (k.startsWith(`${siteId}|`)) memory.delete(k);
  await deleteCacheFiles(`ts-v1-${siteId}-`);
}
