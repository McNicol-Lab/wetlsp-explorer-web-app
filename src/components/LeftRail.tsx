/**
 * Left rail: identity, the import action, the loaded-site list, the active
 * site's parsed files, and Settings — in that order, top to bottom.
 */
import { useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  FileBox,
  Grid2x2,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  Waves,
} from 'lucide-react';
import { useAppStore, type SiteState } from '@/store/useAppStore';
import { useImportActions } from './DropTarget';
import { Button, Chip, Divider } from './ui';
import { formatBytes, relativeTime } from '@/lib/format';

export function LeftRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const collapsed = useAppStore((s) => s.railCollapsed);
  const toggle = useAppStore((s) => s.toggleRail);
  const siteOrder = useAppStore((s) => s.siteOrder);
  const sites = useAppStore((s) => s.sites);
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const selectSite = useAppStore((s) => s.selectSite);
  const { openFolder } = useImportActions();

  const active = activeSiteId ? sites[activeSiteId] : null;

  return (
    <aside
      className={clsx(
        'relative flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)]',
        'transition-[width] duration-200 ease-[var(--ease-calm)]',
        collapsed ? 'w-[56px]' : 'w-[236px]',
      )}
    >
      <div className={clsx('flex items-center gap-2.5', collapsed ? 'flex-col px-2 py-4' : 'h-[88px] px-4')}>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--accent)] text-[var(--accent-contrast)]">
          <Waves size={19} strokeWidth={1.6} />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-semibold leading-tight tracking-[-0.035em]">WetLSP</div>
            <div className="mt-0.5 truncate text-[11px] tracking-[0.06em] text-[var(--text-muted)]">
              EXPLORER
            </div>
          </div>
        )}
        <button
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx('shrink-0 rounded-md p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]', !collapsed && 'ml-auto')}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      <div className={collapsed ? 'px-2 pb-4' : 'px-4 pb-5'}>
        <Button
          variant="secondary"
          size={collapsed ? 'sm' : 'md'}
          className={collapsed ? 'w-full px-0' : 'w-full'}
          icon={<Plus size={15} />}
          onClick={openFolder}
          title="Open a WetLSP site folder"
        >
          {!collapsed && 'Open dataset'}
        </Button>
      </div>

      <Divider />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
        {!collapsed && (
          <h4 className="flex items-center justify-between px-1 pb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
            <span>Loaded sites</span>
            <span className="font-mono text-[10px]">{siteOrder.length.toString().padStart(2, '0')}</span>
          </h4>
        )}
        {siteOrder.length === 0 && !collapsed && (
          <p className="px-1 py-2 text-[12px] leading-snug text-[var(--text-muted)]">
            No datasets yet. Drop a site folder anywhere on the window.
          </p>
        )}
        <ul className="space-y-0.5">
          {siteOrder.map((id) => (
            <SiteRow
              key={id}
              state={sites[id]}
              active={id === activeSiteId}
              collapsed={collapsed}
              onSelect={() => void selectSite(id)}
            />
          ))}
        </ul>

        {!collapsed && active && (
          <>
            <h4 className="mt-6 border-t border-[var(--border)] px-1 pt-5 pb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
              Dataset files
            </h4>
            <FileChips state={active} />
          </>
        )}
      </div>

      <Divider />
      <div className="p-3">
        <Button
          variant="ghost"
          size="sm"
          className={collapsed ? 'w-full px-0' : 'w-full justify-start'}
          icon={<SettingsIcon size={14} />}
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          {!collapsed && 'Settings'}
        </Button>
      </div>
    </aside>
  );
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

  if (collapsed) {
    return (
      <li>
        <button
          onClick={onSelect}
          title={manifest.siteId}
          className={clsx(
            'grid h-9 w-full place-items-center rounded-md text-[11px] font-semibold transition-colors',
            active
              ? 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {manifest.siteId.slice(0, 2).toUpperCase()}
        </button>
      </li>
    );
  }

  return (
    <li>
      <div
        className={clsx(
          'group flex items-center gap-2 rounded-md border px-2.5 py-3 transition-colors',
          active ? 'border-[var(--border)] bg-[var(--bg-elevated)]' : 'border-transparent hover:bg-[var(--bg-hover)]',
        )}
      >
        <button onClick={onSelect} className="min-w-0 flex-1 text-left" aria-current={active ? 'true' : undefined}>
          <div className="flex items-center gap-1.5">
            <span
              className={clsx(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                state.status === 'ready'
                  ? 'bg-[var(--accent)]'
                  : state.status === 'error'
                    ? 'bg-red-500'
                    : state.status === 'loading'
                      ? 'animate-pulse bg-amber-400'
                      : 'bg-[var(--border-strong)]',
              )}
            />
            <span className="truncate text-[13px] font-medium">{manifest.siteId}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
            {formatBytes(state.bytesOnDisk)} · {relativeTime(manifest.importedAt)}
          </div>
        </button>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => {
                setConfirming(false);
                void removeSite(manifest.siteId);
              }}
              className="rounded p-1 text-red-500 hover:bg-red-500/10"
              title="Delete permanently"
            >
              <Check size={13} />
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)]"
              title="Keep"
            >
              <ChevronLeft size={13} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded p-1 text-[var(--text-faint)] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 focus-visible:opacity-100"
            title={`Remove ${manifest.siteId} from offline storage`}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </li>
  );
}

function FileChips({ state }: { state: SiteState }) {
  const { manifest } = state;
  const rows: Array<{ ok: boolean; icon: typeof Database; label: string; title: string }> = [
    {
      ok: Boolean(manifest.geom),
      icon: Grid2x2,
      label: 'geom',
      title: manifest.geom
        ? `${manifest.geom.parts.length} file(s) · ${formatBytes(manifest.geom.totalBytes)}`
        : 'pixels_geom is missing, so pixels cannot be mapped',
    },
    {
      ok: Boolean(manifest.meta),
      icon: FileBox,
      label: 'meta',
      title: manifest.meta
        ? `${manifest.meta.parts.length} file(s) · CRS and site metadata`
        : 'pixels_meta is missing, so there is no CRS',
    },
    {
      ok: Boolean(manifest.timeseries),
      icon: Database,
      label: 'timeseries',
      title: manifest.timeseries
        ? `${manifest.timeseries.parts.length} file(s) · ${formatBytes(manifest.timeseries.totalBytes)}`
        : 'pixels_timeseries is missing, so there is no EVI series',
    },
  ];

  return (
    <div className="space-y-1.5 px-1">
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <Chip key={r.label} tone={r.ok ? 'accent' : 'warning'} title={r.title}>
            {r.ok ? <Check size={11} /> : <AlertTriangle size={11} />}
            {r.label}
          </Chip>
        ))}
        <Chip
          tone={manifest.netcdf.length ? 'accent' : 'warning'}
          title={
            manifest.netcdf.length
              ? manifest.netcdf.map((n) => n.year).join(', ')
              : 'No WetLSP NetCDF files found'
          }
        >
          {manifest.netcdf.length ? <Check size={11} /> : <AlertTriangle size={11} />}
          {manifest.netcdf.length}× NetCDF
        </Chip>
      </div>
      <div className="pt-1 text-[11px] text-[var(--text-faint)]">
        {manifest.layout === 'batched'
          ? 'Batched `_ds` layout'
          : manifest.layout === 'mixed'
            ? 'Mixed layout'
            : 'Single-file layout'}
        {manifest.netcdf.length > 0 &&
          ` · ${manifest.netcdf[0].year}–${manifest.netcdf[manifest.netcdf.length - 1].year}`}
      </div>
    </div>
  );
}
