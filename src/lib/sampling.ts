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
  const take = Math.max(0, Math.min(ids.length, Math.floor(k)));
  if (take >= ids.length) return Int32Array.from(ids).sort();
  return new SeededDraw(ids, seed).take(take).sort();
}

/**
 * The same draw as `randomSample`, handed out a few at a time and in draw
 * order: the first `k` taken are `randomSample(ids, k, seed)`. Lets a caller
 * skip ids that turn out to have no data and keep drawing, so "the first n
 * with data" is one fixed set whichever way the data is read.
 */
export class SeededDraw {
  private readonly pool: Int32Array;
  private readonly next: () => number;
  private at = 0;

  constructor(ids: ArrayLike<number>, seed: number) {
    this.pool = Int32Array.from(ids);
    this.next = rng(seed);
  }

  get remaining(): number {
    return this.pool.length - this.at;
  }

  /** The next `k` ids of the draw (fewer when the pool runs out). */
  take(k: number): Int32Array {
    const { pool } = this;
    const n = pool.length;
    const end = Math.min(n, this.at + Math.max(0, Math.floor(k)));
    for (let i = this.at; i < end; i++) {
      const j = i + Math.floor(this.next() * (n - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const out = pool.slice(this.at, end);
    this.at = end;
    return out;
  }
}
