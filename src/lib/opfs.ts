/**
 * Origin Private File System storage for ingested site data.
 *
 * Everything a user imports lands under `/sites/<siteId>/…` with its original
 * relative structure intact, so `_ds` batch directories stay directories and
 * DuckDB can glob them. OPFS gives us random-access `File` handles, which is
 * what lets DuckDB range-read a 190 MB parquet without loading it into memory.
 */

const ROOT_DIR = 'sites';
const CACHE_DIR = 'cache';

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

/** OPFS entry names must not contain separators; keep them readable anyway. */
export function safeSegment(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_') || '_';
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!opfsSupported()) {
    throw new Error(
      'This browser has no Origin Private File System, so datasets cannot be kept for offline use. Chrome or Edge 108+ is needed.',
    );
  }
  return navigator.storage.getDirectory();
}

async function dirFor(
  segments: string[],
  { create }: { create: boolean },
): Promise<FileSystemDirectoryHandle> {
  let dir = await root();
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(safeSegment(seg), { create });
  }
  return dir;
}

export async function sitesDir(create = true): Promise<FileSystemDirectoryHandle> {
  return dirFor([ROOT_DIR], { create });
}

export async function siteDir(siteId: string, create = true): Promise<FileSystemDirectoryHandle> {
  return dirFor([ROOT_DIR, siteId], { create });
}

function splitPath(relPath: string): { dirs: string[]; name: string } {
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop() ?? relPath;
  return { dirs: parts, name };
}

export async function writeSiteFile(
  siteId: string,
  relPath: string,
  data: Blob | ArrayBuffer | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<number> {
  const { dirs, name } = splitPath(relPath);
  const dir = await dirFor([ROOT_DIR, siteId, ...dirs], { create: true });
  const handle = await dir.getFileHandle(safeSegment(name), { create: true });
  const writable = await handle.createWritable();
  try {
    if (data instanceof ReadableStream) {
      // Aborting leaves the file as it was: the writes go to a swap file until close.
      await data.pipeTo(writable, { preventClose: true, preventAbort: true, signal });
      await writable.close();
    } else {
      await writable.write(data);
      await writable.close();
    }
  } catch (err) {
    await writable.abort?.();
    throw err;
  }
  return (await handle.getFile()).size;
}

export async function readSiteFile(siteId: string, relPath: string): Promise<File> {
  return (await siteFileHandle(siteId, relPath)).getFile();
}

/** The stored file's handle, for DuckDB to open a sync access handle on. */
export async function siteFileHandle(siteId: string, relPath: string): Promise<FileSystemFileHandle> {
  const { dirs, name } = splitPath(relPath);
  const dir = await dirFor([ROOT_DIR, siteId, ...dirs], { create: false });
  return dir.getFileHandle(safeSegment(name), { create: false });
}

/** Remove one stored file; nothing happens when it is already gone. */
export async function deleteSiteFile(siteId: string, relPath: string): Promise<void> {
  const { dirs, name } = splitPath(relPath);
  try {
    const dir = await dirFor([ROOT_DIR, siteId, ...dirs], { create: false });
    await dir.removeEntry(safeSegment(name));
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
  }
}

/** The `opfs://` path DuckDB writes a stored file at: the same place `writeSiteFile` would. */
export function siteFileOpfsPath(siteId: string, relPath: string): string {
  const { dirs, name } = splitPath(relPath);
  return `opfs://${[ROOT_DIR, siteId, ...dirs, name].map(safeSegment).join('/')}`;
}

export async function siteFileExists(siteId: string, relPath: string): Promise<boolean> {
  try {
    await readSiteFile(siteId, relPath);
    return true;
  } catch {
    return false;
  }
}

export async function deleteSite(siteId: string): Promise<void> {
  const dir = await sitesDir(true);
  await dir.removeEntry(safeSegment(siteId), { recursive: true });
}

export async function listStoredSites(): Promise<string[]> {
  const dir = await sitesDir(true);
  const out: string[] = [];
  // @ts-expect-error - values() is present on FileSystemDirectoryHandle at runtime.
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') out.push(entry.name);
  }
  return out.sort();
}

