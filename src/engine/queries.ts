/**
 * The site query API. Everything here is async, reports progress, and can be
 * cancelled; nothing here can trigger a full scan of `pixels_timeseries`.
 */
import * as arrow from 'apache-arrow';
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getDb, registerSite, tableRef } from './duckdb';
import {
  buildDailySummarySql,
  buildDistinctPixelsSql,
  buildFactsSql,
  buildPixelMeanSql,
  buildPixelTraceSql,
  buildTimeseriesSql,
  MAX_PIXEL_SAMPLE,
  type TimeseriesFilters,
} from './sql';
import { CancelledError } from '@/lib/rpc';
import { deleteCacheFile, readCacheFile, writeCacheFile } from '@/lib/opfs';
import { randomSample } from '@/lib/sampling';
import { analysisYears } from '@/lib/years';
import type {
  DailySummaryRow,
  PixelGeometry,
  ProgressEvent,
  SiteFacts,
  SiteManifest,
  SiteMeta,
} from '@/lib/types';
import { WorkerClient } from '@/lib/rpc';
import type { ReprojectResult } from '@/workers/geo.worker';

export interface QueryOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

const geoWorker = new WorkerClient(
  () => new Worker(new URL('../workers/geo.worker.ts', import.meta.url), { type: 'module' }),
);

/* ------------------------------------------------------------- execution */

async function withConnection<T>(
  fn: (conn: AsyncDuckDBConnection) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const db = await getDb();
  const conn = await db.connect();
  const onAbort = () => {
    void conn.cancelSent();
  };
  signal?.addEventListener('abort', onAbort);
  try {
    if (signal?.aborted) throw new CancelledError();
    return await fn(conn);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await conn.close();
  }
}

/** Run a query as a stream so long scans report rows and stay cancellable. */
async function streamQuery(sql: string, opts: QueryOptions = {}): Promise<arrow.Table> {
  return withConnection(async (conn) => {
    const reader = await conn.send(sql, true);
    const batches: arrow.RecordBatch[] = [];
    let rows = 0;
    for await (const batch of reader) {
      if (opts.signal?.aborted) {
        await conn.cancelSent();
        throw new CancelledError();
      }
      batches.push(batch);
      rows += batch.numRows;
      opts.onProgress?.({ phase: 'Scanning', fraction: null, detail: `${fmt(rows)} rows` });
    }
    return batches.length ? new arrow.Table(batches) : new arrow.Table(reader.schema!);
  }, opts.signal);
}

async function simpleQuery(sql: string, opts: QueryOptions = {}): Promise<arrow.Table> {
  return withConnection((conn) => conn.query(sql), opts.signal);
}

const fmt = (n: number) => n.toLocaleString('en-US');

function col<T extends ArrayLike<number>>(table: arrow.Table, name: string): T {
  const child = table.getChild(name);
  if (!child) throw new Error(`Query result is missing column "${name}".`);
  return child.toArray() as unknown as T;
}

function strCol(table: arrow.Table, name: string): string[] {
  const child = table.getChild(name);
  if (!child) throw new Error(`Query result is missing column "${name}".`);
  const out: string[] = new Array(child.length);
  for (let i = 0; i < child.length; i++) out[i] = String(child.get(i));
  return out;
}

/* ------------------------------------------------------------------ meta */

/**
 * `pixels_meta` is a two-column key/value table, but the column names are not
 * guaranteed. Probe the schema and pick the first plausible pair.
 */
async function metaColumnNames(ref: string): Promise<[string, string]> {
  const desc = await simpleQuery(`DESCRIBE SELECT * FROM ${ref}`);
  const names = strCol(desc, 'column_name');
  const lower = names.map((n) => n.toLowerCase());
  const keyIdx = lower.findIndex((n) => ['key', 'name', 'field', 'k', 'attribute'].includes(n));
  const valIdx = lower.findIndex((n) => ['value', 'val', 'v'].includes(n));
  if (keyIdx >= 0 && valIdx >= 0) return [names[keyIdx], names[valIdx]];
  if (names.length >= 2) return [names[0], names[1]];
  throw new Error('`pixels_meta` does not look like a key/value table.');
}

