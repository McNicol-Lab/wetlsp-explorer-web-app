/**
 * Splitting a `pixels_timeseries` file that is too large for the browser into
 * pixel-range parts (see lib/splitPlan.ts for why and how the ranges are
 * chosen). Runs once: on import, straight from the dropped file, or the first
 * time a site imported before this existed is opened.
 *
 * Writing parquet is what takes the time (about 50 MB of the source a second
 * per engine, whatever the compression), and one DuckDB-WASM engine uses one
 * core. So the parts are written by several engines side by side, each in a
 * worker of its own, leaving the app's engine free. BR-Npw's 12.7 GB took
 * about 6 minutes in one engine; four take about a third of that.
 *
 * DuckDB writes the parts straight into the site's folder in offline storage,
 * so no part is ever held in memory. EVI is written as FLOAT: the app reads it
 * as Float32 anyway (lib/yearTable.ts), and it is 97% of the file. Parquet v2
 * encodings (byte stream split for EVI) make the parts a quarter smaller and
 * a little faster to read. The original is deleted only once the parts hold
 * every one of its rows.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getDb, sqlStr, startEngine } from './duckdb';
import { CancelledError } from '@/lib/rpc';
import { deleteSiteFile, listSiteFiles, readSiteFile, siteFileHandle, siteFileOpfsPath, storedPath } from '@/lib/opfs';
import {
  engineMemoryMB,
  equalCuts,
  estimateParts,
  partPath,
  planPixelCuts,
  rangeWhere,
  splitEngines,
  staleSplitFiles,
  SPLIT_ABOVE_BYTES,
  TARGET_PART_BYTES,
  type PartEstimate,
  type RowGroupStat,
} from '@/lib/splitPlan';
import { formatBytes } from '@/lib/format';
import type { ProgressEvent, SiteManifest, StoredFile } from '@/lib/types';

export const SPLIT_PHASE = 'Optimizing the time series for fast charts (one time)';

export interface SplitOptions {
  signal?: AbortSignal;
  onProgress?: (p: ProgressEvent) => void;
  /**
   * Files to read by part path, when the part is not in offline storage: an
   * import splits the dropped file itself rather than a copy of it.
   */
  sources?: Map<string, File>;
}

/**
 * Delete split parts and `tmp_` files the manifest does not reference, left
 * by an earlier import or a failed split. Run only when no import is writing.
 */
export async function removeStaleParts(manifest: SiteManifest): Promise<void> {
  const keep = (manifest.timeseries?.parts ?? []).map((p) => storedPath(p.path));
  for (const path of staleSplitFiles(await listSiteFiles(manifest.siteId), keep)) {
    await deleteSiteFile(manifest.siteId, path).catch(() => undefined);
  }
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
  let doneBytes = 0;

  const replaced = new Map<string, StoredFile[]>();
  for (const part of big) {
    const source = opts.sources?.get(part.path) ?? (await readSiteFile(manifest.siteId, part.path));
    const parts = await splitOne(manifest.siteId, part, source, {
      signal: opts.signal,
      onProgress: (fraction, note) => {
        const done = doneBytes + fraction * part.size;
        opts.onProgress?.({
          phase: SPLIT_PHASE,
          fraction: done / bigBytes,
          detail: part.path,
          bytes: { done, total: bigBytes },
          note,
        });
      },
    });
    replaced.set(part.path, parts);
    doneBytes += part.size;
  }

  // Only now is anything removed: every split part is complete and checked.
  // A part split from a dropped file was never stored; one of an earlier
  // import may be, and is stale now.
  for (const path of replaced.keys()) await deleteSiteFile(manifest.siteId, path);
  const parts = ts.parts.flatMap((p) => replaced.get(p.path) ?? [p]);
  const totalBytes = parts.reduce((n, p) => n + p.size, 0);
  return {
    ...manifest,
    timeseries: { ...ts, kind: parts.length > 1 ? 'directory' : ts.kind, parts, totalBytes },
    totalBytes: manifest.totalBytes - ts.totalBytes + totalBytes,
  };
}