/** Every file stored for one site, as paths relative to its folder (stored names). */
export async function listSiteFiles(siteId: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    // @ts-expect-error - values() is present at runtime.
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') out.push(prefix + entry.name);
      else await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
    }
  };
  try {
    await walk(await siteDir(siteId, false), '');
  } catch {
    return [];
  }
  return out;
}

/** A relative path as it is stored, to compare with `listSiteFiles`. */
export function storedPath(relPath: string): string {
  return relPath.split('/').filter(Boolean).map(safeSegment).join('/');
}

/** Recursive byte total for one site, used by the left rail's size chip. */
export async function siteBytes(siteId: string): Promise<number> {
  let total = 0;
  const walk = async (dir: FileSystemDirectoryHandle) => {
    // @ts-expect-error - values() is present at runtime.
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') total += (await entry.getFile()).size;
      else await walk(entry as FileSystemDirectoryHandle);
    }
  };
  try {
    await walk(await siteDir(siteId, false));
  } catch {
    return 0;
  }
  return total;
}

/** Cache directory for derived artefacts (reprojected geometry, etc). */
export async function writeCacheFile(key: string, data: Blob | ArrayBuffer): Promise<void> {
  const dir = await dirFor([CACHE_DIR], { create: true });
  const handle = await dir.getFileHandle(safeSegment(key), { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

export async function readCacheFile(key: string): Promise<File | null> {
  try {
    const dir = await dirFor([CACHE_DIR], { create: false });
    const handle = await dir.getFileHandle(safeSegment(key), { create: false });
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteCacheFile(key: string): Promise<void> {
  try {
    const dir = await dirFor([CACHE_DIR], { create: false });
    await dir.removeEntry(safeSegment(key));
  } catch {
    /* not cached */
  }
}

/** Remove every cache file whose name starts with `prefix`. */
export async function deleteCacheFiles(prefix: string): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await dirFor([CACHE_DIR], { create: false });
  } catch {
    return;
  }
  const names: string[] = [];
  // @ts-expect-error - keys() is present on FileSystemDirectoryHandle at runtime.
  for await (const name of dir.keys()) if ((name as string).startsWith(safeSegment(prefix))) names.push(name as string);
  for (const name of names) await dir.removeEntry(name).catch(() => undefined);
}

export async function clearCache(): Promise<void> {
  try {
    const r = await root();
    await r.removeEntry(CACHE_DIR, { recursive: true });
  } catch {
    /* nothing cached yet */
  }
}

export interface StorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

/**
 * How much site data the app keeps before it asks the user to delete some.
 * The browser's own quota (a share of the free disk) can be lower; whichever
 * is smaller is the real ceiling.
 */
export const APP_STORAGE_BUDGET = 50 * 1024 ** 3;

export interface StorageBudget {
  /** Bytes of imported site data. */
  used: number;
  /** The ceiling that applies right now. */
  limit: number;
  /** True when free disk / browser quota, not the app budget, sets `limit`. */
  diskBound: boolean;
}

export function storageBudget(siteBytes: number, storage: StorageUsage): StorageBudget {
  const browserRoom = storage.quota > 0 ? storage.quota - storage.usage : Infinity;
  const byDisk = siteBytes + Math.max(0, browserRoom);
  const limit = Math.min(APP_STORAGE_BUDGET, byDisk);
  return { used: siteBytes, limit, diskBound: byDisk < APP_STORAGE_BUDGET };
}

export async function storageUsage(): Promise<StorageUsage> {
  const est = (await navigator.storage?.estimate?.()) ?? {};
  const persisted = (await navigator.storage?.persisted?.()) ?? false;
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
}

/**
 * Ask the browser to keep this origin's data. Without it a large import can be
 * evicted under storage pressure, which would silently break offline mode.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
