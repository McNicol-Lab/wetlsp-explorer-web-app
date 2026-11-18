/** Header: where you are (site / view), live status, search, and the details toggle. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  ChevronRight,
  Globe2,
  LineChart,
  Map as MapIcon,
  PanelRightClose,
  PanelRightOpen,
  Layers,
  Search,
  Shapes,
  Table2,
  WifiOff,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Chip, Kbd } from './ui';
import { onEngineStatus, type EngineStatus } from '@/engine/duckdb';
import { formatBytes, formatCount } from '@/lib/format';
import type { ViewId } from '@/lib/types';

export const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Globe2 }> = [
  { id: 'overview', label: 'Overview', icon: Globe2 },
  { id: 'timeseries', label: 'Time Series', icon: LineChart },
  { id: 'pixelmap', label: 'Pixel Map', icon: MapIcon },
  { id: 'phenometrics', label: 'Phenometrics', icon: Layers },
  { id: 'catalog', label: 'Catalog', icon: Table2 },
  { id: 'phenoclasses', label: 'Phenology Classes', icon: Shapes },
];

export function TopBar() {
  const view = useAppStore((s) => s.view);
  const online = useAppStore((s) => s.online);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const inspectorCollapsed = useAppStore((s) => s.inspectorCollapsed);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const selection = useAppStore((s) => s.selection.length);
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const siteName = useAppStore((s) => (s.activeSiteId ? s.catalogIndex.get(s.activeSiteId)?.site_name : undefined));
  const current = VIEWS.find((v) => v.id === view)!;

  const [engine, setEngine] = useState<EngineStatus>({
    state: 'idle',
    bytesLoaded: 0,
    bytesTotal: 0,
  });
  useEffect(() => onEngineStatus(setEngine), []);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]" aria-label="Location">
        {activeSiteId && (
          <>
            <span className="shrink-0 font-medium" title={siteName}>{activeSiteId}</span>
            {siteName && <span className="hidden truncate text-[var(--text-faint)] min-[1200px]:inline">{siteName}</span>}
            <ChevronRight size={13} className="shrink-0 text-[var(--text-faint)]" />
          </>
        )}
        <h1 className="truncate text-[13px] font-medium text-[var(--text-muted)]">{current.label}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {selection > 0 && (
          <Chip tone="accent" title="Pixels currently selected on the Pixel Map">
            {formatCount(selection)} selected
          </Chip>
        )}
        {!online && (
          <Chip tone="warning" title="You're offline. Imported sites still work.">
            <WifiOff size={11} /> Offline
          </Chip>
        )}
        {engine.state === 'loading' && (
          <Chip title="DuckDB-WASM is loading">
            Engine {engine.bytesTotal ? formatBytes(engine.bytesLoaded) : ''}…
          </Chip>
        )}
        {engine.state === 'error' && (
          <Chip tone="danger" title={engine.error}>
            Engine failed
          </Chip>
        )}

        <button
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 items-center gap-2 rounded-md border border-[var(--border)] pl-2 pr-1 text-[12px] text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          title="Search sites, views and actions"
          aria-label="Search and commands"
        >
          <Search size={13} />
          <span className="hidden min-[1100px]:inline">Search</span>
          <Kbd>⌘K</Kbd>
        </button>

        <button
          onClick={toggleInspector}
          className={clsx(
            'grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
            inspectorCollapsed ? 'text-[var(--text-faint)]' : 'text-[var(--text)]',
          )}
          title={inspectorCollapsed ? 'Show details' : 'Hide details'}
          aria-label={inspectorCollapsed ? 'Show details panel' : 'Hide details panel'}
          aria-pressed={!inspectorCollapsed}
        >
          {inspectorCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
        </button>
      </div>
    </header>
  );
}
