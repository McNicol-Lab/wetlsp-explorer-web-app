/**
 * Build `samples/`, the sample sites the app's "Download sample sites" button
 * offers. Extracts the lab's Drive downloads and writes `samples/index.json`;
 * `npm run samples:publish` then uploads them to the public release.
 *
 *   npm run samples                       # reads ../Actual Data/*.zip
 *   SAMPLES_SRC=/path/to/zips npm run samples
 *   SAMPLES_OUT=/elsewhere npm run samples  # build somewhere other than samples/
 *   SAMPLES_SITE_DIRS=~/Desktop/AU-Arc npm run samples  # a site from a folder, not a zip
 *
 * A site comes from its Drive zip(s) in the source folder, or from a folder
 * named after it (in the source folder or listed in SAMPLES_SITE_DIRS).
 *
 * From release v3 the sample data carry both EVI series: the spline-smoothed
 * daily EVI (`series = 'spline'`) and the per-acquisition EVI
 * (`series = 'raw'`), which the lab was approved to share in October 2026.
 * The lab's files are copied byte for byte; nothing is filtered out. A
 * `pixels_timeseries` file holding any other series, or missing either one,
 * stops that site.
 *
 * One exception: GitHub release files must be under 2 GiB, and some time
 * series are larger (AU-Arc 2.83 GB). A time series over 768 MB is split by
 * pixel range with EVI as FLOAT, exactly as the app splits it on import
 * (src/lib/splitPlan.ts), so the download is what the app would store
 * anyway. Every row is kept; the counts and EVI sums per series and year are
 * checked against the original, and the site's README says so. Needs Node
 * 22.18+ (it imports that TypeScript file).
 *
 * Every run also compares each site with the release the app currently
 * points at (src/lib/sample-index.json). Adding raw rows changes only the
 * time series and the READMEs, so a geometry, metadata or NetCDF file of a
 * different size means the zip is a different version of the site than the
 * one published. Such a site is held back, and `samples:publish` refuses to
 * run, until the right zip is supplied or SAMPLES_ALLOW_CHANGED=SITE,SITE
 * confirms the change is intended. The comparison, row counts per series and
 * year, EVI ranges and SHA-256 checksums go to `RELEASE-DIFF.md`.
 *
 * Needs DuckDB, either the CLI (`brew install duckdb`) or Python's `duckdb`
 * module (`pip install duckdb`). SAMPLES_DUCKDB / SAMPLES_PYTHON pick a
 * specific binary.
 *
 * Re-running replaces the output folder. `samples/` is git-ignored (≈1.4 GB).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { equalCuts, partPath, planPixelCuts, rangeWhere, SPLIT_ABOVE_BYTES, TARGET_PART_BYTES } from '../src/lib/splitPlan.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, process.env.SAMPLES_SRC ?? '../Actual Data');
const OUT = resolve(ROOT, process.env.SAMPLES_OUT ?? 'samples');
const ALLOW_CHANGED = new Set((process.env.SAMPLES_ALLOW_CHANGED ?? '').split(',').map((s) => s.trim()).filter(Boolean));
/** Site folders given directly, keyed by folder name (the site id). */
const SITE_DIRS = new Map(
  (process.env.SAMPLES_SITE_DIRS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^~(?=\/)/, homedir()))
    .filter(Boolean)
    .map((d) => [basename(resolve(d)), resolve(d)]),
);

/** Order and wording chosen by the lab. Sites without a zip are skipped. */
const SITES = [
  { siteId: 'CA-DSM', name: 'Delta salt marsh', description: 'Tidal high marsh on Boundary Bay, British Columbia' },
  { siteId: 'FR-LGt', name: 'La Guette', description: 'Acidic fen in the Sologne, France, disturbed and invaded by purple moor-grass' },
  { siteId: 'BR-SM1', name: 'Cachoeira do Sul', description: 'Flooded rice paddy, Rio Grande do Sul, Brazil' },
  { siteId: 'US-BZF', name: 'Bonanza Creek fen', description: 'Rich fen in interior Alaska' },
  { siteId: 'CZ-Wet', name: 'Třeboň wet meadow', description: 'Wet sedge meadow, Czechia' },
  // Placeholder wording until the lab supplies its own.
  { siteId: 'AU-Arc', name: 'Arcturus', description: 'Site in central Queensland, Australia' },
];

