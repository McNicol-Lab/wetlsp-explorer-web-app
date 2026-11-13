import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteManifest } from '@/lib/types';

const { save, remove } = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/idb', () => ({ saveManifest: save }));
vi.mock('@/lib/opfs', () => ({ deleteSiteFile: remove, storedPath: (p: string) => p }));
import { commitTimeseriesSplit } from './commitTimeseriesSplit';

const manifest = (paths: string[]) => ({
  siteId: 'AU-Arc',
  timeseries: { parts: paths.map((path) => ({ path, size: 100 })) },
}) as SiteManifest;

describe('publish a split without losing its original', () => {
  beforeEach(() => { vi.resetAllMocks(); remove.mockResolvedValue(undefined); });

  it('keeps the original while the manifest save is pending', async () => {
    let finish!: () => void;
    save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const operation = commitTimeseriesSplit(manifest(['large.parquet', 'small.parquet']), manifest(['part-1.parquet', 'part-2.parquet', 'small.parquet']));
    expect(remove).not.toHaveBeenCalled();
    finish();
    await operation;
    expect(remove.mock.calls).toEqual([['AU-Arc', 'large.parquet']]);
  });

  it('retains every original when the replacement manifest cannot be saved', async () => {
    save.mockRejectedValue(new Error('storage full'));
    await expect(commitTimeseriesSplit(manifest(['large.parquet']), manifest(['part-1.parquet']))).rejects.toThrow('storage full');
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the saved replacement usable even when deleting an old file fails', async () => {
    save.mockResolvedValue(undefined);
    remove.mockRejectedValue(new Error('file still locked'));
    await expect(commitTimeseriesSplit(manifest(['large.parquet']), manifest(['part-1.parquet']))).resolves.toBeUndefined();
  });
});
