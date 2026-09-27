/**
 * Turning whatever the user dropped in into a persisted, queryable site.
 *
 * Handles every input route — drag-and-drop of a folder, `webkitdirectory`
 * pickers, plain multi-file selection, `.zip` archives and the sample sites
 * bundled with the desktop app — and normalises all of them into the same
 * `{ path, size, open }` list before detection runs.
 */
import {
  basename,
  detectDataset,
  isIngestable,
  manifestFromDetection,
  siteIdMismatch,
  stripCommonRoot,
  type InputFile,
} from './detect';
import { loadManifest, saveManifest, saveSiteMeta } from './idb';
import { deleteSite, requestPersistence, writeSiteFile } from './opfs';
import { isZipPath, listZip, openZipMember } from './zip';
import type { ProgressEvent, SiteManifest, SiteMeta } from './types';

export interface IngestEntry {
  path: string;
  size: number;
  /** A real file on disk. Archive members and bundled samples stream instead. */
  file?: File;
  open?: () => Promise<ReadableStream<Uint8Array>>;
  /** Network downloads: a dropped connection retries the file a few times. */
  retryable?: boolean;
}

export function fileEntry(path: string, file: File): IngestEntry {
  return { path, size: file.size, file };
}

function openEntry(entry: IngestEntry): Promise<ReadableStream<Uint8Array>> {
  if (entry.file) return Promise.resolve(entry.file.stream() as ReadableStream<Uint8Array>);
  if (entry.open) return entry.open();
  throw new Error(`"${entry.path}" has no readable content.`);
}

/** A real `File` for the entry; archive members are small here (pixels_meta). */
async function entryAsFile(entry: IngestEntry): Promise<File> {
  if (entry.file) return entry.file;
  const blob = await new Response(await openEntry(entry)).blob();
  return new File([blob], basename(entry.path));
}

/**
 * Replace every `.zip` in the list by its members, as if the archive had been
 * extracted next to it: `Data/CA-DSM-1-001.zip` -> `Data/CA-DSM-1-001.zip/CA-DSM/…`.
 */
