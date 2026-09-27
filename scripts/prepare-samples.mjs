/**
 * Build `samples/`, the sample sites the app's "Download sample sites" button
 * offers. Extracts the lab's Drive downloads and writes `samples/index.json`;
 * `npm run samples:publish` then uploads them to the public release.
 *
 *   npm run samples                       # reads ../Actual Data/*.zip
 *   SAMPLES_SRC=/path/to/zips npm run samples
 *
 * Only what the lab may redistribute is kept. Under the NASA CSDA terms for
 * the PlanetScope imagery, published WetLSP data are the annual phenometrics
 * (the NetCDFs) and the spline-smoothed daily EVI. The per-acquisition `raw`
 * EVI rows are removed from `pixels_timeseries`, and the parquet READMEs say so.
 *
 * Needs DuckDB, either the CLI (`brew install duckdb`) or Python's `duckdb`
 * module (`pip install duckdb`). SAMPLES_DUCKDB / SAMPLES_PYTHON pick a
 * specific binary.
 *
 * Re-running replaces `samples/`. The folder is git-ignored (≈1.1 GB).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, process.env.SAMPLES_SRC ?? '../Actual Data');
const OUT = join(ROOT, 'samples');

/** Order and wording chosen by the lab. Sites without a zip are skipped. */
const SITES = [
  { siteId: 'CA-DSM', name: 'Delta salt marsh', description: 'Tidal high marsh on Boundary Bay, British Columbia' },
  { siteId: 'FR-LGt', name: 'La Guette', description: 'Acidic fen in the Sologne, France, disturbed and invaded by purple moor-grass' },
  { siteId: 'BR-SM1', name: 'Cachoeira do Sul', description: 'Flooded rice paddy, Rio Grande do Sul, Brazil' },
  { siteId: 'US-BZF', name: 'Bonanza Creek fen', description: 'Rich fen in interior Alaska' },
  { siteId: 'CZ-Wet', name: 'Třeboň wet meadow', description: 'Wet sedge meadow, Czechia' },
];

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

/** Series the sample data may carry; everything else is dropped. */
const KEEP_SERIES = 'spline';

/** Run SQL with whichever DuckDB is installed; returns stdout. */
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

/** Rewrite a timeseries parquet in place with only the spline rows. */
function keepSplineOnly(file) {
  const tmp = `${file}.spline.tmp`;
  const before = duckdb(`SELECT series, count(*) FROM read_parquet(${sqlPath(file)}) GROUP BY 1 ORDER BY 1`).trim();
  duckdb(
    `COPY (SELECT * FROM read_parquet(${sqlPath(file)}) WHERE series = '${KEEP_SERIES}') ` +
      `TO ${sqlPath(tmp)} (FORMAT parquet, COMPRESSION zstd)`,
  );
  const other = Number(duckdb(`SELECT count(*) FROM read_parquet(${sqlPath(tmp)}) WHERE series IS DISTINCT FROM '${KEEP_SERIES}'`).trim());
  if (other !== 0) throw new Error(`${file}: ${other} non-${KEEP_SERIES} rows survived the filter`);
  renameSync(tmp, file);
  return before.split('\n').map((l) => l.replace(',', ': ')).join(', ');
}

const DISTRIBUTION_NOTE =
  'This copy contains only the spline-smoothed (gap-filled) daily EVI. The per-acquisition "raw" EVI series ' +
  'was removed before distribution: under the NASA CSDA Program EULA for Planet data, published WetLSP data are ' +
  'limited to the annual phenometrics and the spline-smoothed daily EVI. Includes copyrighted material of Planet ' +
  'Labs PBC. All rights reserved.';

/** Make the lab's parquet READMEs describe the file that actually ships. */
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
    for (const ds of doc.datasets ?? []) {
      if (ds.id !== 'pixels_timeseries_ds') continue;
      for (const c of ds.columns ?? []) {
        if (c.name !== 'series') continue;
        c.allowed_values = [KEEP_SERIES];
        c.description = 'Time series type: spline (gap-filled daily). The raw (per-acquisition) series is not distributed.';
      }
      ds.notes = (ds.notes ?? []).filter((n) => !/^raw series/i.test(n));
    }
    writeFileSync(json, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

if (!existsSync(SRC)) {
  console.error(`No sample source folder at ${SRC}. Set SAMPLES_SRC.`);
  process.exit(1);
}
const zips = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.zip'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sites = [];
for (const site of SITES) {
  const mine = zips.filter((z) => z.startsWith(`${site.siteId}-`) || z === `${site.siteId}.zip`);
  if (mine.length === 0) {
    console.warn(`skip ${site.siteId}: no zip in ${SRC}`);
    continue;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'wetlsp-sample-'));
  for (const z of mine) unzip(join(SRC, z), scratch);
  // Drive zips hold one top-level folder named after the site.
  const inner = existsSync(join(scratch, site.siteId)) ? join(scratch, site.siteId) : scratch;
  const dest = join(OUT, site.siteId);
  renameSync(inner, dest);
  rmSync(scratch, { recursive: true, force: true });

  for (const p of walk(dest).filter((f) => /pixels_timeseries.*\.parquet$/i.test(f))) {
    console.log(`${site.siteId}: ${relative(dest, p)} had ${keepSplineOnly(p)}; kept ${KEEP_SERIES} only`);
  }
  annotateReadmes(dest);

  const files = walk(dest).map((p) => ({ path: relative(dest, p).split('\\').join('/'), size: statSync(p).size }));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  sites.push({ ...site, bytes, files });
  console.log(`${site.siteId}: ${files.length} files, ${(bytes / 1024 ** 2).toFixed(0)} MB`);
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify({ version: 1, sites }, null, 2));
const total = sites.reduce((n, s) => n + s.bytes, 0);
console.log(`\n${sites.length} sample sites, ${(total / 1024 ** 3).toFixed(2)} GB → ${relative(ROOT, OUT)}/`);
