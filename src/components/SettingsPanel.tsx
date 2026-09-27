/** Settings drawer: theme, basemap, offline readiness, storage, catalog. */
import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { Button, Card, Chip, Divider, Field, Segmented, Toggle } from './ui';
import { useAppStore, type ThemeMode } from '@/store/useAppStore';
import { BASEMAP_OPTIONS } from '@/lib/basemaps';
import { clearCache, requestPersistence } from '@/lib/opfs';
import { warmEngine } from '@/engine/duckdb';
import { pluralise } from '@/lib/format';
import { SampleSitesCard, SiteStorageList, StorageMeter } from './StoragePanel';
import { clearCatalogOverride, loadCatalog, setCatalogOverride } from '@/lib/catalog';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const storage = useAppStore((s) => s.storage);
  const refreshStorage = useAppStore((s) => s.refreshStorage);
  const catalogSource = useAppStore((s) => s.catalogSource);
  const catalogCount = useAppStore((s) => s.catalog.length);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const toast = useAppStore((s) => s.toast);
  const online = useAppStore((s) => s.online);

  const [warming, setWarming] = useState(false);
  const [engineReady, setEngineReady] = useState(false);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const prepareOffline = async () => {
    setWarming(true);
    try {
      const persisted = await requestPersistence();
      await warmEngine();
      setEngineReady(true);
      toast({
        kind: 'success',
        title: 'Ready to work offline',
        detail: persisted
          ? 'The app and query engine are cached. Browser storage is persistent.'
          : 'The app and query engine are cached. Browser storage is best effort.',
      });
      void refreshStorage();
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Could not prepare for offline use',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWarming(false);
    }
  };

  const loadCatalogFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const sites = await setCatalogOverride(file.name, await file.text());
        setCatalog(sites, 'user');
        toast({ kind: 'success', title: 'Catalog loaded', detail: `${sites.length} sites.` });
      } catch (err) {
        toast({
          kind: 'error',
          title: 'Catalog could not be read',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };
    input.click();
  };

  const resetCatalog = async () => {
    await clearCatalogOverride();
    const loaded = await loadCatalog();
    setCatalog(loaded.sites, loaded.source);
    toast({ kind: 'info', title: 'Back to the bundled catalog' });
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex justify-end bg-black/25 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-full w-[380px] max-w-[92vw] flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-[14px] font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <Card title="Appearance">
            <div className="space-y-3">
              <Field label="Theme">
                <Segmented<ThemeMode>
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </Field>
              <Field label="Basemap" hint={online ? undefined : 'unavailable while offline'}>
                <Segmented
                  size="sm"
                  value={basemap}
                  onChange={setBasemap}
                  options={[
                    { value: 'auto' as const, label: 'Auto' },
                    ...BASEMAP_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
                  ]}
                />
              </Field>
            </div>
          </Card>

          <Card
            title="Offline"
            subtitle="The app shell already works offline; the query engine caches on first use."
          >
            <div className="space-y-2.5">
              <Button
                className="w-full"
                variant="primary"
                icon={warming ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                onClick={prepareOffline}
                disabled={warming}
              >
                {warming ? 'Preparing…' : 'Prepare for offline use'}
              </Button>
              <div className="flex flex-wrap gap-1.5">
                <Chip tone={storage.persisted ? 'accent' : 'neutral'}>
                  {storage.persisted ? 'Storage is persistent' : 'Storage is best effort'}
                </Chip>
                {engineReady && <Chip tone="accent">Engine cached</Chip>}
              </div>
              <p className="text-[11.5px] leading-snug text-[var(--text-muted)]">
                Basemap tiles are cached as you browse. With no network the maps fall back to a
                plain background, and pixel positions stay correct.
              </p>
            </div>
          </Card>

          <Card
            title="Storage"
            subtitle="Up to 50 GB of site data. When it is full, imports ask you to delete a site first."
            actions={<HardDrive size={14} className="text-[var(--text-faint)]" />}
          >
            <div className="space-y-3">
              <StorageMeter />
              <SiteStorageList />
              <Divider />
              <button
                onClick={async () => {
                  await clearCache();
                  toast({
                    kind: 'info',
                    title: 'Derived cache cleared',
                    detail: 'Reprojected geometry will be recomputed on next open.',
                  });
                  void refreshStorage();
                }}
                className="text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
              >
                Clear the derived cache (keeps your data)
              </button>
            </div>
          </Card>

          <SampleSitesCard />

          <Card
            title="Site catalog"
            subtitle={
              catalogSource === 'user'
                ? `${pluralise(catalogCount, 'site')} from your file`
                : catalogSource === 'bundled'
                  ? `${pluralise(catalogCount, 'site')} bundled with the app`
                  : 'No catalog loaded'
            }
          >
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Upload size={13} />} onClick={loadCatalogFile}>
                Load catalog file
              </Button>
              {catalogSource === 'user' && (
                <Button size="sm" variant="ghost" onClick={() => void resetCatalog()}>
                  Reset to bundled
                </Button>
              )}
            </div>
          </Card>

          <Card title="Privacy">
            <Toggle
              checked
              onChange={() => undefined}
              disabled
              label="Everything stays on this machine"
              hint="Nothing is sent to a server, and there is no telemetry. Files are read on this computer and kept in the app's private storage."
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
