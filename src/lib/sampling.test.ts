import { describe, expect, it } from 'vitest';
import { randomSample } from './sampling';

const range = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

describe('randomSample', () => {
  it('returns k distinct ids from the pool, sorted', () => {
    const s = randomSample(range(10_000), 500, 7);
    expect(s.length).toBe(500);
    expect(new Set(s).size).toBe(500);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
    for (const id of s) expect(id).toBeGreaterThanOrEqual(0);
  });

  it('is reproducible for a seed and changes with the seed', () => {
    const pool = range(5_000);
    expect(Array.from(randomSample(pool, 250, 42))).toEqual(Array.from(randomSample(pool, 250, 42)));
    expect(Array.from(randomSample(pool, 250, 42))).not.toEqual(Array.from(randomSample(pool, 250, 43)));
  });

  it('spreads across the whole pool instead of keeping the first k in file order', () => {
    // The old behaviour kept ids 0..499: a stripe along the top of the shape.
    const s = randomSample(range(100_000), 500, 1);
    const quarters = [0, 0, 0, 0];
    for (const id of s) quarters[Math.floor(id / 25_000)]++;
    for (const q of quarters) expect(q).toBeGreaterThan(80);
    expect(s[s.length - 1]).toBeGreaterThan(90_000);
  });

  it('returns everything when the pool is no larger than k', () => {
    expect(Array.from(randomSample(Int32Array.of(9, 3, 5), 10, 1))).toEqual([3, 5, 9]);
    expect(randomSample(Int32Array.of(), 10, 1).length).toBe(0);
  });

  it('does not modify the input', () => {
    const pool = range(100);
    randomSample(pool, 10, 3);
    expect(Array.from(pool)).toEqual(Array.from(range(100)));
  });
});