export async function expandArchives(entries: IngestEntry[]): Promise<IngestEntry[]> {
  const out: IngestEntry[] = [];
  for (const entry of entries) {
    if (!entry.file || !isZipPath(entry.path)) {
      out.push(entry);
      continue;
    }
    const archive = entry.file;
    let members;
    try {
      members = await listZip(archive);
    } catch (err) {
      throw new Error(`${basename(entry.path)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const m of members) {
      if (m.path.split('/').some((seg) => seg === '__MACOSX' || seg === '..')) continue;
      out.push({
        path: `${entry.path}/${m.path}`,
        size: m.size,
        open: () => openZipMember(archive, m),
      });
    }
  }
  return out;
}

export interface IngestResult {
  manifest: SiteManifest;
  meta: SiteMeta;
  /** Bytes actually written to OPFS. */
  bytesWritten: number;
}

export interface IngestOptions {
  folderHint?: string;
  onProgress?: (p: ProgressEvent) => void;
  signal?: AbortSignal;
  /** Marks bundled sample sites so they can be told apart and restored. */
  origin?: SiteManifest['origin'];
  /**
   * Called once the site id and byte count are known, before anything is
   * written. Reject to stop the import (the caller asks the user to make room).
   */
  ensureSpace?: (siteId: string, bytes: number) => Promise<void>;
}

/* --------------------------------------------------------- input routes */

/** Files from `<input webkitdirectory>` or a plain multi-file `<input>`. */
export function entriesFromFileList(list: FileList | File[]): IngestEntry[] {
  return Array.from(list).map((file) =>
    fileEntry((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file),
  );
}

/** Recursively walk a legacy `FileSystemEntry` tree from a drop. */
async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<IngestEntry[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [fileEntry(`${prefix}${entry.name}`, file)];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const out: IngestEntry[] = [];
  for (const child of children) {
    out.push(...(await walkEntry(child, `${prefix}${entry.name}/`)));
  }
  return out;
}

/** Recursively walk a File System Access handle from a drop. */
async function walkHandle(
  handle: FileSystemHandle,
  prefix: string,
): Promise<IngestEntry[]> {
  if (handle.kind === 'file') {
    const file = await (handle as FileSystemFileHandle).getFile();
    return [fileEntry(`${prefix}${handle.name}`, file)];
  }
  const out: IngestEntry[] = [];
  // @ts-expect-error - values() exists at runtime on directory handles.
  for await (const child of (handle as FileSystemDirectoryHandle).values()) {
    out.push(...(await walkHandle(child as FileSystemHandle, `${prefix}${handle.name}/`)));
  }
  return out;
}

/** Everything a drop event carries, folders expanded. */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<IngestEntry[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  if (items.length === 0) return entriesFromFileList(dt.files);

  const supportsHandles = typeof (
    items[0] as DataTransferItem & { getAsFileSystemHandle?: unknown }
  ).getAsFileSystemHandle === 'function';

  const out: IngestEntry[] = [];
  if (supportsHandles) {
    const handles = await Promise.all(
      items.map((i) =>
        (
          i as DataTransferItem & {
            getAsFileSystemHandle: () => Promise<FileSystemHandle | null>;
          }
        ).getAsFileSystemHandle(),
      ),
    );
    for (const h of handles) {
      if (h) out.push(...(await walkHandle(h, '')));
    }
    if (out.length > 0) return out;
  }

  const roots = items
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e));
  for (const root of roots) out.push(...(await walkEntry(root, '')));
  return out.length > 0 ? out : entriesFromFileList(dt.files);
}

/** Show a directory picker via the File System Access API when available. */
export async function pickDirectory(): Promise<IngestEntry[] | null> {
  // Electron exposes showDirectoryPicker, but its browser picker can remain
  // pending without displaying a dialog. Use the native directory file-input
  // chooser in desktop builds; it also preserves nested batch-folder paths.
  if (import.meta.env.MODE === 'desktop') return null;
  const picker = (
    window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
  ).showDirectoryPicker;
  if (!picker) return null;
  try {
    const dir = await picker.call(window);
    return walkHandle(dir, '');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return [];
    throw err;
  }
}

/* -------------------------------------------------------------- ingest */

/**
 * Copy one file, retrying downloads that drop part-way: flaky Wi-Fi should
 * cost a few seconds, not the whole import. Progress rewinds on each retry.
 */
async function copyWithRetry(
  siteId: string,
  entry: IngestEntry,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const attempts = entry.retryable ? 4 : 1;
  for (let attempt = 1; ; attempt++) {
    let counted = 0;
    try {
      return await copyToOpfs(siteId, entry, (n) => {
        counted += n;
        onBytes(n);
      });
    } catch (err) {
      onBytes(-counted);
      const quota = err instanceof DOMException && err.name === 'QuotaExceededError';
      if (attempt >= attempts || quota || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/** Copy one file into OPFS, counting bytes so progress stays honest on a 190 MB parquet. */
async function copyToOpfs(
  siteId: string,
  entry: IngestEntry,
  onBytes: (n: number) => void,
): Promise<number> {
  // Small files go through a single write; big ones stream so the whole parquet
  // is never resident in JS memory at once.
  if (entry.file && entry.file.size < 8 * 1024 * 1024) {
    const size = await writeSiteFile(siteId, entry.path, entry.file);
    onBytes(size);
    return size;
  }
  let written = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
  await writeSiteFile(siteId, entry.path, (await openEntry(entry)).pipeThrough(counter));
  return written;
}

/**
 * Read `pixels_meta` straight from the dropped file, before anything is written
 * to disk, so the site is stored under the id the data itself declares
 * (`CA-DB2`) rather than the one its parquet filenames imply (`CA_DB2`).
 */
async function peekMeta(parts: IngestEntry[]): Promise<SiteMeta> {
  if (parts.length === 0) return {};
  const [{ getDb, sqlStr }, duckdb] = await Promise.all([
    import('@/engine/duckdb'),
    import('@duckdb/duckdb-wasm'),
  ]);
  const db = await getDb();
  const names: string[] = [];
  try {
    for (const [i, part] of parts.entries()) {
      const name = `peek_meta_${Date.now()}_${i}.parquet`;
      await db.registerFileHandle(
        name,
        await entryAsFile(part),
        duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
        true,
      );
      names.push(name);
    }
    const conn = await db.connect();
    try {
      const ref = `read_parquet([${names.map(sqlStr).join(', ')}], union_by_name = true)`;
      const desc = await conn.query(`DESCRIBE SELECT * FROM ${ref}`);
      const cols: string[] = [];
      const child = desc.getChild('column_name');
      for (let i = 0; i < (child?.length ?? 0); i++) cols.push(String(child!.get(i)));
      if (cols.length < 2) return {};
      const lower = cols.map((c) => c.toLowerCase());
      const kIdx = Math.max(
        0,
        lower.findIndex((c) => ['key', 'name', 'field', 'k', 'attribute'].includes(c)),
      );
      const vIdx = (() => {
        const i = lower.findIndex((c) => ['value', 'val', 'v'].includes(c));
        return i >= 0 ? i : 1;
      })();
      const q = `SELECT CAST("${cols[kIdx]}" AS VARCHAR) AS k, CAST("${cols[vIdx]}" AS VARCHAR) AS v FROM ${ref}`;
      const table = await conn.query(q);
      const meta: SiteMeta = {};
      const ks = table.getChild('k');
      const vs = table.getChild('v');
      for (let i = 0; i < (ks?.length ?? 0); i++) {
        meta[String(ks!.get(i))] = String(vs!.get(i));
      }
      return meta;
    } finally {
      await conn.close();
    }
  } finally {
    for (const n of names) {
      try {
        await db.dropFile(n);
      } catch {
        /* nothing to drop */
      }
    }
  }
}

export async function ingestEntries(
  entries: IngestEntry[],
  opts: IngestOptions = {},
): Promise<IngestResult> {
  // Drop OS cruft (`.DS_Store`, `._*`) before anything else looks at the list.
  const kept = entries.filter((e) => !basename(e.path).startsWith('.'));
  const input: InputFile[] = kept.map((e) => ({ path: e.path, size: e.size }));

  // Strip the shared folder prefix once, here, so the paths used for storage are
  // exactly the paths detection classified.
  const rel = stripCommonRoot(input).map((f) => f.path);
  const files: IngestEntry[] = kept.map((e, i) => ({ ...e, path: rel[i] }));

  const detection = detectDataset(
    files.map((f) => ({ path: f.path, size: f.size })),
    opts.folderHint,
  );

  if (!isIngestable(detection)) {
    throw new Error(
      'No WetLSP data found here. A site folder should contain `*pixels_geom*.parquet`, `*pixels_timeseries*.parquet` and/or `*-wetlsp-<year>.nc` files.',
    );
  }

  let siteId = detection.siteId;
  let meta: SiteMeta = {};
  const byPath = new Map(files.map((f) => [f.path, f]));
  const metaParts = (detection.meta?.parts ?? [])
    .map((p) => byPath.get(p.path))
    .filter((e): e is IngestEntry => Boolean(e));

  const progress = throttleProgress(opts.onProgress);
  progress({ phase: 'Identifying site', fraction: null });
  try {
    meta = await peekMeta(metaParts);
    const declared = meta.site_id?.trim();
    if (declared) {
      const mismatch = siteIdMismatch(declared, detection.namedIds);
      if (mismatch) detection.warnings.push(mismatch);
      siteId = declared;
    }
  } catch (err) {
    // Detection already produced a usable id; the meta is re-read when the
    // site opens, so a transient failure here is not saved as "no metadata".
    meta = {};
    detection.warnings.push(
      `Could not read \`pixels_meta\` while importing (${(err instanceof Error ? err.message : String(err)).split('\n')[0]}), so the site id came from the file names.`,
    );
  }

  // Only the files the manifest references are copied; stray downloads and
  // unrelated files in a parent folder are never written to storage.
  const keep = new Set(
    [
      ...(detection.geom?.parts ?? []),
      ...(detection.meta?.parts ?? []),
      ...(detection.timeseries?.parts ?? []),
      ...detection.netcdf,
      ...detection.readme,
    ].map((f) => f.path),
  );
  const toCopy = files.filter((f) => keep.has(f.path));
  const total = toCopy.reduce((s, e) => s + e.size, 0);

  await opts.ensureSpace?.(siteId, total);
  await requestPersistence();

  const isNew = !(await loadManifest(siteId));
  const phase = toCopy.some((e) => e.retryable) ? 'Downloading' : 'Copying into offline storage';
  let done = 0;
  let bytesWritten = 0;
  try {
    for (const entry of toCopy) {
      if (opts.signal?.aborted) throw new Error('Import cancelled.');
      progress({
        phase,
        fraction: total > 0 ? done / total : null,
        detail: entry.path,
      });
      bytesWritten += await copyWithRetry(
        siteId,
        entry,
        (n) => {
          done += n;
          progress({
            phase,
            fraction: total > 0 ? Math.min(1, done / total) : null,
            detail: entry.path,
          });
        },
        opts.signal,
      );
    }
  } catch (err) {
    // A half-copied new site would be invisible yet still use disk space.
    if (isNew) await deleteSite(siteId).catch(() => undefined);
    throw err;
  }

  const manifest = manifestFromDetection({ ...detection, siteId });
  manifest.totalBytes = bytesWritten;
  if (opts.origin) manifest.origin = opts.origin;
  await saveManifest(manifest);
  await saveSiteMeta(siteId, meta);

  progress({ phase: 'Ready', fraction: 1 }, true);
  return { manifest, meta, bytesWritten };
}

/**
 * A 300 MB copy reports thousands of chunks; re-rendering the app for each one
 * is what made big imports feel frozen. Forward at most ~8 updates a second,
 * plus every change of phase or file.
 */
function throttleProgress(
  fn: ((p: ProgressEvent) => void) | undefined,
): (p: ProgressEvent, force?: boolean) => void {
  let last = 0;
  let lastKey = '';
  return (p, force = false) => {
    if (!fn) return;
    const key = `${p.phase}|${p.detail ?? ''}`;
    const now = performance.now();
    if (!force && key === lastKey && now - last < 120) return;
    last = now;
    lastKey = key;
    fn(p);
  };
}
