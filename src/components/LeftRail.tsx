/**
 * Sidebar: workspace navigation, the loaded datasets, and utilities. The only
 * place views are switched from with the mouse (the header shows context).
 */
import { useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Waves,
} from 'lucide-react';
import { useAppStore, type SiteState } from '@/store/useAppStore';
import { useImportActions } from './DropTarget';
import { VIEWS } from './TopBar';
import { formatBytes } from '@/lib/format';
import { useDark } from '@/views/shared';

const SEARCH_ABOVE = 5;

export function LeftRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const collapsed = useAppStore((s) => s.railCollapsed);
  const toggle = useAppStore((s) => s.toggleRail);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const siteOrder = useAppStore((s) => s.siteOrder);
  const sites = useAppStore((s) => s.sites);
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const selectSite = useAppStore((s) => s.selectSite);
  const setTheme = useAppStore((s) => s.setTheme);
  const dark = useDark();
  const { openFolder } = useImportActions();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const shown = q ? siteOrder.filter((id) => id.toLowerCase().includes(q)) : siteOrder;

  return (
    <aside
      aria-label="Sidebar"
      className={clsx(
        'relative flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)]',
        'transition-[width] duration-150 ease-[var(--ease-calm)]',
        collapsed ? 'w-[56px]' : 'w-[228px]',
      )}
    >
      {/* Identity + collapse */}
      <div className={clsx('flex h-12 shrink-0 items-center gap-2', collapsed ? 'justify-center px-2' : 'px-3')}>
        {!collapsed && (
          <>
            <div className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-[var(--accent)] text-[var(--accent-contrast)]">
              <Waves size={14} strokeWidth={1.8} />
            </div>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]">WetLSP Explorer</span>
          </>
        )}
        <button
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
        {/* Workspace */}
        <nav aria-label="Views" className="space-y-px pt-1">
          {VIEWS.map((v, i) => (
            <NavItem
              key={v.id}
              collapsed={collapsed}
              active={view === v.id}
              icon={<v.icon size={15} strokeWidth={1.8} />}
              label={v.label}
              hint={`⌘${i + 1}`}
              onClick={() => setView(v.id)}
            />
          ))}
        </nav>

        {/* Datasets */}
        <SectionLabel collapsed={collapsed} action={
          <button
            onClick={openFolder}
            aria-label="Import a dataset folder"
            title="Import a dataset folder"
            className="grid h-5 w-5 place-items-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <Plus size={13} />
          </button>
        }>
          Datasets
        </SectionLabel>

        {collapsed ? (
          <button
            onClick={openFolder}
            aria-label="Import a dataset folder"
            title="Import a dataset folder"
            className="mb-1 grid h-8 w-full place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <Plus size={15} />
          </button>
        ) : (
          siteOrder.length > SEARCH_ABOVE && (
            <label className="mb-1 flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px] text-[var(--text-muted)] focus-within:border-[var(--border-strong)]">
              <Search size={12} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter sites"
                aria-label="Filter loaded sites"
                className="min-w-0 flex-1 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
              />
            </label>
          )
        )}

        {siteOrder.length === 0 && !collapsed && (
          <button
            onClick={openFolder}
            className="w-full rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            No datasets loaded. <span className="text-[var(--accent)]">Import…</span>
          </button>
        )}
        {q && shown.length === 0 && (
          <p className="px-2 py-1.5 text-[12px] text-[var(--text-faint)]">No match.</p>
        )}
        <ul className="space-y-px">
          {shown.map((id) => (
            <SiteRow
              key={id}
              state={sites[id]}
              active={id === activeSiteId}
              collapsed={collapsed}
              onSelect={() => void selectSite(id)}
            />
          ))}
        </ul>
      </div>

      {/* Utilities */}
      <div className="shrink-0 space-y-px border-t border-[var(--border)] p-2">
        <NavItem
          collapsed={collapsed}
          icon={dark ? <Sun size={15} strokeWidth={1.8} /> : <Moon size={15} strokeWidth={1.8} />}
          label={dark ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(dark ? 'light' : 'dark')}
        />
        <NavItem
          collapsed={collapsed}
          icon={<SettingsIcon size={15} strokeWidth={1.8} />}
          label="Settings"
          onClick={onOpenSettings}
        />
      </div>
    </aside>
  );
}

function SectionLabel({ collapsed, children, action }: { collapsed: boolean; children: string; action?: React.ReactNode }) {
  if (collapsed) return <div className="mx-2 my-3 border-t border-[var(--border)]" />;
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-5 text-[11px] font-medium text-[var(--text-faint)]">
      <span>{children}</span>
      {action}
    </div>
  );
}

