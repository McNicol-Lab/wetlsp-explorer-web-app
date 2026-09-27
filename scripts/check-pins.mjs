/**
 * The map stack is pinned to exact versions: MapCanvas drives deck.gl's
 * interleaved MapLibre overlay and picking internals, which change between
 * minor releases. Fails if a pin became a range or the lockfile drifted.
 *
 *   node scripts/check-pins.mjs
 */
import { readFileSync } from 'node:fs';

const PINNED = /^(deck\.gl|@deck\.gl\/.+|maplibre-gl)$/;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const problems = [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!PINNED.test(name)) continue;
  if (!/^\d+\.\d+\.\d+$/.test(spec)) problems.push(`${name} is "${spec}"; pin an exact version`);
  const locked = lock.packages?.[`node_modules/${name}`]?.version;
  if (locked !== spec) problems.push(`${name} is ${spec} in package.json but ${locked ?? 'missing'} in package-lock.json`);
}
if (problems.length) {
  console.error(`Map library pins:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Map library versions are pinned and match the lockfile.');
