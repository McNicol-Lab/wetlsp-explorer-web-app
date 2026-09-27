/** View switcher plus the always-visible status: engine, offline, selection. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Globe2,
  LineChart,
  Map as MapIcon,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Layers,
  Search,
  Sun,
  Table2,
  WifiOff,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Chip, Kbd } from './ui';
import { onEngineStatus, type EngineStatus } from '@/engine/duckdb';
import { formatBytes, formatCount } from '@/lib/format';
import type { ViewId } from '@/lib/types';
import { useDark } from '@/views/shared';

export const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Globe2 }> = [
  { id: 'overview', label: 'Overview', icon: Globe2 },
  { id: 'timeseries', label: 'Time Series', icon: LineChart },
  { id: 'pixelmap', label: 'Pixel Map', icon: MapIcon },
  { id: 'phenometrics', label: 'Phenometrics', icon: Layers },
  { id: 'catalog', label: 'Catalog', icon: Table2 },
];

export function TopBar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const theme = useAppStore((s) => s.theme);
  const dark = useDark();
  const setTheme = useAppStore((s) => s.setTheme);
  const online = useAppStore((s) => s.online);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const inspectorCollapsed = useAppStore((s) => s.inspectorCollapsed);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const selection = useAppStore((s) => s.selection.length);
  const activeSiteId = useAppStore((s) => s.activeSiteId);

  const [engine, setEngine] = useState<EngineStatus>({
    state: 'idle',
    bytesLoaded: 0,
    bytesTotal: 0,
  });
  useEffect(() => onEngineStatus(setEngine), []);

  return (
    <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-5">
      <nav aria-label="Views" className="flex h-full min-w-0 items-stretch gap-1">
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            title={`${v.label}  ⌘${i + 1}`}
            aria-label={v.label}
            aria-current={view === v.id ? 'page' : undefined}
            className={clsx(
              'relative flex items-center gap-2 border-b-2 px-2.5 text-[13px] font-medium',
              'transition-colors duration-150 ease-[var(--ease-calm)]',
              view === v.id
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            <v.icon size={14} />
            <span className="hidden min-[1180px]:inline">{v.label}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 truncate pl-2 text-[12px] font-medium text-[var(--text-muted)]">
        {activeSiteId && <span className="hidden min-[1320px]:inline">{activeSiteId}</span>}
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
          className="flex h-8 items-center gap-2 rounded-md border border-[var(--border)] px-2.5 text-[12.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          title="Command palette"
          aria-label="Command palette"
        >
          <Search size={13} />
          <Kbd>⌘K</Kbd>
        </button>

        <button
          onClick={() => setTheme(dark ? 'light' : 'dark')}
          className="rounded-md p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          title={`Theme: ${theme}`}
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <button
          onClick={toggleInspector}
          className="rounded-md p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          title={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
          aria-label="Toggle inspector"
        >
          {inspectorCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
        </button>
      </div>
    </header>
  );
}