export async function getSiteMeta(
  manifest: SiteManifest,
  opts: QueryOptions = {},
): Promise<SiteMeta> {
  if (!manifest.meta) return {};
  await registerSite(manifest);
  const ref = tableRef(manifest.siteId, manifest.meta);
  const [keyCol, valCol] = await metaColumnNames(ref);
  const table = await simpleQuery(
    `SELECT CAST(${quoteIdent(keyCol)} AS VARCHAR) AS k, CAST(${quoteIdent(valCol)} AS VARCHAR) AS v FROM ${ref}`,
    opts,
  );
  const keys = strCol(table, 'k');
  const vals = strCol(table, 'v');
  const meta: SiteMeta = {};
  for (let i = 0; i < keys.length; i++) meta[keys[i]] = vals[i];
  return meta;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/* -------------------------------------------------------------- geometry */

const GEOM_CACHE_VERSION = 2;

function geomCacheKey(siteId: string): string {
  return `geom-v${GEOM_CACHE_VERSION}-${siteId}.bin`;
}

/**
 * Packed cache layout: a JSON header (length-prefixed) followed by the four
 * arrays back to back. Cheaper to write and far cheaper to read than
 * round-tripping through parquet, and it never leaves the origin.
 */
function packGeometry(g: PixelGeometry): Blob {
  const header = JSON.stringify({
    n: g.pixelId.length,
    crsSource: g.crsSource,
    crsName: g.crsName,
    epsg: g.epsg,
  });
  const headerBytes = new TextEncoder().encode(header);
  const len = new Uint32Array([headerBytes.length]);
  const parts = [len, headerBytes, g.pixelId, g.cell, g.x, g.y, g.lon, g.lat];
  return new Blob(parts as unknown as BlobPart[]);
}

async function unpackGeometry(file: File): Promise<PixelGeometry> {
  const buf = await file.arrayBuffer();
  const headerLen = new Uint32Array(buf, 0, 1)[0];
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as {
    n: number;
    crsSource: string;
    crsName: string | null;
    epsg: number | null;
  };
  let off = 4 + headerLen;
  const n = header.n;
  const take = <T>(Ctor: new (b: ArrayBuffer, o: number, n: number) => T, bytes: number): T => {
    // Typed-array views need natural alignment; copy when the offset is odd.
    const aligned = off % bytes === 0;
    const slice = aligned ? buf : buf.slice(off, off + n * bytes);
    const view = new Ctor(slice, aligned ? off : 0, n);
    off += n * bytes;
    return view;
  };
  const pixelId = take(Int32Array, 4);
  const cell = take(Int32Array, 4);
  const x = take(Float64Array, 8);
  const y = take(Float64Array, 8);
  const lon = take(Float64Array, 8);
  const lat = take(Float64Array, 8);
  return {
    pixelId,
    cell,
    x,
    y,
    lon,
    lat,
    crsSource: header.crsSource,
    crsName: header.crsName,
    epsg: header.epsg,
  };
}

/** Forget a site's reprojected geometry, so the next load recomputes it. */
export async function clearGeometryCache(siteId: string): Promise<void> {
  await deleteCacheFile(geomCacheKey(siteId));
}

/**
 * Pixel geometry with both projected and WGS84 coordinates. Computed once per
 * site and cached in OPFS — reprojection is deterministic, so a cache hit is
 * indistinguishable from a recompute.
 */
export async function getPixelGeometry(
  manifest: SiteManifest,
  meta: SiteMeta,
  opts: QueryOptions = {},
): Promise<PixelGeometry> {
  const cached = await readCacheFile(geomCacheKey(manifest.siteId));
  if (cached && cached.size > 0) {
    try {
      return await unpackGeometry(cached);
    } catch {
      /* stale or truncated cache — fall through and rebuild */
    }
  }

  if (!manifest.geom) {
    throw new Error(
      'This site has no `pixels_geom` table, so pixels cannot be placed on the map.',
    );
  }
  await registerSite(manifest);
  opts.onProgress?.({ phase: 'Reading pixel geometry', fraction: null });
  const ref = tableRef(manifest.siteId, manifest.geom);
  const table = await simpleQuery(
    `SELECT pixel_id, COALESCE(TRY_CAST(cell AS INTEGER), -1) AS cell, CAST(x AS DOUBLE) AS x, CAST(y AS DOUBLE) AS y
     FROM ${ref} WHERE x IS NOT NULL AND y IS NOT NULL ORDER BY pixel_id`,
    opts,
  );

  const pixelId = Int32Array.from(col<ArrayLike<number>>(table, 'pixel_id'));
  const cell = Int32Array.from(col<ArrayLike<number>>(table, 'cell'));
  const x = Float64Array.from(col<ArrayLike<number>>(table, 'x'));
  const y = Float64Array.from(col<ArrayLike<number>>(table, 'y'));

  const wkt = meta.crs_wkt ?? null;
  const result = await geoWorker.call<ReprojectResult>('reproject', [wkt, x, y], {
    signal: opts.signal,
    onProgress: opts.onProgress,
  });

  const geometry: PixelGeometry = {
    pixelId,
    cell,
    x,
    y,
    lon: result.lon,
    lat: result.lat,
    crsSource: result.resolution.source,
    crsName: result.resolution.name,
    epsg: result.resolution.epsg,
  };

  try {
    await writeCacheFile(geomCacheKey(manifest.siteId), packGeometry(geometry));
  } catch {
    /* cache is an optimisation, not a requirement */
  }
  return geometry;
}

/* ----------------------------------------------------------------- facts */

export async function getSiteFacts(
  manifest: SiteManifest,
  opts: QueryOptions = {},
): Promise<SiteFacts> {
  const facts: SiteFacts = {
    years: [],
    series: [],
    pixelCount: 0,
    timeseriesRows: 0,
    dateMin: null,
    dateMax: null,
  };

  await registerSite(manifest);

  if (manifest.geom) {
    const t = await simpleQuery(
      `SELECT count(DISTINCT pixel_id) AS n FROM ${tableRef(manifest.siteId, manifest.geom)}`,
      opts,
    );
    facts.pixelCount = Number(t.getChild('n')?.get(0) ?? 0);
  }

  if (manifest.timeseries) {
    opts.onProgress?.({ phase: 'Summarising time series', fraction: null });
    const t = await streamQuery(buildFactsSql(tableRef(manifest.siteId, manifest.timeseries)), opts);
    const years = col<ArrayLike<number>>(t, 'year');
    const series = strCol(t, 'series');
    const counts = col<ArrayLike<number>>(t, 'n');
    const dmin = t.getChild('date_min');
    const dmax = t.getChild('date_max');
    const kept = new Set(
      analysisYears(Array.from(years, Number), manifest.netcdf.map((n) => n.year)),
    );
    const seriesSet = new Set<string>();
    let rows = 0;
    let lo: string | null = null;
    let hi: string | null = null;
    for (let i = 0; i < series.length; i++) {
      if (!kept.has(Number(years[i]))) continue;
      seriesSet.add(series[i]);
      rows += Number(counts[i]);
      const a = isoDate(dmin?.get(i));
      const b = isoDate(dmax?.get(i));
      if (a && (!lo || a < lo)) lo = a;
      if (b && (!hi || b > hi)) hi = b;
    }
    facts.years = [...kept].sort((a, b) => a - b);
    // `spline` first: it is the default series and the app colours it as the accent.
    facts.series = [...seriesSet].sort((a, b) =>
      a === 'spline' ? -1 : b === 'spline' ? 1 : a.localeCompare(b),
    );
    facts.timeseriesRows = rows;
    facts.dateMin = lo;
    facts.dateMax = hi;
  }

  if (facts.years.length === 0 && manifest.netcdf.length > 0) {
    facts.years = manifest.netcdf.map((n) => n.year).sort((a, b) => a - b);
  }

  return facts;
}

function isoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return new Date(value).toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/* ---------------------------------------------------------------- pixels */

const distinctCache = new Map<string, Int32Array>();

export async function getDistinctPixelIds(
  manifest: SiteManifest,
  years: number[],
  series: string[],
  opts: QueryOptions = {},
): Promise<Int32Array> {
  const key = `${manifest.siteId}|${years.join(',')}|${series.join(',')}`;
  const hit = distinctCache.get(key);
  if (hit) return hit;
  if (!manifest.timeseries) return new Int32Array(0);

  await registerSite(manifest);
  opts.onProgress?.({ phase: 'Finding pixels with data', fraction: null });
  const t = await streamQuery(
    buildDistinctPixelsSql(tableRef(manifest.siteId, manifest.timeseries), years, series),
    opts,
  );
  const ids = Int32Array.from(col<ArrayLike<number>>(t, 'pixel_id'));
  distinctCache.set(key, ids);
  return ids;
}

/**
 * A uniform random sample of the pixels with data. The same seed gives the
 * same pixels, so a chart stays put until the user asks for a new sample.
 */
export async function samplePixelIds(
  manifest: SiteManifest,
  years: number[],
  series: string[],
  n: number,
  opts: QueryOptions & { seed: number },
): Promise<{ ids: Int32Array; available: number }> {
  const all = await getDistinctPixelIds(manifest, years, series, opts);
  const cap = Math.min(Math.max(1, Math.floor(n)), MAX_PIXEL_SAMPLE);
  if (all.length <= cap) return { ids: all, available: all.length };
  return { ids: randomSample(all, cap, opts.seed), available: all.length };
}

/* ------------------------------------------------------------ timeseries */

export interface TimeseriesBundle {
  seriesNames: string[];
  pixelId: Int32Array;
  seriesIdx: Uint8Array;
  /** Epoch milliseconds. */
  time: Float64Array;
  evi: Float64Array;
  rows: number;
  pixelsLoaded: number;
}

export async function getTimeseries(
  manifest: SiteManifest,
  filters: TimeseriesFilters,
  opts: QueryOptions = {},
): Promise<TimeseriesBundle> {
  if (!manifest.timeseries) throw new Error('This site has no `pixels_timeseries` table.');
  await registerSite(manifest);
  const sql = buildTimeseriesSql(tableRef(manifest.siteId, manifest.timeseries), filters);
  const t = await streamQuery(sql, opts);

  const pixelId = Int32Array.from(col<ArrayLike<number>>(t, 'pixel_id'));
  const time = Float64Array.from(col<ArrayLike<number>>(t, 't'));
  const evi = Float64Array.from(col<ArrayLike<number>>(t, 'evi'));

  const seriesNames: string[] = [];
  const seriesIdx = new Uint8Array(t.numRows);
  const seriesColumn = t.getChild('series');
  if (!seriesColumn) throw new Error('Query result is missing column "series".');
  // buildTimeseriesSql orders by series, pixel_id, date. Find each contiguous
  // series block instead of decoding up to two million repeated UTF-8 strings
  // on the main thread. The numeric output is still one entry per source row.
  for (let start = 0; start < t.numRows;) {
    const name = String(seriesColumn.get(start));
    let low = start + 1, high = t.numRows;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (String(seriesColumn.get(mid)) === name) low = mid + 1;
      else high = mid;
    }
    seriesIdx.fill(seriesNames.length, start, low);
    seriesNames.push(name);
    start = low;
  }

  const unique = new Set<number>();
  for (const id of pixelId) unique.add(id);

  return {
    seriesNames,
    pixelId,
    seriesIdx,
    time,
    evi,
    rows: pixelId.length,
    pixelsLoaded: unique.size,
  };
}

