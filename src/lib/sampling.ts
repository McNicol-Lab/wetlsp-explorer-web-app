/**
 * Uniform random pixel samples. One sampler serves the Pixel Map's shape
 * selections and the Time Series' random sample, so both can be redrawn and a
 * given seed always reproduces the same pixels.
 */

/** A fresh 32-bit seed. */
export function newSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}

/** mulberry32: small, fast, and good enough for picking pixels. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * `k` ids drawn uniformly without replacement, sorted ascending. A partial
 * Fisher–Yates shuffle costs O(k) swaps after one copy, so drawing 500 from a
 * 1.3-million-pixel site is instant. Every pixel is equally likely to be
 * drawn, wherever it sits in file order.
 */
export function randomSample(ids: ArrayLike<number>, k: number, seed: number): Int32Array {
  const n = ids.length;
  const take = Math.max(0, Math.min(n, Math.floor(k)));
  const pool = Int32Array.from(ids);
  if (take >= n) return pool.sort();
  const next = rng(seed);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(next() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, take).sort();
}
