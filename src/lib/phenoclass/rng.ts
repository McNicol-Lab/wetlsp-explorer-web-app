/**
 * Seeded random numbers: xoshiro128** seeded through splitmix32.
 *
 * Deterministic for a given seed across browsers and Node. It is not NumPy's
 * Mersenne Twister, so a fit with seed 42 here does not draw the same initial
 * centres as scikit-learn with random_state=42; compare fits after matching
 * labels, never by raw class number.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0;
    this.s1 >>>= 0;
    this.s2 >>>= 0;
    this.s3 >>>= 0;
    return result;
  }

  /** Uniform double in [0, 1) with 53 random bits. */
  next(): number {
    const hi = this.nextU32() >>> 5; // 27 bits
    const lo = this.nextU32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Uniform sample of `m` items from a stream of unknown length (Algorithm R).
 * Feed items in a fixed order and the sample is reproducible for the seed.
 */
export class Reservoir {
  readonly picked: Float64Array;
  /** Which stream position each reservoir slot holds, to keep sampled rows traceable. */
  readonly source: Float64Array;
  private seen = 0;
  private filled = 0;
  private readonly rng: Rng;

  constructor(
    readonly capacity: number,
    readonly width: number,
    seed: number,
  ) {
    this.picked = new Float64Array(capacity * width);
    this.source = new Float64Array(capacity);
    this.rng = new Rng(seed);
  }

  /** Offer one row; `row` is read immediately and may be reused by the caller. */
  offer(row: ArrayLike<number>, offset: number): void {
    const pos = this.seen++;
    let slot: number;
    if (this.filled < this.capacity) slot = this.filled++;
    else {
      const j = Math.floor(this.rng.next() * (pos + 1));
      if (j >= this.capacity) return;
      slot = j;
    }
    const o = slot * this.width;
    for (let c = 0; c < this.width; c++) this.picked[o + c] = row[offset + c];
    this.source[slot] = pos;
  }

  get size(): number {
    return this.filled;
  }

  get offered(): number {
    return this.seen;
  }

  /** The sampled rows in stream order, so results do not depend on slot shuffling. */
  rows(): Float64Array {
    const order = Array.from({ length: this.filled }, (_, i) => i).sort((a, b) => this.source[a] - this.source[b]);
    const out = new Float64Array(this.filled * this.width);
    order.forEach((slot, i) => out.set(this.picked.subarray(slot * this.width, (slot + 1) * this.width), i * this.width));
    return out;
  }
}
