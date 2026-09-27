/**
 * Vendors the Inter variable font into public/fonts so typography is identical
 * offline and on first paint. Idempotent: if the files are already there the
 * script does nothing, so a build never needs the network.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/fonts');
const cssPath = resolve(outDir, 'inter.css');

// Google Fonts serves the variable woff2 only to browsers that advertise support.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SOURCE = 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap';
const WANTED = new Set(['latin', 'latin-ext']);

if (existsSync(cssPath)) {
  console.log('fonts: public/fonts/inter.css already present, skipping download');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

async function main() {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google Fonts returned ${res.status}`);
  const css = await res.text();

  // Each @font-face block is preceded by a `/* <subset> */` comment.
  const blocks = css.split('/*').slice(1);
  const faces = [];
  for (const block of blocks) {
    const subset = block.slice(0, block.indexOf('*/')).trim();
    if (!WANTED.has(subset)) continue;
    const url = block.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    if (!url) continue;
    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
    const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() ?? '100 900';

    const file = `inter-${subset}.woff2`;
    const bin = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!bin.ok) throw new Error(`${file} returned ${bin.status}`);
    writeFileSync(resolve(outDir, file), Buffer.from(await bin.arrayBuffer()));
    faces.push({ file, range, weight, subset });
    console.log(`fonts: downloaded ${file}`);
  }

  if (faces.length === 0) throw new Error('no usable @font-face blocks found');

  const out = faces
    .map(
      (f) => `/* ${f.subset} */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: swap;
  src: url('./${f.file}') format('woff2');${f.range ? `\n  unicode-range: ${f.range};` : ''}
}`,
    )
    .join('\n\n');
  writeFileSync(cssPath, `${out}\n`);
  console.log(`fonts: wrote public/fonts/inter.css (${faces.length} faces)`);
}

main().catch((err) => {
  // A missing font is a cosmetic problem, not a build failure: the CSS font
  // stack falls back to the system sans.
  console.warn(`fonts: skipped (${err.message}); using the system sans-serif fonts instead`);
});