interface SourcePlan {
  groups: Array<RowGroupStat & { rows: number }>;
  rows: number;
  /** EVI is stored as DOUBLE and is written as FLOAT. */
  eviIsDouble: boolean;
  /** Some row may have no pixel id (or the statistics do not say). */
  nulls: boolean;
  /** Bytes the parts are expected to take, at most. */
  bytes: number;
  /** The largest row group, decompressed: what one engine must hold at once. */
  largestGroup: number;
}

const rowsOf = async (conn: AsyncDuckDBConnection, sql: string) =>
  (await conn.query(sql)).toArray().map((r) => r.toJSON() as Record<string, unknown>);

/** What the file's footer says about splitting it; nothing else is read. */
async function planSource(conn: AsyncDuckDBConnection, name: string): Promise<SourcePlan> {
  const meta = await rowsOf(
    conn,
    `SELECT row_group_id AS g, path_in_schema AS col, type, total_compressed_size AS bytes,
            total_uncompressed_size AS raw, row_group_num_rows AS n, stats_min_value AS lo,
            stats_max_value AS hi, stats_null_count AS nulls
     FROM parquet_metadata(${sqlStr(name)})`,
  );
  if (!meta.some((m) => m.col === 'pixel_id')) throw new Error('it has no `pixel_id` column to split on');
  const eviIsDouble = meta.some((m) => m.col === 'evi' && m.type === 'DOUBLE');
  const groups = new Map<number, RowGroupStat & { rows: number }>();
  const raw = new Map<number, number>();
  let nulls = false;
  for (const m of meta) {
    raw.set(Number(m.g), (raw.get(Number(m.g)) ?? 0) + Number(m.raw));
    const g = groups.get(Number(m.g)) ?? { min: null, max: null, bytes: 0, rows: Number(m.n) };
    // A DOUBLE column written as FLOAT takes about half the space.
    g.bytes += Number(m.bytes) * (m.col === 'evi' && eviIsDouble ? 0.5 : 1);
    if (m.col === 'pixel_id') {
      g.min = m.lo == null ? null : Number(m.lo);
      g.max = m.hi == null ? null : Number(m.hi);
      if (m.nulls == null || Number(m.nulls) > 0) nulls = true;
    }
    groups.set(Number(m.g), g);
  }
  const list = [...groups.values()];
  return {
    groups: list,
    rows: list.reduce((n, g) => n + g.rows, 0),
    eviIsDouble,
    nulls,
    bytes: list.reduce((n, g) => n + g.bytes, 0),
    largestGroup: Math.max(0, ...raw.values()),
  };
}

/**
 * Bytes splitting this file will write, from its footer, so an import can
 * ask for room before it starts. Null when the footer cannot be read.
 */
export async function splitSizeEstimate(file: File): Promise<number | null> {
  const db = await getDb();
  const name = `split_estimate_${++splitId}.parquet`;
  let conn: AsyncDuckDBConnection | null = null;
  try {
    await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    conn = await db.connect();
    return (await planSource(conn, name)).bytes;
  } catch {
    return null;
  } finally {
    await conn?.close().catch(() => undefined);
    await db.dropFile(name).catch(() => undefined);
  }
}

interface Engine {
  db: AsyncDuckDB;
  conn: AsyncDuckDBConnection;
}

interface Job {
  index: number;
  path: string;
  estimate: PartEstimate;
  state: 'queued' | 'writing' | 'done';
  /** Bytes on disk so far, polled while it is written. */
  written: number;
  rows: number;
}

/** Rejects once the signal aborts; never resolves. */
function whenAborted(signal?: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new CancelledError());
    signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
  });
  p.catch(() => undefined);
  return p;
}

