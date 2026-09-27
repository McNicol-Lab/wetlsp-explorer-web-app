/**
 * Upload the sample sites the app's "Download sample sites" button fetches.
 *
 *   npm run samples                        # 1. extract ../Actual Data/*.zip into samples/
 *   npm run samples:publish -- --dry-run   # 2a. check the files, write the index, upload nothing
 *   npm run samples:publish -- --stage DIR # 2b. or lay out the release in DIR to upload by hand
 *   npm run samples:publish                # 2c. upload them as a public GitHub release
 *
 * The release lives in the lab's organization (McNicol-Lab/wetlsp-sample-data)
 * and must be public: the app downloads it without signing in. Its download
 * URL is fixed in desktop/server.mjs (SAMPLE_RELEASE), so a new repo or tag
 * means updating that constant too; the script refuses to run otherwise.
 *
 * Before anything is uploaded, every `pixels_timeseries` file is checked to
 * hold only the spline series: raw per-acquisition EVI must never be published
 * (see prepare-samples.mjs).
 *
 * Each site file becomes one release asset named `<site>--<file>`, plus an
 * `index.json` listing them. The app also bundles a copy of that index
 * (src/lib/sample-index.json, written here), so the button works without a
 * network round trip and the app knows sizes before downloading.
 *
 * Requires the GitHub CLI (`gh auth login`). Re-running re-uploads (--clobber).
 */
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SAMPLE_RELEASE } from '../desktop/server.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SAMPLES_REPO ?? 'McNicol-Lab/wetlsp-sample-data';
const TAG = process.env.SAMPLES_TAG ?? 'v2';
const SRC = join(ROOT, 'samples');
const DRY_RUN = process.argv.includes('--dry-run');
const STAGE_AT = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : null;
if (process.argv.includes('--stage') && !STAGE_AT) {
  console.error('--stage needs a folder: npm run samples:publish -- --stage ../wetlsp-sample-data-v2');
  process.exit(1);
}

const expected = `https://github.com/${REPO}/releases/download/${TAG}/`;
if (SAMPLE_RELEASE !== expected) {
  console.error(`desktop/server.mjs downloads from ${SAMPLE_RELEASE}\nbut this would publish to ${expected}.\nUpdate SAMPLE_RELEASE first.`);
  process.exit(1);
}

/** Series found in a parquet file, via the DuckDB CLI or Python's duckdb. */
function seriesIn(file) {
  const sql = `SELECT DISTINCT coalesce(series, '<null>') FROM read_parquet('${file.replace(/'/g, "''")}') ORDER BY 1`;
  try {
    return execFileSync(process.env.SAMPLES_DUCKDB ?? 'duckdb', ['-noheader', '-csv', '-c', sql], { encoding: 'utf8' })
      .trim().split('\n');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return execFileSync(process.env.SAMPLES_PYTHON ?? 'python3',
    ['-c', 'import sys, duckdb; print("\\n".join(r[0] for r in duckdb.sql(sys.argv[1]).fetchall()))', sql],
    { encoding: 'utf8' }).trim().split('\n');
}

const gh = (...args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const index = JSON.parse(readFileSync(join(SRC, 'index.json'), 'utf8'));

for (const site of index.sites) {
  for (const f of site.files.filter((x) => /pixels_timeseries.*\.parquet$/i.test(x.path))) {
    const series = seriesIn(join(SRC, site.siteId, f.path));
    if (series.length !== 1 || series[0] !== 'spline') {
      console.error(`${site.siteId}/${f.path} holds series ${series.join(', ')}. Only spline may be published; run npm run samples.`);
      process.exit(1);
    }
  }
}
console.log('Checked: every pixels_timeseries file holds only the spline series.');
const stage = STAGE_AT ? resolve(STAGE_AT) : join(tmpdir(), `wetlsp-samples-${Date.now()}`);
if (STAGE_AT) rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const assets = [];
for (const site of index.sites) {
  for (const f of site.files) {
    if (f.path.includes('/')) throw new Error(`Nested sample files are not supported: ${site.siteId}/${f.path}`);
    f.asset = `${site.siteId}--${f.path}`;
    // Hard links: no second 1.3 GB copy on disk.
    linkSync(join(SRC, site.siteId, f.path), join(stage, f.asset));
    assets.push(join(stage, f.asset));
  }
}
const published = { version: 1, repo: REPO, tag: TAG, sites: index.sites };
writeFileSync(join(stage, 'index.json'), JSON.stringify(published, null, 2));
writeFileSync(join(ROOT, 'src/lib/sample-index.json'), `${JSON.stringify(published, null, 2)}\n`);
if (DRY_RUN) {
  rmSync(stage, { recursive: true, force: true });
  const total = index.sites.reduce((n, s) => n + s.bytes, 0);
  console.log(`Dry run: wrote src/lib/sample-index.json for ${assets.length} files (${(total / 1024 ** 3).toFixed(2)} GB). Nothing uploaded.`);
  process.exit(0);
}

const NOTES = [
  ...index.sites.map((s) => `- **${s.siteId}**: ${s.name}. ${s.description}`),
  '',
  'Each site has its annual phenometrics (NetCDF, 2021–2024) and the spline-smoothed daily EVI (parquet). ' +
    'Per-acquisition (raw) EVI is not distributed, per the NASA CSDA Program EULA for Planet data.',
  '',
  'This work utilized data made available through the NASA Commercial Satellite Data Acquisition (CSDA) Program. ' +
    'Includes copyrighted material of Planet Labs PBC. All rights reserved.',
].join('\n');

if (STAGE_AT) {
  writeFileSync(join(stage, 'RELEASE-NOTES.md'), `${NOTES}\n`);
  const total = index.sites.reduce((n, s) => n + s.bytes, 0);
  console.log([
    `Staged ${assets.length + 1} files (${(total / 1024 ** 3).toFixed(2)} GB) in ${stage}`,
    `Upload every file except RELEASE-NOTES.md as the assets of release ${TAG} on the public repo ${REPO},`,
    'with RELEASE-NOTES.md as the release description. With the GitHub CLI:',
    `  gh release create ${TAG} --repo ${REPO} --title "Sample sites ${TAG}" --notes-file RELEASE-NOTES.md $(ls | grep -v RELEASE-NOTES.md)`,
  ].join('\n'));
  process.exit(0);
}

try {
  gh('repo', 'view', REPO);
} catch {
  gh('repo', 'create', REPO, '--public', '--description',
    'Sample WetLSP sites (annual phenometrics and spline-smoothed daily EVI) downloaded by WetLSP Explorer');
}
try {
  gh('release', 'view', TAG, '--repo', REPO);
} catch {
  gh('release', 'create', TAG, '--repo', REPO, '--title', `Sample sites ${TAG}`, '--notes', NOTES);
}

// A few files per call keeps a failed upload cheap to retry.
const batch = [join(stage, 'index.json'), ...assets];
for (let i = 0; i < batch.length; i += 5) {
  const part = batch.slice(i, i + 5);
  console.log(`uploading ${i + part.length}/${batch.length}`);
  gh('release', 'upload', TAG, ...part, '--repo', REPO, '--clobber');
}
rmSync(stage, { recursive: true, force: true });
console.log(`\nPublished ${assets.length} files to https://github.com/${REPO}/releases/tag/${TAG}`);
