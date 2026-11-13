import { useEffect } from 'react';
import clsx from 'clsx';
import { useAppStore, watchOnline, watchSystemTheme } from '@/store/useAppStore';
import { LeftRail } from '@/components/LeftRail';
import { TopBar, VIEWS } from '@/components/TopBar';
import { Hero } from '@/components/Hero';
import { Toasts } from '@/components/Toasts';
import { Onboarding } from '@/components/Onboarding';
import { CommandPalette } from '@/components/CommandPalette';
import { SettingsPanel } from '@/components/SettingsPanel';
import { DropOverlay, useGlobalDrop } from '@/components/DropTarget';
import { ProgressBar } from '@/components/ui';
import { SpaceDialog } from '@/components/StoragePanel';
import { runFigureAction } from '@/lib/figure';
import { ImportProgress } from '@/components/ImportProgress';
import { OverviewInspector, OverviewView } from '@/views/OverviewView';
import { TimeSeriesInspector, TimeSeriesView } from '@/views/TimeSeriesView';
import { PixelMapInspector, PixelMapView } from '@/views/PixelMapView';
import { PhenometricsInspector, PhenometricsView } from '@/views/PhenometricsView';
import { CatalogInspector, CatalogView } from '@/views/CatalogView';
import { PhenologyClassesInspector, PhenologyClassesView } from '@/views/phenoclass/PhenologyClassesView';

const CANVASES = {
  overview: OverviewView,
  timeseries: TimeSeriesView,
  pixelmap: PixelMapView,
  phenometrics: PhenometricsView,
  catalog: CatalogView,
  phenoclasses: PhenologyClassesView,
} as const;

const INSPECTORS = {
  overview: OverviewInspector,
  timeseries: TimeSeriesInspector,
  pixelmap: PixelMapInspector,
  phenometrics: PhenometricsInspector,
  catalog: CatalogInspector,
  phenoclasses: PhenologyClassesInspector,
} as const;

export default function App() {
  const boot = useAppStore((s) => s.boot);
  const booted = useAppStore((s) => s.booted);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const siteCount = useAppStore((s) => s.siteOrder.length);
  const heroDismissed = useAppStore((s) => s.heroDismissed);
  const inspectorCollapsed = useAppStore((s) => s.inspectorCollapsed);
  const ingest = useAppStore((s) => s.ingest);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const { dragging } = useGlobalDrop();

  useEffect(() => {
    void boot();
    const stopTheme = watchSystemTheme();
    const stopOnline = watchOnline();
    return () => {
      stopTheme();
      stopOnline();
    };
  }, [boot]);

  // Keyboard: ⌘K for the palette, ⌘1–6 for views, Esc closes overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!useAppStore.getState().paletteOpen);
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void runFigureAction('save');
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void runFigureAction('copy');
        return;
      }
      if (meta && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setView(VIEWS[Number(e.key) - 1].id);
        return;
      }
      if (e.key === 'Escape') {
        setSettingsOpen(false);
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen, setView, setSettingsOpen]);

  const showHero = booted && siteCount === 0 && !heroDismissed;
  const Canvas = CANVASES[view];
  const Inspector = INSPECTORS[view];

  return (
    <div className="flex h-full w-full overflow-hidden">
      {showHero ? (
        <Hero />
      ) : (
        <>
          <LeftRail onOpenSettings={() => setSettingsOpen(true)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            {ingest.active && (
              <div className="border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2">
                <ImportProgress inline />
              </div>
            )}
            <Onboarding />
            <main className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 p-4 panel-transition">
                <Canvas />
              </div>
              <aside
                className={clsx(
                  'workspace-inspector shrink-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-elevated)] transition-[width,opacity] duration-200 ease-[var(--ease-calm)]',
                  inspectorCollapsed ? 'w-0 opacity-0' : view === 'overview' ? 'w-[360px] opacity-100' : 'w-[300px] opacity-100',
                )}
                aria-hidden={inspectorCollapsed}
              >
                <div className={clsx(view === 'overview' ? 'w-[359px]' : 'w-[299px]', 'px-1 pb-4')}>
                  <Inspector />
                </div>
              </aside>
            </main>
          </div>
        </>
      )}

      {!booted && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[var(--bg)]">
          <div className="w-[220px]">
            <ProgressBar fraction={null} label="Starting WetLSP Explorer" />
          </div>
        </div>
      )}

      <DropOverlay visible={dragging} />
      <CommandPalette />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <SpaceDialog />
      <Toasts />
    </div>
  );
}