function NavItem({
  collapsed,
  active,
  icon,
  label,
  hint,
  onClick,
}: {
  collapsed: boolean;
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? `${label}${hint ? `  ${hint}` : ''}` : undefined}
      className={clsx(
        'group flex h-8 w-full items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150',
        collapsed ? 'justify-center' : 'px-2',
        active
          ? 'bg-[var(--bg-active)] font-medium text-[var(--text)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
      )}
    >
      <span className={clsx('shrink-0', active && 'text-[var(--accent)]')}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && hint && (
        <span className="text-[10.5px] tabular-nums text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100">
          {hint}
        </span>
      )}
    </button>
  );
}

/** One line of file status: the site is usable only as far as its files allow. */
function fileStatus(state: SiteState): { ok: boolean; text: string; detail: string } {
  const m = state.manifest;
  const missing = [
    !m.geom && 'geometry',
    !m.meta && 'metadata',
    !m.timeseries && 'time series',
    m.netcdf.length === 0 && 'NetCDF',
  ].filter(Boolean) as string[];
  const years = m.netcdf.map((n) => n.year).sort((a, b) => a - b);
  const span = years.length ? (years.length === 1 ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`) : '';
  const detail = [
    `geometry ${m.geom ? '✓' : 'missing'}`,
    `metadata ${m.meta ? '✓' : 'missing'}`,
    `time series ${m.timeseries ? `✓ ${formatBytes(m.timeseries.totalBytes)}` : 'missing'}`,
    `NetCDF ${m.netcdf.length ? years.join(', ') : 'none'}`,
  ].join('\n');
  if (state.status === 'error') return { ok: false, text: 'Failed to open', detail: state.error ?? detail };
  if (missing.length) return { ok: false, text: `No ${missing.join(', ')}`, detail };
  return { ok: true, text: [span, formatBytes(state.bytesOnDisk)].filter(Boolean).join(' · '), detail };
}

function SiteRow({
  state,
  active,
  collapsed,
  onSelect,
}: {
  state: SiteState;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const removeSite = useAppStore((s) => s.removeSite);
  const [confirming, setConfirming] = useState(false);
  const { manifest } = state;
  const status = fileStatus(state);
  const dot = clsx(
    'h-1.5 w-1.5 shrink-0 rounded-full',
    state.status === 'error'
      ? 'bg-red-500'
      : state.status === 'loading'
        ? 'animate-pulse bg-amber-400'
        : !status.ok
          ? 'bg-amber-500'
          : state.status === 'ready'
            ? 'bg-[var(--accent)]'
            : 'bg-[var(--border-strong)]',
  );

  if (collapsed) {
    return (
      <li>
        <button
          onClick={onSelect}
          title={`${manifest.siteId}\n${status.detail}`}
          aria-label={manifest.siteId}
          aria-current={active ? 'true' : undefined}
          className={clsx(
            'relative grid h-8 w-full place-items-center rounded-md text-[10.5px] font-semibold transition-colors',
            active ? 'bg-[var(--bg-active)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {manifest.siteId.slice(0, 2).toUpperCase()}
          <span className={clsx(dot, 'absolute right-1.5 top-1.5')} />
        </button>
      </li>
    );
  }

  return (
    <li>
      <div
        className={clsx(
          'group flex items-center gap-1 rounded-md pr-1 transition-colors',
          active ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]',
        )}
      >
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left"
          aria-current={active ? 'true' : undefined}
          title={status.detail}
        >
          <span className={dot} />
          <span className="min-w-0 flex-1">
            <span className={clsx('block truncate text-[13px]', active ? 'font-medium' : 'text-[var(--text-muted)]')}>
              {manifest.siteId}
            </span>
            <span className={clsx('flex items-center gap-1 truncate text-[11px] tabular-nums', status.ok ? 'text-[var(--text-faint)]' : 'text-amber-600 dark:text-amber-400')}>
              {!status.ok && <AlertTriangle size={10} />}
              {status.text}
            </span>
          </span>
        </button>

        {confirming ? (
          <div className="flex shrink-0 items-center">
            <button
              onClick={() => {
                setConfirming(false);
                void removeSite(manifest.siteId);
              }}
              className="rounded p-1 text-red-500 hover:bg-red-500/10"
              title="Delete permanently"
              aria-label={`Delete ${manifest.siteId} permanently`}
            >
              <Check size={13} />
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)]"
              title="Keep"
              aria-label="Keep"
            >
              <ChevronLeft size={13} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded p-1 text-[var(--text-faint)] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 focus-visible:opacity-100"
            title={`Remove ${manifest.siteId} from offline storage`}
            aria-label={`Remove ${manifest.siteId}`}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </li>
  );
}
