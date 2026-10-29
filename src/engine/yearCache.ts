/**
 * Year tables (see lib/yearTable.ts): built from one scan of
 * `pixels_timeseries`, kept in memory and in offline storage, and prepared in
 * the background as soon as a site opens, newest year first. A chart then
 * waits for a scan only the first time a year is ever used, and not at all
 * once the background pass has reached it.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getDb, registerSite, sqlStr, tableRef } from './duckdb';
import { CancelledError } from '@/lib/rpc';
import { deleteCacheFiles, readCacheFile, readSiteFile, writeCacheFile } from '@/lib/opfs';
import { formatBytes } from '@/lib/format';
import { packYearTable, unpackYearTable, yearTableBytes, YearTableBuilder, type YearTable } from '@/lib/yearTable';
import type { ProgressEvent, SiteManifest, StoredFile } from '@/lib/types';

export interface LoadOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

/**
 * 20 MB each for a 14,000-pixel site, 46 MB for a 31,000-pixel one, 180 MB
 * for AU-Arc (125,000 pixels). Four is what compare-years needs for one
 * site; older tables reload from storage. The byte limit keeps large sites
 * from holding gigabytes; the newest table always stays.
 */
const MEMORY_LIMIT = 4;
const MEMORY_BYTES = 1024 ** 3;
/** Tables built in one pass over the file are held together until it ends. */
const PASS_BYTES = 1024 ** 3;
/**
 * Parts up to this size are loaded whole for the scan: range reads of the same
 * file were ~10x slower. Larger ones (a site that could not be split) are
 * range-read: slow, but Chrome cannot load a file of 2 GiB or more at all.
 */
const LOAD_WHOLE_BYTES = 1024 ** 3;
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
  let bytes = 0;
  for (const v of memory.values()) bytes += yearTableBytes(v);
  while (memory.size > 1 && (memory.size > MEMORY_LIMIT || bytes > MEMORY_BYTES)) {
    const oldest = memory.keys().next().value!;
    bytes -= yearTableBytes(memory.get(oldest)!);
    memory.delete(oldest);
  }
}

const pixelCounts = new Map<string, Promise<number | null>>();

/** Pixels in the site's geometry (cheap: a small table), or null without one. */
function pixelCount(manifest: SiteManifest): Promise<number | null> {
  const k = `${manifest.siteId}|${manifest.importedAt}`;
  let p = pixelCounts.get(k);
  if (!p) {
    p = (async () => {
      if (!manifest.geom) return null;
      await registerSite(manifest);
      const conn = await (await getDb()).connect();
      try {
        const t = await conn.query(`SELECT count(*)::INTEGER AS n FROM ${tableRef(manifest.siteId, manifest.geom)}`);
        return Number(t.getChild('n')?.get(0) ?? 0) || null;
      } finally {
        await conn.close();
      }
    })().catch(() => null);
    pixelCounts.set(k, p);
  }
  return p;
}

/** Memory one year table of this site takes, at most (a leap year), or null when unknown. */
export async function yearTableEstimate(manifest: SiteManifest): Promise<number | null> {
  const n = await pixelCount(manifest);
  return n === null ? null : n * (366 * 4 + 4);
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
      // As many years per pass as fit in memory together: all of them for a
      // small site, one at a time for a million-pixel one.
      const each = await yearTableEstimate(manifest);
      const perPass = each ? Math.max(1, Math.floor(PASS_BYTES / each)) : toScan.length;
      let previous: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < toScan.length; i += perPass) {
        const group = toScan.slice(i, i + perPass);
        // One pass after another: DuckDB has a single worker, and memory is the point.
        const scanned = previous.catch(() => undefined).then(() => scan(manifest, group, series, opts));
        previous = scanned;
        for (const y of group) {
          const k = key(manifest.siteId, y, series);
          const one = scanned.then((m) => m.get(y)!);
          building.set(k, one);
          void one.catch(() => undefined).finally(() => building.get(k) === one && building.delete(k));
          waits.push(one.then((t) => void out.set(y, t)));
        }
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
  return cached ? unpackYearTable(cached, sourceOf(manifest)) : null;
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

/** Hand one stored part to DuckDB for a scan: whole when it fits, range-read when not. */
async function registerPart(siteId: string, part: StoredFile, name: string): Promise<void> {
  const db = await getDb();
  const file = await readSiteFile(siteId, part.path);
  if (file.size > LOAD_WHOLE_BYTES) {
    await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    return;
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    // Chrome words a file it cannot load (too large, or memory) as a permission problem.
    if (err instanceof DOMException && err.name === 'NotReadableError') {
      throw new Error(
        `${part.path} (${formatBytes(file.size)}) could not be loaded into memory. The browser cannot load a file of 2 GB or more in one piece, and may refuse smaller ones when memory is short. Close other tabs, or remove and import the site again so it is stored in smaller parts.`,
      );
    }
    throw err;
  }
  await db.registerFileBuffer(name, new Uint8Array(bytes));
}

/**
 * One pass over the time series for the given years: pixel, day of year and
 * value, streamed straight into each year's table. One part at a time, loaded
 * whole into DuckDB and dropped before the next, so memory holds one part,
 * not the site: AU-Arc's 2.75 GB file could never be loaded at all.
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
  const { parts, totalBytes } = manifest.timeseries;
  opts.onProgress?.({ phase, fraction: null });

  const db = await getDb();
  const pixels = await pixelCount(manifest);
  const builders = new Map(years.map((y) => [y, new YearTableBuilder(y, series, pixels ?? 4096)]));
  const sql = (name: string) =>
    [
      "SELECT pixel_id, year, datediff('day', make_date(year, 1, 1), CAST(date AS DATE)) AS d, evi",
      `FROM read_parquet(${sqlStr(name)})`,
      `WHERE year IN (${years.map(Number).join(', ')}) AND series = ${sqlStr(series)} AND evi IS NOT NULL`,
    ].join('\n');
  let rows = 0;
  let bytesDone = 0;
  for (const part of parts) {
    const name = `yearscan_${++scanId}.parquet`;
    await registerPart(manifest.siteId, part, name);
    try {
      const conn: AsyncDuckDBConnection = await db.connect();
      try {
        const reader = await conn.send(sql(name), true);
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
          opts.onProgress?.({
            phase,
            fraction: parts.length > 1 && totalBytes > 0 ? bytesDone / totalBytes : null,
            detail: `${rows.toLocaleString('en-US')} rows`,
          });
        }
      } finally {
        await conn.close();
      }
    } finally {
      await db.dropFile(name).catch(() => undefined);
    }
    bytesDone += part.size;
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
      // open on; then the other years, together when they fit in memory.
      // Nothing is kept here: each group's tables go to storage and memory's
      // own limit, so a large site never holds every year at once.
      const newest = Math.max(...years);
      await loadYearTables(manifest, [newest], series, { signal: controller.signal });
      const each = await yearTableEstimate(manifest);
      const rest = years.filter((y) => y !== newest).sort((a, b) => b - a);
      const perPass = each ? Math.max(1, Math.floor(PASS_BYTES / each)) : rest.length;
      for (let i = 0; i < rest.length; i += perPass) {
        await loadYearTables(manifest, rest.slice(i, i + perPass), series, { signal: controller.signal });
      }
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
  for (const k of [...pixelCounts.keys()]) if (k.startsWith(`${siteId}|`)) pixelCounts.delete(k);
  await deleteCacheFiles(`ts-v1-${siteId}-`);
}