/** Series the sample data carry. Both must be present; nothing else may be. */
const SAMPLE_SERIES = ['raw', 'spline'];

function unzip(zip, into) {
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', into], { stdio: 'inherit' });
  } catch {
    // Windows 10+ ships bsdtar, which reads zip archives.
    execFileSync('tar', ['-xf', zip, '-C', into], { stdio: 'inherit' });
  }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.name.startsWith('.') || e.name === '__MACOSX') return [];
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** Run SQL with whichever DuckDB is installed; returns stdout as CSV rows. */
function duckdb(sql) {
  const cli = process.env.SAMPLES_DUCKDB ?? 'duckdb';
  try {
    return execFileSync(cli, ['-noheader', '-csv', '-c', sql], { encoding: 'utf8' });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const python = process.env.SAMPLES_PYTHON ?? 'python3';
  const script =
    'import sys, duckdb\n' +
    'rows = duckdb.sql(sys.argv[1])\n' +
    'print("\\n".join(",".join(str(v) for v in r) for r in rows.fetchall()) if rows is not None else "")';
  try {
    return execFileSync(python, ['-c', script, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT' || /No module named 'duckdb'/.test(String(err.stderr))) {
      console.error('DuckDB is required: install the CLI (brew install duckdb) or `pip install duckdb`.');
      process.exit(1);
    }
    throw new Error(`DuckDB failed: ${String(err.stderr || err.message).trim()}`);
  }
}

const sqlPath = (p) => `'${p.replace(/'/g, "''")}'`;
const rows = (csv) => csv.trim().split('\n').filter(Boolean).map((l) => l.split(','));

/** Row counts, pixels and EVI range per series and year of a site's timeseries file(s). */
function seriesStats(files) {
  return rows(
    duckdb(
      `SELECT coalesce(series, '<null>'), year, count(*), count(DISTINCT pixel_id), min(evi), max(evi), ` +
        `count(*) FILTER (WHERE evi > 1 OR evi < -1) ` +
        `FROM read_parquet([${files.map(sqlPath).join(', ')}]) GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  ).map(([series, year, n, pixels, min, max, outOfRange]) => ({
    series, year: Number(year), rows: Number(n), pixels: Number(pixels), min: Number(min), max: Number(max), outOfRange: Number(outOfRange),
  }));
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

const DISTRIBUTION_NOTE =
  'This copy contains both EVI series: the spline-smoothed, gap-filled daily EVI (series = "spline") and the ' +
  'per-acquisition EVI computed from each clear PlanetScope scene (series = "raw"). The raw series is shared with ' +
  'approval, as a derived product of PlanetScope imagery obtained through the NASA Commercial Satellite Data ' +
  'Acquisition (CSDA) Program. PlanetScope scenes, surface reflectance bands and quality masks are not included. ' +
  'Includes copyrighted material of Planet Labs PBC. All rights reserved.';

/** Make the lab's parquet READMEs say what the copy holds and under what terms. */
function annotateReadmes(dir) {
  const md = join(dir, 'README_parquet.md');
  if (existsSync(md)) {
    const text = readFileSync(md, 'utf8');
    if (!text.includes('Distribution note')) {
      const [title, ...rest] = text.split('\n');
      writeFileSync(md, [title, '', '## Distribution note', '', DISTRIBUTION_NOTE, '', ...rest].join('\n'));
    }
  }
  const json = join(dir, 'README_parquet.json');
  if (existsSync(json)) {
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    doc.distribution_note = DISTRIBUTION_NOTE;
    writeFileSync(json, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

const splitNote = (from, parts) =>
  `In this copy the time series is split into ${parts} files by pixel range ` +
  `(part-1-of-${parts} … part-${parts}-of-${parts}, rows in their original order), with evi stored as 32-bit float, ` +
  `because GitHub release files must be under 2 GiB. The original ${from} holds the same rows with evi as 64-bit float. ` +
  'WetLSP Explorer stores every large time series this way.';

/**
 * Split a time series too large for a release file into pixel-range parts,
 * EVI as FLOAT, as the app does on import. Checks every series-year keeps its
 * rows and EVI sum, then removes the original. Returns the README note.
 */
function splitTimeseries(file) {
  // Drive names a re-downloaded file `…_pixels_timeseries-001.parquet`.
  const canonical = file.replace(/(pixels_timeseries)-\d+(\.parquet)$/i, '$1$2');
  if (canonical !== file) renameSync(file, canonical);
  const groups = rows(
    duckdb(
      `SELECT row_group_id, sum(total_compressed_size * CASE WHEN path_in_schema = 'evi' AND type = 'DOUBLE' THEN 0.5 ELSE 1 END), ` +
        `max(CASE WHEN path_in_schema = 'pixel_id' THEN stats_min_value END), max(CASE WHEN path_in_schema = 'pixel_id' THEN stats_max_value END) ` +
        `FROM parquet_metadata(${sqlPath(canonical)}) GROUP BY 1`,
    ),
  ).map(([, bytes, min, max]) => ({ bytes: Number(bytes), min: min === '' || min === 'None' ? null : Number(min), max: max === '' || max === 'None' ? null : Number(max) }));
  let cuts = planPixelCuts(groups, TARGET_PART_BYTES);
  if (!cuts) {
    const [[lo, hi]] = rows(duckdb(`SELECT min(pixel_id), max(pixel_id) FROM read_parquet(${sqlPath(canonical)})`));
    const expected = groups.reduce((n, g) => n + g.bytes, 0);
    cuts = equalCuts(Number(lo), Number(hi), Math.ceil(expected / TARGET_PART_BYTES));
  }
  const n = cuts.length + 1;
  const parts = Array.from({ length: n }, (_, i) => join(dirname(canonical), basename(partPath(basename(canonical), i, n))));
  parts.forEach((part, i) =>
    duckdb(
      `COPY (SELECT * REPLACE (CAST(evi AS FLOAT) AS evi) FROM read_parquet(${sqlPath(canonical)}) WHERE ${rangeWhere(cuts, i)}) ` +
        `TO ${sqlPath(part)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 131072)`,
    ),
  );
  // Same rows per series and year; the same EVI up to float rounding.
  const per = (src, cast) =>
    new Map(
      rows(duckdb(`SELECT coalesce(series, '<null>'), year, count(*), count(evi), sum(${cast}) FROM read_parquet(${src}) GROUP BY 1, 2`)).map(
        ([s, y, nRows, nEvi, sum]) => [`${s}|${y}`, { nRows: Number(nRows), nEvi: Number(nEvi), sum: Number(sum) }],
      ),
    );
  const before = per(sqlPath(canonical), 'CAST(evi AS FLOAT)');
  const after = per(`[${parts.map(sqlPath).join(', ')}]`, 'evi');
  for (const [k, b] of before) {
    const a = after.get(k);
    if (!a || a.nRows !== b.nRows || a.nEvi !== b.nEvi || Math.abs(a.sum - b.sum) > 1e-6 * Math.max(1, Math.abs(b.sum))) {
      throw new Error(`splitting ${basename(canonical)} changed ${k.replace('|', ' ')}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`);
    }
  }
  if (after.size !== before.size) throw new Error(`splitting ${basename(canonical)} changed the series or years`);
  const from = basename(canonical);
  rmSync(canonical);
  const mb = parts.reduce((t, f) => t + statSync(f).size, 0) / 1024 ** 2;
  console.log(`  split ${from} into ${n} parts, ${mb.toFixed(0)} MB in all`);
  return splitNote(from, n);
}

/** A README for a site folder that came without one, so the distribution note travels with it. */
function ensureReadme(dir, siteId) {
  if (existsSync(join(dir, 'README_parquet.md'))) return;
  writeFileSync(
    join(dir, 'README_parquet.md'),
    `# WetLSP pixel-level EVI time series (Parquet): ${siteId}\n\n` +
      'Files as described in the WetLSP data package README: `<SITE_>_pixels_geom.parquet` (pixel_id, cell, x, y), ' +
      '`<SITE_>_pixels_meta.parquet` (crs_wkt, site_id, radius_m, pixel_id_source), `<SITE_>_pixels_timeseries.parquet` ' +
      '(pixel_id, series, date, year, evi) and `<SITE>-wetlsp-<YEAR>.nc` annual phenometrics.\n',
  );
}

/** Add a paragraph under the distribution note of the site's READMEs. */
function noteInReadmes(dir, note) {
  const md = join(dir, 'README_parquet.md');
  if (existsSync(md)) writeFileSync(md, readFileSync(md, 'utf8').replace(DISTRIBUTION_NOTE, `${DISTRIBUTION_NOTE}\n\n${note}`));
  const json = join(dir, 'README_parquet.json');
  if (existsSync(json)) {
    const doc = JSON.parse(readFileSync(json, 'utf8'));
    doc.distribution_split_note = note;
    writeFileSync(json, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

/** The release the app currently downloads: what each site's files were. */
function publishedIndex() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'src/lib/sample-index.json'), 'utf8'));
  } catch {
    return { tag: null, sites: [] };
  }
}

/** Files whose size differs from the published release, other than the ones raw rows change. */
function changedFromPublished(siteId, files, previous) {
  const before = previous.sites.find((s) => s.siteId === siteId);
  if (!before) return [];
  const isExpectedChange = (p) => /pixels_timeseries.*\.parquet$|^README_parquet\./i.test(p);
  const out = [];
  for (const f of files) {
    if (isExpectedChange(f.path)) continue;
    const old = before.files.find((o) => o.path === f.path);
    if (!old) out.push(`${f.path}: new file`);
    else if (old.size !== f.size) out.push(`${f.path}: ${old.size.toLocaleString('en-US')} → ${f.size.toLocaleString('en-US')} bytes`);
  }
  for (const old of before.files) {
    if (!isExpectedChange(old.path) && !files.some((f) => f.path === old.path)) out.push(`${old.path}: missing`);
  }
  return out;
}

if (!existsSync(SRC)) {
  console.error(`No sample source folder at ${SRC}. Set SAMPLES_SRC.`);
  process.exit(1);
}
const zips = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.zip'));
const previous = publishedIndex();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sites = [];
const heldBack = [];
const report = [
  '# Sample data release check',
  '',
  `Built ${new Date().toISOString().slice(0, 10)} from \`${relative(ROOT, SRC) || SRC}\`, compared with the published release \`${previous.tag ?? 'none'}\`.`,
  '',
];

for (const site of SITES) {
  const mine = zips.filter((z) => z.startsWith(`${site.siteId}-`) || z === `${site.siteId}.zip`);
  const folder = SITE_DIRS.get(site.siteId) ?? (existsSync(join(SRC, site.siteId)) ? join(SRC, site.siteId) : null);
  if (mine.length === 0 && !folder) {
    console.warn(`skip ${site.siteId}: no zip or folder in ${SRC}`);
    report.push(`## ${site.siteId}`, '', `Skipped: no zip or folder in the source folder.`, '');
    continue;
  }
  const dest = join(OUT, site.siteId);
  if (mine.length) {
    const scratch = mkdtempSync(join(tmpdir(), 'wetlsp-sample-'));
    for (const z of mine) unzip(join(SRC, z), scratch);
    // Drive zips hold one top-level folder named after the site.
    const inner = existsSync(join(scratch, site.siteId)) ? join(scratch, site.siteId) : scratch;
    renameSync(inner, dest);
    rmSync(scratch, { recursive: true, force: true });
  } else {
    // A copy-on-write clone where the disk allows, so a 3 GB folder costs nothing.
    cpSync(folder, dest, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (p) => !basename(p).startsWith('.') });
  }

  const problems = [];
  const notes = [];
  for (const p of walk(dest).filter((f) => /pixels_timeseries.*\.parquet$/i.test(f) && statSync(f).size > SPLIT_ABOVE_BYTES)) {
    try {
      notes.push(splitTimeseries(p));
    } catch (err) {
      problems.push(err.message);
    }
  }
  const tsFiles = walk(dest).filter((f) => /pixels_timeseries.*\.parquet$/i.test(f));
  const stats = tsFiles.length ? seriesStats(tsFiles) : [];
  const found = [...new Set(stats.map((r) => r.series))].sort();
  const extra = found.filter((x) => !SAMPLE_SERIES.includes(x));
  const missing = SAMPLE_SERIES.filter((x) => !found.includes(x));
  if (!tsFiles.length) problems.push('no pixels_timeseries file');
  if (extra.length) problems.push(`the time series holds unexpected series: ${extra.join(', ')}`);
  if (missing.length) problems.push(`the time series is missing the ${missing.join(' and ')} series`);
  ensureReadme(dest, site.siteId);
  annotateReadmes(dest);
  for (const note of notes) noteInReadmes(dest, note);

  const files = [];
  for (const p of walk(dest)) {
    files.push({ path: relative(dest, p).split('\\').join('/'), size: statSync(p).size, sha256: await sha256(p) });
  }
  const changed = changedFromPublished(site.siteId, files, previous);
  if (changed.length && !ALLOW_CHANGED.has(site.siteId)) {
    problems.push(
      `differs from the published ${previous.tag} copy beyond the time series (${changed.join('; ')}). ` +
        'The zip may be an older or newer version of the site. Supply the matching zip, or set ' +
        `SAMPLES_ALLOW_CHANGED=${site.siteId} if the change is intended.`,
    );
  }

  const bytes = files.reduce((n, f) => n + f.size, 0);
  report.push(`## ${site.siteId}`, '');
  report.push('| series | year | rows | pixels | EVI min | EVI max | EVI outside −1…1 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of stats) {
    report.push(`| ${r.series} | ${r.year} | ${r.rows.toLocaleString('en-US')} | ${r.pixels.toLocaleString('en-US')} | ${r.min.toFixed(4)} | ${r.max.toFixed(4)} | ${r.outOfRange.toLocaleString('en-US')} |`);
  }
  const outOfRange = stats.reduce((n, r) => n + r.outOfRange, 0);
  report.push('');
  if (outOfRange) report.push(`**For the PI:** ${outOfRange.toLocaleString('en-US')} EVI values fall outside −1…1. Shipped as provided; not altered.`, '');
  if (changed.length) report.push(`Changed from ${previous.tag}: ${changed.join('; ')}${ALLOW_CHANGED.has(site.siteId) ? ' (allowed by SAMPLES_ALLOW_CHANGED)' : ''}.`, '');
  if (!previous.sites.some((s) => s.siteId === site.siteId)) report.push(`New site: not in ${previous.tag ?? 'any earlier release'}.`, '');
  for (const note of notes) report.push(`**Split:** ${note} Rows and EVI sums per series and year checked against the original.`, '');
  report.push('<details><summary>Files and SHA-256</summary>', '', '| file | bytes | sha256 |', '| --- | ---: | --- |');
  for (const f of files) report.push(`| ${f.path} | ${f.size.toLocaleString('en-US')} | \`${f.sha256}\` |`);
  report.push('', '</details>', '');

  if (problems.length) {
    heldBack.push({ siteId: site.siteId, problems });
    report.push(`**Held back:** ${problems.join(' ')}`, '');
    console.error(`HOLD ${site.siteId}: ${problems.join(' ')}`);
    continue;
  }
  sites.push({ ...site, bytes, files });
  const summary = SAMPLE_SERIES.map((s) => `${s} ${stats.filter((r) => r.series === s).reduce((n, r) => n + r.rows, 0).toLocaleString('en-US')} rows`).join(', ');
  console.log(`${site.siteId}: ${files.length} files, ${(bytes / 1024 ** 2).toFixed(0)} MB (${summary})`);
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify({ version: 1, sites, heldBack }, null, 2));
writeFileSync(join(OUT, 'RELEASE-DIFF.md'), `${report.join('\n')}\n`);
const total = sites.reduce((n, s) => n + s.bytes, 0);
console.log(`\n${sites.length} sample sites, ${(total / 1024 ** 3).toFixed(2)} GB → ${relative(ROOT, OUT) || OUT}/  (report: RELEASE-DIFF.md)`);
if (heldBack.length) {
  console.error(`${heldBack.length} site(s) held back: ${heldBack.map((h) => h.siteId).join(', ')}. samples:publish will refuse until they are resolved.`);
  process.exit(2);
}
