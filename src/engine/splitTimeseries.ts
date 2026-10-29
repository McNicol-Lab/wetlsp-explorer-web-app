/**
 * Splitting a stored `pixels_timeseries` file that is too large for the
 * browser into pixel-range parts (see lib/splitPlan.ts for why and how the
 * ranges are chosen). Runs once, on import, or the first time a site
 * imported before this existed is opened.
 *
 * DuckDB writes the parts straight into the site's folder in offline storage,
 * so no part is ever held in memory. EVI is written as FLOAT: the app reads
 * it as Float32 anyway (lib/yearTable.ts), and it is 97% of the file.
 * The original is deleted only once the parts hold every one of its rows.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDb, sqlStr } from './duckdb';
import { CancelledError } from '@/lib/rpc';
import { deleteSiteFile, readSiteFile, siteFileOpfsPath } from '@/lib/opfs';
import {
  equalCuts,
  partPath,
  planPixelCuts,
  rangeWhere,
  SPLIT_ABOVE_BYTES,
  TARGET_PART_BYTES,
  type RowGroupStat,
} from '@/lib/splitPlan';
import { formatBytes } from '@/lib/format';
import type { ProgressEvent, SiteManifest, StoredFile } from '@/lib/types';

export interface SplitOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
}

/** True when a time series part is too large to be scanned in memory. */
export function needsSplit(manifest: SiteManifest): boolean {
  return Boolean(manifest.timeseries?.parts.some((p) => p.size > SPLIT_ABOVE_BYTES));
}

let splitId = 0;

/**
 * The manifest with every oversized time series part replaced by its parts.
 * The caller saves it. On failure nothing is changed: parts already written
 * are removed and the original stays.
 */
export async function splitLargeTimeseries(manifest: SiteManifest, opts: SplitOptions = {}): Promise<SiteManifest> {
  const ts = manifest.timeseries;
  if (!ts || !needsSplit(manifest)) return manifest;
  const big = ts.parts.filter((p) => p.size > SPLIT_ABOVE_BYTES);
  const bigBytes = big.reduce((n, p) => n + p.size, 0);
  const phase = 'Splitting the time series for the browser (once)';
  let doneBytes = 0;

  const replaced = new Map<string, StoredFile[]>();
  for (const part of big) {
    const parts = await splitOne(manifest.siteId, part, {
      ...opts,
      onProgress: (f) =>
        opts.onProgress?.({
          phase,
          fraction: (doneBytes + f * part.size) / bigBytes,
          detail: `${part.path} (${formatBytes(part.size)})`,
        }),
    });
    replaced.set(part.path, parts);
    doneBytes += part.size;
  }

  // Only now is anything removed: every split part is complete and checked.
  for (const path of replaced.keys()) await deleteSiteFile(manifest.siteId, path);
  const parts = ts.parts.flatMap((p) => replaced.get(p.path) ?? [p]);
  const totalBytes = parts.reduce((n, p) => n + p.size, 0);
  return {
    ...manifest,
    timeseries: { ...ts, kind: parts.length > 1 ? 'directory' : ts.kind, parts, totalBytes },
    totalBytes: manifest.totalBytes - ts.totalBytes + totalBytes,
  };
}

