import { describe, expect, it } from 'vitest';
import { pixelIndex } from './pixelIndex';

describe('pixelIndex', () => {
  it('finds every id of a sorted array and misses absent ones', () => {
    const ids = Int32Array.from({ length: 1000 }, (_, i) => i * 3 + 7);
    for (let i = 0; i < ids.length; i++) expect(pixelIndex(ids, ids[i])).toBe(i);
    expect(pixelIndex(ids, 8)).toBe(-1);
    expect(pixelIndex(ids, -1)).toBe(-1);
    expect(pixelIndex(ids, 1_000_000)).toBe(-1);
  });

  it('still answers for an unsorted array', () => {
    const ids = Int32Array.of(50, 10, 40, 20);
    expect(pixelIndex(ids, 40)).toBe(2);
    expect(pixelIndex(ids, 10)).toBe(1);
    expect(pixelIndex(ids, 30)).toBe(-1);
  });

  it('handles empty input', () => {
    expect(pixelIndex(new Int32Array(0), 1)).toBe(-1);
  });
});