export async function getDailySummary(
  manifest: SiteManifest,
  filters: TimeseriesFilters,
  opts: QueryOptions = {},
): Promise<DailySummaryRow[]> {
  if (!manifest.timeseries) return [];
  await registerSite(manifest);
  const sql = buildDailySummarySql(tableRef(manifest.siteId, manifest.timeseries), filters);
  const t = await streamQuery(sql, opts);
  const dates = strCol(t, 'date');
  const series = strCol(t, 'series');
  const mean = col<ArrayLike<number>>(t, 'mean');
  const q25 = col<ArrayLike<number>>(t, 'q25');
  const q75 = col<ArrayLike<number>>(t, 'q75');
  const n = col<ArrayLike<number>>(t, 'n');
  const out: DailySummaryRow[] = new Array(dates.length);
  for (let i = 0; i < dates.length; i++) {
    out[i] = {
      date: dates[i],
      series: series[i],
      mean: Number(mean[i]),
      q25: Number(q25[i]),
      q75: Number(q75[i]),
      n: Number(n[i]),
    };
  }
  return out;
}

export async function getPixelTrace(
  manifest: SiteManifest,
  pixelId: number,
  years: number[],
  series: string[],
  opts: QueryOptions = {},
): Promise<TimeseriesBundle> {
  if (!manifest.timeseries) throw new Error('This site has no `pixels_timeseries` table.');
  await registerSite(manifest);
  const sql = buildPixelTraceSql(
    tableRef(manifest.siteId, manifest.timeseries),
    pixelId,
    years,
    series,
  );
  const t = await streamQuery(sql, opts);
  const ids = Int32Array.from(col<ArrayLike<number>>(t, 'pixel_id'));
  const seriesVals = strCol(t, 'series');
  const time = Float64Array.from(col<ArrayLike<number>>(t, 't'));
  const evi = Float64Array.from(col<ArrayLike<number>>(t, 'evi'));
  const seriesNames = [...new Set(seriesVals)];
  const seriesIdx = Uint8Array.from(seriesVals, (s) => seriesNames.indexOf(s));
  return {
    seriesNames,
    pixelId: ids,
    seriesIdx,
    time,
    evi,
    rows: ids.length,
    pixelsLoaded: ids.length ? 1 : 0,
  };
}