/** Delete a part, waiting for a terminated worker's file lock to be let go. */
async function deleteWhenFree(siteId: string, path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await deleteSiteFile(siteId, path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  // Still locked: removeStaleParts deletes it the next time the site opens.
}

async function splitOne(
  siteId: string,
  part: StoredFile,
  source: File,
  opts: { signal?: AbortSignal; onProgress: (fraction: number, note: string) => void },
): Promise<StoredFile[]> {
  const id = ++splitId;
  const src = `split_src_${id}.parquet`;
  const engines: AsyncDuckDB[] = [];
  const written = new Set<string>();
  const aborted = whenAborted(opts.signal);
  // DuckDB-WASM leaves a query pending forever when its worker is terminated,
  // so every wait also ends on Cancel; the engines are terminated after.
  const run = <T>(p: Promise<T>) => Promise.race([p, aborted]);
  let stopped = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  let memoryMB: number | null = null;
  // Every engine is let go in `finally`, also one that finishes starting after Cancel.
  const tracked = async () => {
    const db = await startEngine();
    if (stopped) {
      void db.terminate();
      throw new CancelledError();
    }
    engines.push(db);
    return db;
  };
  const addEngine = async (): Promise<Engine> => {
    const db = await tracked();
    // The File reader takes no lock, so every engine reads the one source,
    // whether it is in offline storage or still on the user's disk.
    await db.registerFileHandle(src, source, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    if (stopped) throw new CancelledError();
    const conn = await db.connect();
    // Whole column chunks per read: through the File reader each read is a
    // round trip to the browser, and DuckDB's small reads made it 8x slower.
    await conn.query('SET prefetch_all_parquet_files = true');
    if (memoryMB) await conn.query(`SET memory_limit = '${memoryMB}MB'`);
    return { db, conn };
  };

  try {
    const first = await run(addEngine());
    const plan = await run(planSource(first.conn, src));
    memoryMB = engineMemoryMB(plan.largestGroup);
    await run(first.conn.query(`SET memory_limit = '${memoryMB}MB'`));
    let cuts = planPixelCuts(plan.groups);
    let estimates: PartEstimate[];
    if (cuts) {
      estimates = estimateParts(plan.groups, cuts);
    } else {
      // No statistics: equal pixel ranges from one scan of the ids.
      const [r] = await run(rowsOf(first.conn, `SELECT min(pixel_id) AS lo, max(pixel_id) AS hi FROM read_parquet(${sqlStr(src)})`));
      cuts = r.lo == null ? [] : equalCuts(Number(r.lo), Number(r.hi), Math.ceil(plan.bytes / TARGET_PART_BYTES));
      estimates = Array.from({ length: cuts.length + 1 }, () => ({ rows: plan.rows / (cuts!.length + 1), bytes: plan.bytes / (cuts!.length + 1) }));
    }
    if (cuts.length === 0) throw new Error('its pixels cannot be divided into ranges');
    const n = cuts.length + 1;

    // New names each time: the site may still be using the parts of an
    // earlier split, and keeps them until this one has succeeded.
    const tag = Date.now().toString(36);
    // The largest parts first, so no engine starts a long one at the end.
    const jobs: Job[] = estimates
      .map((estimate, index) => ({ index, path: partPath(part.path, index, n, tag), estimate, state: 'queued' as const, written: 0, rows: 0 }))
      .sort((a, b) => b.estimate.rows - a.estimate.rows || a.index - b.index);
    const queue = [...jobs];

    const want = splitEngines(n, navigator.hardwareConcurrency, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    // An engine that cannot start (memory, say) only means fewer at once.
    const more = await run(Promise.allSettled(Array.from({ length: want - 1 }, () => addEngine())));
    const pool = [first, ...more.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))];

    // Progress by rows, which is what the time goes on. A part being written
    // counts by its bytes on disk against what it should come to; that ratio
    // is learned from the parts already done (v2 parts come in under plan).
    const cost = (j: Job) => j.estimate.rows || j.estimate.bytes || 1;
    const totalCost = jobs.reduce((s, j) => s + cost(j), 0);
    const handles = new Map<string, FileSystemFileHandle>();
    let shown = 0;
    let doneBytes = 0;
    let donePlanned = 0;
    const report = async () => {
      let sum = 0;
      for (const j of jobs) {
        if (j.state === 'done') sum += cost(j);
        else if (j.state === 'writing') {
          try {
            let h = handles.get(j.path);
            if (!h) handles.set(j.path, (h = await siteFileHandle(siteId, j.path)));
            j.written = (await h.getFile()).size;
          } catch {
            /* not created yet */
          }
          const ratio = donePlanned > 0 ? doneBytes / donePlanned : 0.75;
          sum += cost(j) * Math.min(0.97, j.written / Math.max(1, j.estimate.bytes * ratio));
        }
      }
      if (stopped) return;
      shown = Math.max(shown, sum / totalCost);
      const finished = jobs.filter((j) => j.state === 'done').length;
      const writing = jobs.filter((j) => j.state === 'writing').length;
      opts.onProgress(shown, `${finished} of ${n} parts done${writing > 1 ? ` · ${writing} in parallel` : ''}`);
    };
    ticker = setInterval(() => void report(), 250);

    const select = plan.eviIsDouble ? 'SELECT * REPLACE (CAST(evi AS FLOAT) AS evi)' : 'SELECT *';
    const work = async (e: Engine) => {
      for (let job = queue.shift(); job && !stopped; job = queue.shift()) {
        const target = siteFileOpfsPath(siteId, job.path);
        written.add(job.path);
        job.state = 'writing';
        await e.db.registerOPFSFileName(target);
        // USE_TMP_FILE false: over an existing file DuckDB writes `tmp_<name>` and renames
        // it, and that name has no OPFS handle ("No OPFS access handle registered").
        // The names are new, but a file left by a crash must not break the split.
        const [{ Count }] = await rowsOf(
          e.conn,
          `COPY (${select} FROM read_parquet(${sqlStr(src)}) WHERE ${rangeWhere(cuts!, job.index, plan.nulls)})
           TO ${sqlStr(target)} (FORMAT parquet, COMPRESSION zstd, PARQUET_VERSION v2, ROW_GROUP_SIZE 131072, USE_TMP_FILE false)`,
        );
        // Closes DuckDB's exclusive handle on the new file, so it can be read.
        await e.db.dropFile(target);
        job.rows = Number(Count);
        job.written = (await readSiteFile(siteId, job.path)).size;
        doneBytes += job.written;
        donePlanned += job.estimate.bytes;
        job.state = 'done';
      }
    };
    await run(Promise.all(pool.map(work)));
    clearInterval(ticker);

    // The writers are done: let their memory go before the check.
    await Promise.all(engines.splice(0).map((db) => db.terminate().catch(() => undefined)));

    // Every row of the original, once: the ranges never overlap. Both what
    // DuckDB says it wrote and what the parts' own footers say, read by a
    // new engine: one that has written and dropped several OPFS files read
    // a later part as "too small to be a Parquet file" (DuckDB-WASM 1.32).
    const copied = jobs.reduce((s, j) => s + j.rows, 0);
    const checker = await run(tracked());
    const check = jobs.map((j) => `check_${id}_${j.index}.parquet`);
    for (const [i, j] of jobs.entries()) {
      await checker.registerFileHandle(check[i], await readSiteFile(siteId, j.path), duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    }
    const [{ total }] = await run(
      rowsOf(await checker.connect(), `SELECT count(*)::BIGINT AS total FROM read_parquet([${check.map(sqlStr).join(', ')}])`),
    );
    if (Number(total) !== plan.rows || copied !== plan.rows) {
      throw new Error(`the parts hold ${Number(total).toLocaleString('en-US')} rows, the file ${plan.rows.toLocaleString('en-US')}`);
    }
    opts.onProgress(1, `${n} of ${n} parts done`);
    written.clear(); // keep them
    return jobs
      .sort((a, b) => a.index - b.index)
      .map((j) => ({ path: j.path, size: j.written }));
  } catch (err) {
    if (opts.signal?.aborted || err instanceof CancelledError) throw new CancelledError();
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`${part.path} (${formatBytes(part.size)}) could not be split: ${why}`);
  } finally {
    stopped = true;
    clearInterval(ticker);
    // Terminating closes every handle an engine holds, mid-query or not.
    await Promise.all(engines.map((db) => db.terminate().catch(() => undefined)));
    for (const path of written) await deleteWhenFree(siteId, path);
  }
}
