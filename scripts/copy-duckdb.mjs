/**
 * Copies the DuckDB-WASM runtime into public/duckdb/ so it is served as a plain
 * static asset. This keeps the 34 MB wasm out of the Rollup graph and out of the
 * service-worker precache, and gives the runtime-caching rule in vite.config.ts
 * a stable URL prefix to match on.
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../node_modules/@duckdb/duckdb-wasm/dist');
const dest = resolve(here, '../public/duckdb');

/**
 * `eh` is what every browser that can run this app actually selects; `mvp` is
 * the fallback for engines without WASM exception handling. The `coi` (threaded)
 * bundle is another 34 MB and only usable when the page is cross-origin
 * isolated, which a plain static host is not. Set WETLSP_DUCKDB_COI=1 to ship
 * it alongside COOP/COEP headers.
 */
const files = [
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
  ...(process.env.WETLSP_DUCKDB_COI === '1'
    ? ['duckdb-coi.wasm', 'duckdb-browser-coi.worker.js', 'duckdb-browser-coi.pthread.worker.js']
    : []),
];

if (!existsSync(src)) {
  console.error('copy-duckdb: @duckdb/duckdb-wasm is not installed. Run npm install first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });

let copied = 0;
for (const f of files) {
  const from = resolve(src, f);
  const to = resolve(dest, f);
  if (!existsSync(from)) continue;
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`duckdb: ${copied} file(s) copied into public/duckdb/`);
