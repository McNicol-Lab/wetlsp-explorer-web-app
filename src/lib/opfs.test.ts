import { describe, expect, it } from 'vitest';
import { APP_STORAGE_BUDGET, siteFileOpfsPath, storageBudget } from './opfs';

const GB = 1024 ** 3;

describe('storageBudget', () => {
  it('caps site data at 50 GB when the disk has plenty of room', () => {
    const b = storageBudget(10 * GB, { usage: 11 * GB, quota: 500 * GB, persisted: true });
    expect(APP_STORAGE_BUDGET).toBe(50 * GB);
    expect(b.limit).toBe(50 * GB);
    expect(b.diskBound).toBe(false);
  });

  it('uses free browser quota when that is the smaller ceiling', () => {
    const b = storageBudget(10 * GB, { usage: 12 * GB, quota: 20 * GB, persisted: false });
    expect(b.limit).toBe(18 * GB);
    expect(b.diskBound).toBe(true);
  });

  it('falls back to the app budget when the browser reports no quota', () => {
    const b = storageBudget(1 * GB, { usage: 0, quota: 0, persisted: false });
    expect(b.limit).toBe(50 * GB);
  });
});

describe('siteFileOpfsPath', () => {
  it('names the file writeSiteFile would write, so DuckDB and the app agree', () => {
    expect(siteFileOpfsPath('AU-Arc', 'AU_Arc_pixels_timeseries.part-1-of-4.parquet')).toBe(
      'opfs://sites/AU-Arc/AU_Arc_pixels_timeseries.part-1-of-4.parquet',
    );
    // Every segment is made safe the same way: separators and leading dots.
    expect(siteFileOpfsPath('X:Y', 'pixels_timeseries_ds/.p:1.parquet')).toBe(
      'opfs://sites/X_Y/pixels_timeseries_ds/_p_1.parquet',
    );
  });
});
