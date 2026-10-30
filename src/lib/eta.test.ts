import { describe, expect, it } from 'vitest';
import { formatRemaining, RemainingTime } from './eta';

describe('time left', () => {
  it('waits a few seconds, then follows a steady rate', () => {
    const r = new RemainingTime();
    expect(r.update('split', 0, 0)).toBeNull();
    expect(r.update('split', 0.01, 1000)).toBeNull();
    // 1% a second: 90 s left at 10%.
    expect(r.update('split', 0.1, 10_000)).toBeCloseTo(90, 5);
    expect(r.update('split', 0.2, 20_000)).toBeCloseTo(87, 0);
    expect(r.update('split', 0.5, 50_000)!).toBeGreaterThan(50);
    expect(r.update('split', 0.5, 50_000)!).toBeLessThan(90);
  });

  it('starts over for a new phase, and knows nothing without a fraction', () => {
    const r = new RemainingTime();
    r.update('copy', 0, 0);
    expect(r.update('copy', 0.5, 10_000)).toBeCloseTo(10, 5);
    expect(r.update('split', 0.5, 11_000)).toBeNull();
    expect(r.update('split', null, 20_000)).toBeNull();
  });

  it('takes the rate from the last half minute', () => {
    const r = new RemainingTime();
    // Slow for a minute (0.1% a second), then fast (2% a second).
    for (let t = 0; t <= 60; t += 1) r.update('split', t * 0.001, t * 1000);
    let left = 0;
    for (let t = 1; t <= 40; t += 1) left = r.update('split', 0.06 + t * 0.02, (60 + t) * 1000)!;
    // 14% left at 2% a second: 7 s; the old rate would say minutes.
    expect(left).toBeLessThan(10);
  });

  it('says it the way a person would', () => {
    expect(formatRemaining(4)).toBe('a few seconds left');
    expect(formatRemaining(30)).toBe('less than a minute left');
    expect(formatRemaining(70)).toBe('about a minute left');
    expect(formatRemaining(150)).toBe('about 3 min left');
    expect(formatRemaining(59 * 60)).toBe('about 59 min left');
    expect(formatRemaining(95 * 60)).toBe('about 1 h 35 min left');
    expect(formatRemaining(120 * 60)).toBe('about 2 h left');
    expect(formatRemaining(119 * 60)).toBe('about 2 h left');
  });
});
