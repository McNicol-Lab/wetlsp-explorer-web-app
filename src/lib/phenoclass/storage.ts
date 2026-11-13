/**
 * Saved analysis runs in the Origin Private File System:
 *
 *   phenoclass/<siteId>/<runId>/manifest.json      (written last: the commit marker)
 *                               labels-<year>.u8    full-resolution, north-up, 0 = no data
 *                               status-<year>.u8    STATUS code per cell
 *                               consensus-*.u8|f32
 *
 * A directory without manifest.json is an interrupted run and is never shown.
 * Works on the main thread and in workers.
 */
import { safeSegment } from '@/lib/opfs';
import type { RunManifest } from './model';

const ROOT = 'phenoclass';

async function root(create: boolean): Promise<FileSystemDirectoryHandle> {
  const base = await navigator.storage.getDirectory();
  return base.getDirectoryHandle(ROOT, { create });
}

async function siteRoot(siteId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  return (await root(create)).getDirectoryHandle(safeSegment(siteId), { create });
}

export async function runDir(siteId: string, runId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  return (await siteRoot(siteId, create)).getDirectoryHandle(safeSegment(runId), { create });
}

function bytesOf(data: Uint8Array | Float32Array | string): Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') return new TextEncoder().encode(data) as Uint8Array<ArrayBuffer>;
  return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

export async function writeRunFile(siteId: string, runId: string, name: string, data: Uint8Array | Float32Array | string): Promise<void> {
  const dir = await runDir(siteId, runId, true);
  const handle = await dir.getFileHandle(safeSegment(name), { create: true });
  const w = await handle.createWritable();
  try {
    await w.write(bytesOf(data));
    await w.close();
  } catch (err) {
    await w.abort?.();
    throw err;
  }
}

export async function readRunFile(siteId: string, runId: string, name: string): Promise<ArrayBuffer> {
  const dir = await runDir(siteId, runId, false);
  const file = await (await dir.getFileHandle(safeSegment(name))).getFile();
  return file.arrayBuffer();
}

async function entries(dir: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
  const out: FileSystemHandle[] = [];
  // @ts-expect-error - values() exists at runtime.
  for await (const e of dir.values()) out.push(e as FileSystemHandle);
  return out;
}

/** Every complete run saved for a site, newest first. Incomplete runs are skipped. */
export async function listRuns(siteId: string): Promise<RunManifest[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await siteRoot(siteId, false);
  } catch {
    return [];
  }
  const runs: RunManifest[] = [];
  for (const e of await entries(dir)) {
    if (e.kind !== 'directory') continue;
    try {
      const f = await (await (e as FileSystemDirectoryHandle).getFileHandle('manifest.json')).getFile();
      const m = JSON.parse(await f.text()) as RunManifest;
      if (m.schema === 'wetlsp-phenoclass-run' && m.siteId === siteId) runs.push(m);
    } catch {
      /* interrupted run: no manifest */
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteRun(siteId: string, runId: string): Promise<void> {
  try {
    await (await siteRoot(siteId, false)).removeEntry(safeSegment(runId), { recursive: true });
  } catch {
    /* already gone */
  }
}

/** Remove a site's interrupted runs (directories with no manifest). */
export async function deleteIncompleteRuns(siteId: string): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await siteRoot(siteId, false);
  } catch {
    return;
  }
  for (const e of await entries(dir)) {
    if (e.kind !== 'directory') continue;
    try {
      await (e as FileSystemDirectoryHandle).getFileHandle('manifest.json');
    } catch {
      await dir.removeEntry(e.name, { recursive: true }).catch(() => undefined);
    }
  }
}

export async function deleteSiteRuns(siteId: string): Promise<void> {
  try {
    await (await root(false)).removeEntry(safeSegment(siteId), { recursive: true });
  } catch {
    /* nothing saved */
  }
}

/** Bytes on disk for one run. */
export async function runBytes(siteId: string, runId: string): Promise<number> {
  try {
    let total = 0;
    for (const e of await entries(await runDir(siteId, runId, false))) {
      if (e.kind === 'file') total += (await (e as FileSystemFileHandle).getFile()).size;
    }
    return total;
  } catch {
    return 0;
  }
}