async function splitOne(
  siteId: string,
  part: StoredFile,
  opts: { signal?: AbortSignal; onProgress: (fraction: number) => void },
): Promise<StoredFile[]> {
  const db = await getDb();
  const src = `split_src_${++splitId}.parquet`;
  const written: string[] = [];
  const registered: string[] = [];
  const conn = await db.connect();
  const onAbort = () => void conn.cancelSent();
  opts.signal?.addEventListener('abort', onAbort);
  const rows = async (sql: string) => (await conn.query(sql)).toArray().map((r) => r.toJSON());
  try {
    // A file handle, never a buffer: this file is the one too large to load.
    await db.registerFileHandle(src, await readSiteFile(siteId, part.path), duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    registered.push(src);
    const meta = await rows(
      `SELECT row_group_id AS g, path_in_schema AS col, type, total_compressed_size AS bytes,
              row_group_num_rows AS n, stats_min_value AS lo, stats_max_value AS hi
       FROM parquet_metadata(${sqlStr(src)})`,
    );
    const columns = new Set(meta.map((m) => String(m.col)));
    if (!columns.has('pixel_id')) throw new Error('it has no `pixel_id` column to split on');
    const eviIsDouble = meta.some((m) => m.col === 'evi' && m.type === 'DOUBLE');

    const groups = new Map<number, RowGroupStat & { n: number }>();
    for (const m of meta) {
      const g = groups.get(Number(m.g)) ?? { min: null, max: null, bytes: 0, n: Number(m.n) };
      // A DOUBLE column written as FLOAT takes about half the space.
      g.bytes += Number(m.bytes) * (m.col === 'evi' && eviIsDouble ? 0.5 : 1);
      if (m.col === 'pixel_id') {
        g.min = m.lo == null ? null : Number(m.lo);
        g.max = m.hi == null ? null : Number(m.hi);
      }
      groups.set(Number(m.g), g);
    }
    const sourceRows = [...groups.values()].reduce((n, g) => n + g.n, 0);
    let cuts = planPixelCuts([...groups.values()]);
    if (!cuts) {
      const [r] = await rows(`SELECT min(pixel_id) AS lo, max(pixel_id) AS hi FROM read_parquet(${sqlStr(src)})`);
      const expected = [...groups.values()].reduce((n, g) => n + g.bytes, 0);
      cuts = r.lo == null ? [] : equalCuts(Number(r.lo), Number(r.hi), Math.ceil(expected / TARGET_PART_BYTES));
    }
    if (cuts.length === 0) throw new Error('its pixels cannot be divided into ranges');

    const n = cuts.length + 1;
    const select = eviIsDouble ? 'SELECT * REPLACE (CAST(evi AS FLOAT) AS evi)' : 'SELECT *';
    const out: StoredFile[] = [];
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) throw new CancelledError();
      const path = partPath(part.path, i, n);
      const target = siteFileOpfsPath(siteId, path);
      await db.registerOPFSFileName(target);
      written.push(path);
      registered.push(target);
      await conn.query(
        `COPY (${select} FROM read_parquet(${sqlStr(src)}) WHERE ${rangeWhere(cuts, i)})
         TO ${sqlStr(target)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 131072)`,
      );
      // Closes DuckDB's exclusive handle on the new file, so it can be read.
      await db.dropFile(target);
      registered.splice(registered.indexOf(target), 1);
      out.push({ path, size: (await readSiteFile(siteId, path)).size });
      opts.onProgress((i + 1) / n);
    }

    // Every row of the original, once: the ranges never overlap.
    const check = out.map((_, i) => `check_${splitId}_${i}.parquet`);
    for (const [i, p] of out.entries()) {
      await db.registerFileHandle(check[i], await readSiteFile(siteId, p.path), duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      registered.push(check[i]);
    }
    const [{ total }] = await rows(`SELECT count(*)::BIGINT AS total FROM read_parquet([${check.map(sqlStr).join(', ')}])`);
    if (Number(total) !== sourceRows) {
      throw new Error(`the parts hold ${Number(total).toLocaleString('en-US')} rows, the file ${sourceRows.toLocaleString('en-US')}`);
    }
    written.length = 0; // keep them
    return out;
  } catch (err) {
    if (opts.signal?.aborted) throw new CancelledError();
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`${part.path} (${formatBytes(part.size)}) could not be split: ${why}`);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await conn.close().catch(() => undefined);
    for (const name of registered) await db.dropFile(name).catch(() => undefined);
    for (const path of written) await deleteSiteFile(siteId, path).catch(() => undefined);
  }
}
