import { describe, expect, it } from 'vitest';
import { flipRowsInPlace, rowsStoredSouthUp } from './orientation';

describe('rowsStoredSouthUp', () => {
  const wetlsp = {
    software_repository: 'https://github.com/McNicol-Lab/WetLSP',
    title: 'WetLSP phenometrics for site BR-SM1 (2021)',
    product_version: 'v001',
  };

  it('flags the v001 WetLSP exports', () => {
    expect(rowsStoredSouthUp(wetlsp)).toBe(true);
  });

  it('trusts a newer product version', () => {
    expect(rowsStoredSouthUp({ ...wetlsp, product_version: 'v002' })).toBe(false);
  });

  it('trusts files from anywhere else', () => {
    expect(rowsStoredSouthUp({ product_version: 'v001' })).toBe(false);
    expect(rowsStoredSouthUp({})).toBe(false);
  });
});

describe('flipRowsInPlace', () => {
  it('reverses rows and keeps columns', () => {
    const v = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    flipRowsInPlace(v, 3, 3);
    expect([...v]).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3]);
  });

  it('handles an even row count and a single row', () => {
    const even = Float32Array.from([1, 2, 3, 4]);
    flipRowsInPlace(even, 2, 2);
    expect([...even]).toEqual([3, 4, 1, 2]);
    const one = Float32Array.from([1, 2, 3]);
    flipRowsInPlace(one, 3, 1);
    expect([...one]).toEqual([1, 2, 3]);
  });
});
