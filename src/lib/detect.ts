/**
 * Dataset detection: given the files a user dropped in, work out which site they
 * belong to and which logical tables they form — with zero configuration.
 *
 * Filenames in the real exports mix `_` and `-` separators
 * (`CA_DB2_pixels_geom.parquet` next to `CA-DB2-wetlsp-2021.nc`), so every match
 * runs against a normalised form and never against an exact name.
 */
import type { DatasetLayout, NetcdfFile, SiteManifest, StoredFile, StoredTable } from './types';

export interface InputFile {
  /** Path as the browser reported it, e.g. `CA-DB2/CA_DB2_pixels_geom.parquet`. */
  path: string;
  size: number;
}

const TABLE_PATTERNS: Array<{ role: 'geom' | 'meta' | 'timeseries'; re: RegExp; dir: RegExp }> = [
  { role: 'geom', re: /pixels_geom/, dir: /(^|\/)pixels_geom_ds$/ },
  { role: 'meta', re: /pixels_meta/, dir: /(^|\/)pixels_meta_ds$/ },
  { role: 'timeseries', re: /pixels_timeseries/, dir: /(^|\/)pixels_timeseries_ds$/ },
];

export function normalise(s: string): string {
  return s.toLowerCase().replace(/-/g, '_');
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function extension(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i === -1 ? '' : b.slice(i + 1).toLowerCase();
}

/**
 * Strip the common leading directory shared by every input path, so a manifest
 * is identical whether the user dropped the folder or its contents.
 */
export function stripCommonRoot(files: InputFile[]): InputFile[] {
  if (files.length === 0) return files;
  const split = files.map((f) => f.path.split('/').filter(Boolean));
  let prefix = 0;
  outer: for (;;) {
    const seg = split[0][prefix];
    // Never strip the final segment — that is the filename.
    if (seg === undefined || prefix >= split[0].length - 1) break;
    for (const parts of split) {
      if (parts.length - 1 <= prefix || parts[prefix] !== seg) break outer;
    }
    prefix++;
  }
  if (prefix === 0) return files;
  return files.map((f, i) => ({ ...f, path: split[i].slice(prefix).join('/') }));
}

/** `CA-DB2-wetlsp-2021.nc` -> `{ siteId: 'CA-DB2', year: 2021 }`. */
export function parseNetcdfName(path: string): { siteId: string | null; year: number | null } {
  const name = basename(path).replace(/\.nc$/i, '');
  const norm = normalise(name);
  if (!norm.includes('wetlsp')) return { siteId: null, year: null };
  const yearMatch = norm.match(/(19|20)\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  // Site id is whatever precedes the `wetlsp` token, in its original spelling.
  const idx = norm.indexOf('wetlsp');
  const siteId = idx > 0 ? name.slice(0, idx).replace(/[-_]+$/, '') : null;
  return { siteId: siteId || null, year };
}

/** FLUXNET-style ids: two letters, a separator, three characters (`CA-SCB`, `US_BZF`). */
export function looksLikeSiteId(s: string): boolean {
  return /^[A-Za-z]{2}[-_][A-Za-z0-9]{3}$/.test(s);
}

/** One spelling per site: `CA_DSM` and `CA-DSM` are the same site. */
export function distinctSiteIds(ids: string[]): string[] {
  const seen = new Map<string, string>();
  for (const id of ids) {
    const key = normalise(id);
    // Prefer the hyphenated spelling the data itself uses.
    if (!seen.has(key) || (id.includes('-') && !seen.get(key)!.includes('-'))) seen.set(key, id);
  }
  return [...seen.values()];
}

/**
 * A warning when `pixels_meta` names a different site than the files or the
 * folder do, or null when they agree. The meta id is still used; this only
 * makes a mislabelled download visible.
 */
export function siteIdMismatch(
  metaSiteId: string,
  named: { files: string[]; folder: string | null },
): string | null {
  const meta = normalise(metaSiteId);
  const files = named.files.filter((id) => normalise(id) !== meta);
  const folder = named.folder && normalise(named.folder) !== meta ? named.folder : null;
  if (files.length === 0 && !folder) return null;
  const where = [
    files.length ? `the file names say ${files.join(', ')}` : '',
    folder ? `the folder is named ${folder}` : '',
  ].filter(Boolean).join(' and ');
  return `pixels_meta names this site ${metaSiteId}, but ${where}. It was imported as ${metaSiteId}; check that the files belong to that site.`;
}

/** `CA_DB2_pixels_geom.parquet` -> `CA_DB2`. */
export function siteIdFromTableName(path: string): string | null {
  const name = basename(path).replace(/\.parquet$/i, '');
  const norm = normalise(name);
  const idx = norm.indexOf('pixels_');
  if (idx <= 0) return null;
  return name.slice(0, idx).replace(/[-_]+$/, '') || null;
}

export interface DetectionResult {
  siteId: string;
  /** Alternative spellings seen across filenames, for reporting. */
  siteIdCandidates: string[];
  /** Site ids spelled out by the data file names, and by the folder. */
  namedIds: { files: string[]; folder: string | null };
  layout: DatasetLayout;
  geom: StoredTable | null;
  meta: StoredTable | null;
  timeseries: StoredTable | null;
  netcdf: NetcdfFile[];
  readme: StoredFile[];
  unrecognised: StoredFile[];
  warnings: string[];
  totalBytes: number;
}

function makeTable(
  role: 'geom' | 'meta' | 'timeseries',
  parts: StoredFile[],
  kind: 'file' | 'directory',
  directory?: string,
): StoredTable {
  const sorted = [...parts].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  return {
    role,
    kind,
    directory,
    parts: sorted,
    totalBytes: sorted.reduce((s, p) => s + p.size, 0),
  };
}

/**
 * Classify a flat list of files into a site manifest skeleton. Pure and
 * synchronous — `ingest.ts` layers the async parts (reading meta, writing OPFS)
 * on top.
 */
export function detectDataset(rawFiles: InputFile[], folderHint?: string): DetectionResult {
  const files = stripCommonRoot(rawFiles.filter((f) => !basename(f.path).startsWith('.')));
  const warnings: string[] = [];
  const idVotes = new Map<string, number>();
  const fileIds = new Set<string>();
  const vote = (id: string | null, weight: number) => {
    if (!id) return;
    idVotes.set(id, (idVotes.get(id) ?? 0) + weight);
  };

  const batched: Record<string, StoredFile[]> = {};
  const single: Record<string, StoredFile[]> = {};
  const netcdf: NetcdfFile[] = [];
  const readme: StoredFile[] = [];
  const unrecognised: StoredFile[] = [];
  let totalBytes = 0;

  for (const f of files) {
    const stored: StoredFile = { path: f.path, size: f.size };
    totalBytes += f.size;
    const ext = extension(f.path);
    const normDir = normalise(dirname(f.path));
    const normBase = normalise(basename(f.path));

    if (ext === 'nc' || ext === 'nc4' || ext === 'netcdf') {
      const { siteId, year } = parseNetcdfName(f.path);
      vote(siteId, 3);
      if (siteId) fileIds.add(siteId);
      if (year === null) {
        warnings.push(`Could not read a year from "${basename(f.path)}", so it was skipped.`);
        unrecognised.push(stored);
      } else {
        netcdf.push({ ...stored, year });
      }
      continue;
    }

    if (ext === 'parquet') {
      const dirMatch = TABLE_PATTERNS.find((p) => p.dir.test(normDir));
      if (dirMatch) {
        (batched[dirMatch.role] ??= []).push(stored);
        continue;
      }
      const nameMatch = TABLE_PATTERNS.find((p) => p.re.test(normBase));
      if (nameMatch) {
        const tableId = siteIdFromTableName(f.path);
        vote(tableId, 2);
        if (tableId) fileIds.add(tableId);
        (single[nameMatch.role] ??= []).push(stored);
        continue;
      }
      unrecognised.push(stored);
      continue;
    }

    if (/^readme/.test(normBase) && (ext === 'md' || ext === 'json' || ext === 'txt')) {
      readme.push(stored);
      continue;
    }

    unrecognised.push(stored);
  }

  // A `_ds` directory always wins over a same-role single file: it is the
  // complete table, the single file would be one arbitrary part.
  const resolve = (role: 'geom' | 'meta' | 'timeseries'): StoredTable | null => {
    const dirParts = batched[role];
    if (dirParts?.length) {
      const dir = dirname(dirParts[0].path);
      return makeTable(role, dirParts, 'directory', dir);
    }
    const fileParts = single[role];
    if (fileParts?.length) {
      if (fileParts.length > 1) {
        return makeTable(role, fileParts, 'directory', dirname(fileParts[0].path));
      }
      return makeTable(role, fileParts, 'file');
    }
    return null;
  };

  const geom = resolve('geom');
  const meta = resolve('meta');
  const timeseries = resolve('timeseries');

  const hasBatched = Object.keys(batched).length > 0;
  const hasSingle = Object.keys(single).length > 0;
  const layout: DatasetLayout =
    hasBatched && hasSingle
      ? 'mixed'
      : hasBatched
        ? 'batched'
        : hasSingle
          ? 'single-file'
          : netcdf.length > 0
            ? 'single-file'
            : 'unknown';

  const folderId = folderHint ? (folderHint.replace(/\/+$/, '').split('/').pop() ?? null) : null;
  vote(folderId, 1);

  // `CA_DSM` (parquet names) and `CA-DSM` (NetCDF names) are one site: pool
  // their votes, then use the hyphenated spelling the data itself uses.
  const pooled = new Map<string, number>();
  for (const [id, score] of idVotes) pooled.set(normalise(id), (pooled.get(normalise(id)) ?? 0) + score);
  let winner = '';
  let best = -1;
  for (const [key, score] of pooled) {
    if (score > best) {
      best = score;
      winner = key;
    }
  }
  const spellings = [...idVotes.keys()].filter((id) => normalise(id) === winner);
  let siteId = spellings.find((id) => id.includes('-')) ?? spellings[0] ?? '';
  if (!siteId) siteId = 'Unknown site';

  const namedIds = {
    files: distinctSiteIds([...fileIds]),
    folder: folderId && looksLikeSiteId(folderId) ? folderId : null,
  };
  const named = distinctSiteIds([...namedIds.files, ...(namedIds.folder ? [namedIds.folder] : [])]);
  if (named.length > 1) {
    warnings.push(
      `The file and folder names refer to more than one site (${named.join(', ')}). It was imported as ${siteId}; check that these files belong together.`,
    );
  }

  // Warn about what is missing, naming the consequence rather than the file.
  if (!geom)
    warnings.push(
      'No `pixels_geom` table found, so pixels cannot be placed on the map. Time series still work if `pixels_timeseries` is present.',
    );
  if (!meta)
    warnings.push(
      'No `pixels_meta` table found, so the coordinate reference system is unknown. Pixels will stay in projected metres until a CRS is supplied.',
    );
  if (!timeseries)
    warnings.push('No `pixels_timeseries` table found, so the Time Series view will be empty.');
  if (netcdf.length === 0)
    warnings.push('No WetLSP NetCDF files found, so the Phenometrics view will be empty.');

  const dupYears = netcdf
    .map((n) => n.year)
    .filter((y, i, arr) => arr.indexOf(y) !== i)
    .filter((y, i, arr) => arr.indexOf(y) === i);
  for (const y of dupYears) {
    warnings.push(`More than one NetCDF for ${y}; the largest file was kept.`);
  }

  // Keep one NetCDF per year — the largest, which is the complete export.
  const byYear = new Map<number, NetcdfFile>();
  for (const n of netcdf) {
    const prev = byYear.get(n.year);
    if (!prev || n.size > prev.size) byYear.set(n.year, n);
  }

  return {
    siteId,
    siteIdCandidates: [...idVotes.keys()],
    namedIds,
    layout,
    geom,
    meta,
    timeseries,
    netcdf: [...byYear.values()].sort((a, b) => a.year - b.year),
    readme,
    unrecognised,
    warnings,
    totalBytes,
  };
}

/** True when there is enough here to be worth ingesting at all. */
export function isIngestable(d: DetectionResult): boolean {
  return Boolean(d.geom || d.timeseries || d.netcdf.length > 0);
}

export function manifestFromDetection(d: DetectionResult): SiteManifest {
  return {
    siteId: d.siteId,
    layout: d.layout,
    geom: d.geom,
    meta: d.meta,
    timeseries: d.timeseries,
    netcdf: d.netcdf,
    readme: d.readme,
    unrecognised: d.unrecognised,
    warnings: d.warnings,
    totalBytes: d.totalBytes,
    importedAt: Date.now(),
  };
}

/* ------------------------------------------------------- multi-site input */

/** True for a file that belongs to a WetLSP site (not a readme or stray file). */
function isSiteData(path: string): boolean {
  const ext = extension(path);
  if (ext === 'nc' || ext === 'nc4' || ext === 'netcdf') return parseNetcdfName(path).year !== null;
  if (ext !== 'parquet') return false;
  const normDir = normalise(dirname(path));
  const normBase = normalise(basename(path));
  return TABLE_PATTERNS.some((p) => p.dir.test(normDir) || p.re.test(normBase));
}

/** The folder a data file's site lives in; `_ds` batch folders belong to their parent. */
function siteRootOf(path: string): string {
  const dir = dirname(path);
  return TABLE_PATTERNS.some((p) => p.dir.test(normalise(dir))) ? dirname(dir) : dir;
}

/** `CA-DSM-20260925T181322Z-1-001.zip` -> `CA-DSM`, for use as a folder hint. */
export function cleanFolderHint(name: string): string {
  return name.replace(/\.zip$/i, '').replace(/-\d{8}T\d{6}Z(-\d+)*$/, '');
}

export interface SiteGroup<T extends InputFile> {
  /** Folder name to break site-id ties with, when the files do not say. */
  hint?: string;
  /** Files with paths relative to their own site folder. */
  files: T[];
}

/**
 * Split a folder that holds several sites (a parent folder, a drop of five
 * zips) into one group per site. A folder that holds one site comes back as a
 * single group, untouched — exactly what the importer always did.
 *
 * Sites whose files are spread across sibling folders or several archive parts
 * (Drive's `-1-001.zip`, `-1-002.zip`) are merged back together by site id,
 * with each file rebased onto its own site folder so `_ds` batches line up.
 */
export function splitSites<T extends InputFile>(input: T[]): SiteGroup<T>[] {
  const files = input.filter((f) => !basename(f.path).startsWith('.'));
  const roots = new Map<string, T[]>();
  for (const f of files) {
    if (!isSiteData(f.path)) continue;
    const root = siteRootOf(f.path);
    const list = roots.get(root);
    if (list) list.push(f);
    else roots.set(root, [f]);
  }
  if (roots.size <= 1) return [{ files: input }];

  // Readmes and other extras travel with the site folder they sit in.
  const rootList = [...roots.keys()].sort((a, b) => b.length - a.length);
  for (const f of files) {
    if (isSiteData(f.path)) continue;
    const owner = rootList.find((r) => r === '' || f.path.startsWith(`${r}/`));
    if (owner !== undefined && owner === dirname(f.path)) roots.get(owner)!.push(f);
  }

  const merged = new Map<string, SiteGroup<T>>();
  for (const [root, list] of roots) {
    const hint = cleanFolderHint(basename(root)) || undefined;
    const rebased = list.map((f) => ({
      ...f,
      path: root ? f.path.slice(root.length + 1) : f.path,
    }));
    const id = normalise(detectDataset(rebased, hint).siteId);
    const existing = merged.get(id);
    if (existing) existing.files.push(...rebased);
    else merged.set(id, { hint, files: rebased });
  }
  if (merged.size === 1) return [{ files: input }];
  return [...merged.values()].sort((a, b) =>
    (a.hint ?? '').localeCompare(b.hint ?? '', 'en', { numeric: true }),
  );
}