/** Mean EVI per pixel, for colouring the pixel cloud and the hexbin skyline. */
export async function getPixelMeans(
  manifest: SiteManifest,
  years: number[],
  series: string[],
  opts: QueryOptions = {},
): Promise<Map<number, number>> {
  if (!manifest.timeseries) return new Map();
  await registerSite(manifest);
  opts.onProgress?.({ phase: 'Averaging EVI per pixel', fraction: null });
  const t = await streamQuery(
    buildPixelMeanSql(tableRef(manifest.siteId, manifest.timeseries), years, series),
    opts,
  );
  const ids = col<ArrayLike<number>>(t, 'pixel_id');
  const means = col<ArrayLike<number>>(t, 'mean_evi');
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i++) out.set(Number(ids[i]), Number(means[i]));
  return out;
}

/* -------------------------------------------------------------- polygons */

/** Every pixel id inside the ring, in file order. */
export async function pixelsInPolygon(
  geometry: PixelGeometry,
  ring: Float64Array,
  opts: QueryOptions = {},
): Promise<Int32Array> {
  return geoWorker.call('pixelsInPolygon', [
    geometry.lon,
    geometry.lat,
    geometry.pixelId,
    ring,
  ], { signal: opts.signal });
}

export function clearQueryCaches(siteId?: string): void {
  if (!siteId) {
    distinctCache.clear();
    return;
  }
  for (const key of [...distinctCache.keys()]) {
    if (key.startsWith(`${siteId}|`)) distinctCache.delete(key);
  }
}
