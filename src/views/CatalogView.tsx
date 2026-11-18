/**
 * Catalog: the full site list as a windowed table. Sort, search, filter by
 * availability; click a row to open that site on the Overview map.
 */
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Search, Table2, Upload } from 'lucide-react';
import { Button, Card, Chip, EmptyState, Segmented, TextInput } from '@/components/ui';
import { AvailabilityStrip, yearAvailability, type YearAvailability } from '@/components/viz/AvailabilityStrip';
import clsx from 'clsx';
import { useAppStore } from '@/store/useAppStore';
import { downloadCsv, timestampedName } from '@/lib/export';
import { formatValue } from '@/lib/format';
import { setCatalogOverride } from '@/lib/catalog';
import type { CatalogSite } from '@/lib/types';

type SortKey = 'site_id' | 'site_name' | 'country' | 'base_network' | 'lat' | 'lon' | 'years';

const ROW_HEIGHT = 38;
const OVERSCAN = 8;

const COLUMNS: Array<{ key: SortKey; label: string; width: string; numeric?: boolean }> = [
  { key: 'site_id', label: 'Site', width: '112px' },
  { key: 'site_name', label: 'Name', width: 'minmax(130px, 1.7fr)' },
  { key: 'country', label: 'Country', width: 'minmax(90px, 0.9fr)' },
  { key: 'base_network', label: 'Network', width: 'minmax(90px, 0.9fr)' },
  { key: 'lat', label: 'Lat', width: '68px', numeric: true },
  { key: 'lon', label: 'Lon', width: '68px', numeric: true },
  // Fixed, and wide enough for four year chips on one line; they must never wrap
  // into a row that is only ROW_HEIGHT tall.
  { key: 'years', label: 'Years', width: '184px' },
];

const GRID = COLUMNS.map((c) => c.width).join(' ');

export function CatalogView() {
  const catalog = useAppStore((s) => s.catalog);
  const siteOrder = useAppStore((s) => s.siteOrder);
  const selectSite = useAppStore((s) => s.selectSite);
  const setView = useAppStore((s) => s.setView);
  const setCatalogFocus = useAppStore((s) => s.setCatalogFocus);
  const focusId = useAppStore((s) => s.catalogFocusId);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'site_id', dir: 1 });
  const [loadedOnly, setLoadedOnly] = useState(false);
  const [layout, setLayout] = useState<'list' | 'cards'>('list');
  const sites = useAppStore((s) => s.sites);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);

  const norm = (id: string) => id.replace(/[-_]/g, '').toLowerCase();
  const loadedSet = useMemo(() => new Set(siteOrder.map(norm)), [siteOrder]);

  const rows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    let out = catalog;
    if (loadedOnly) out = out.filter((s) => loadedSet.has(norm(s.site_id)));
    if (q) {
      out = out.filter((s) =>
        [s.site_id, s.site_name, s.country, s.base_network]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    const dir = sort.dir;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'en', { numeric: true }) * dir;
    });
  }, [catalog, deferredQuery, loadedOnly, loadedSet, sort]);

  const viewportHeight = viewportRef.current?.clientHeight ?? 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = rows.slice(first, first + visibleCount);

  const openSite = (row: CatalogSite) => {
    setCatalogFocus(row.site_id);
    const loaded = siteOrder.find((id) => norm(id) === norm(row.site_id));
    if (loaded) void selectSite(loaded);
    setView('overview');
  };

  if (catalog.length === 0) {
    return (
      <div className="card h-full">
        <EmptyState
          icon={<Table2 size={26} />}
          title="No catalog loaded"
          body="The bundled catalog is empty. Load the WetLSP site catalog CSV from the inspector, or import a site folder to work without one."
        />
      </div>
    );
  }

  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search site, name, country, network…"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={loadedOnly}
            onChange={(e) => setLoadedOnly(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Imported only
        </label>
        <Chip tone={rows.length !== catalog.length ? 'accent' : undefined} title={rows.length !== catalog.length ? 'Filters active' : undefined}>
          {rows.length} of {catalog.length}
        </Chip>
        <Segmented<'list' | 'cards'>
          size="sm"
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'list', label: 'List', title: 'Compact sortable table' },
            { value: 'cards', label: 'Cards', title: 'Visual cards with location and availability' },
          ]}
        />
        <Button
          size="sm"
          icon={<Download size={13} />}
          onClick={() =>
            downloadCsv(
              timestampedName(['wetlsp', 'catalog'], 'csv'),
              ['site_id', 'site_name', 'country', 'base_network', 'lat', 'lon', 'years', 'imported'],
              rows.map((r) => [
                r.site_id,
                r.site_name ?? '',
                r.country ?? '',
                r.base_network ?? '',
                r.lat ?? '',
                r.lon ?? '',
                availableYears(r).join(' '),
                loadedSet.has(norm(r.site_id)) ? 'yes' : 'no',
              ]),
            )
          }
        >
          CSV
        </Button>
      </div>

      {layout === 'cards' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))' }}>
            {rows.map((row) => {
              const loadedId = siteOrder.find((id) => norm(id) === norm(row.site_id));
              const state = loadedId ? sites[loadedId] : null;
              return (
                <SiteCard
                  key={row.site_id}
                  row={row}
                  focused={Boolean(focusId && norm(focusId) === norm(row.site_id))}
                  availability={yearAvailability(state?.manifest ?? null, state?.facts?.years ?? [], row)}
                  imported={Boolean(state)}
                  onOpen={() => openSite(row)}
                />
              );
            })}
          </div>
        </div>
      ) : (
      <>
      <div
        className="grid shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-sunken)] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]"
        style={{ gridTemplateColumns: GRID, scrollbarGutter: 'stable' }}
      >
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            onClick={() =>
              setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))
            }
            className={`flex items-center gap-1 hover:text-[var(--text)] ${c.numeric ? 'justify-end' : ''}`}
          >
            {c.label}
            {sort.key === c.key &&
              (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
          </button>
        ))}
      </div>

      <div
        ref={viewportRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {slice.map((row) => {
              const imported = loadedSet.has(norm(row.site_id));
              const focused = focusId && norm(focusId) === norm(row.site_id);
              return (
                <button
                  key={row.site_id}
                  onClick={() => openSite(row)}
                  style={{ gridTemplateColumns: GRID, height: ROW_HEIGHT }}
                  className={`grid w-full items-center gap-3 border-b border-[var(--border)] px-4 text-left text-[12.5px] transition-colors ${
                    focused ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate font-medium">
                    {imported && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" title="Imported on this device" aria-label="Imported" />}
                    {row.site_id}
                  </span>
                  <span className="truncate text-[var(--text-muted)]">{row.site_name ?? '—'}</span>
                  <span className="truncate text-[var(--text-muted)]">{row.country ?? '—'}</span>
                  <span className="truncate text-[var(--text-muted)]">{row.base_network ?? '—'}</span>
                  <span className="text-right tabular-nums text-[var(--text-muted)]">
                    {row.lat === undefined ? '—' : formatValue(row.lat, 3)}
                  </span>
                  <span className="text-right tabular-nums text-[var(--text-muted)]">
                    {row.lon === undefined ? '—' : formatValue(row.lon, 3)}
                  </span>
                  <span className="flex flex-nowrap gap-1 overflow-hidden">
                    {availableYears(row).map((y) => (
                      <span key={y} className="chip px-1.5 py-0 text-[10.5px]">
                        {y}
                      </span>
                    ))}
                    {availableYears(row).length === 0 && (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function availableYears(row: CatalogSite): number[] {
  return Object.entries(row.years)
    .filter(([, v]) => v)
    .map(([k]) => Number(k))
    .sort();
}

function sortValue(row: CatalogSite, key: SortKey): string | number {
  if (key === 'years') return availableYears(row).length;
  if (key === 'lat') return row.lat ?? -999;
  if (key === 'lon') return row.lon ?? -999;
  return (row[key] as string | undefined) ?? '';
}

/* ------------------------------------------------------------- inspector */

export function CatalogInspector() {
  const catalog = useAppStore((s) => s.catalog);
  const source = useAppStore((s) => s.catalogSource);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const toast = useAppStore((s) => s.toast);
  const siteOrder = useAppStore((s) => s.siteOrder);

  const mappable = catalog.filter((s) => s.lat !== undefined && s.lon !== undefined).length;
  const withYears = catalog.filter((s) => Object.values(s.years).some(Boolean)).length;

  const loadFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const sites = await setCatalogOverride(file.name, await file.text());
        setCatalog(sites, 'user');
        toast({
          kind: 'success',
          title: 'Catalog loaded',
          detail: `${sites.length} sites from ${file.name}.`,
        });
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

  return (
    <div className="space-y-3">
      <Card
        title="Catalog"
        subtitle={
          source === 'user'
            ? 'Loaded from a file you supplied'
            : source === 'bundled'
              ? 'Bundled with the app and available offline'
              : 'None loaded'
        }
        actions={
          <Button
            size="sm"
            icon={<Upload size={13} />}
            onClick={loadFile}
            title="Load a catalog CSV or JSON. Needs a site_id column; lat/lon place sites on the map and wetlsp_<year> columns fill availability."
          >
            Load
          </Button>
        }
      >
        <dl className="space-y-1.5 text-[12px]">
          <Row label="Sites" value={String(catalog.length)} />
          <Row label="With coordinates" value={`${mappable}`} />
          <Row label="With availability flags" value={`${withYears}`} />
          <Row label="Imported here" value={`${siteOrder.length}`} />
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** A catalog site as a small card: where it is, what it holds, whether it is here. */
function SiteCard({
  row, focused, availability, imported, onOpen,
}: {
  row: CatalogSite;
  focused: boolean;
  availability: YearAvailability[];
  imported: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx(
        'group flex flex-col gap-2.5 rounded-[12px] border bg-[var(--bg-elevated)] p-3 text-left transition-[border-color,box-shadow] duration-150 hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-pop)]',
        focused ? 'border-[var(--accent)]' : 'border-[var(--border)]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold">
            {row.site_id}
            <span className={clsx('rounded-[5px] px-1.5 py-px text-[10px] font-medium', imported ? 'bg-[var(--pale)] text-[var(--accent)]' : 'bg-[var(--bg-sunken)] text-[var(--text-faint)]')}>
              {imported ? 'Imported' : 'Catalog'}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[13px]" title={row.site_name}>{row.site_name ?? '—'}</div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">{[row.country, row.base_network].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <WorldDot lat={row.lat} lon={row.lon} />
      </div>
      <AvailabilityStrip items={availability} compact />
    </button>
  );
}

/** Where on Earth: one dot on a plain equirectangular frame. */
function WorldDot({ lat, lon }: { lat?: number; lon?: number }) {
  const W = 64;
  const H = 34;
  const has = lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 rounded-[6px] bg-[var(--bg-sunken)]" aria-label={has ? `${lat!.toFixed(2)}, ${lon!.toFixed(2)}` : 'No coordinates'}>
      {[-60, -30, 0, 30, 60].map((g) => <line key={`p${g}`} x1={0} x2={W} y1={H / 2 - (g / 90) * (H / 2)} y2={H / 2 - (g / 90) * (H / 2)} stroke="var(--border)" strokeWidth={g === 0 ? 0.8 : 0.4} />)}
      {[-120, -60, 0, 60, 120].map((g) => <line key={`m${g}`} y1={0} y2={H} x1={W / 2 + (g / 180) * (W / 2)} x2={W / 2 + (g / 180) * (W / 2)} stroke="var(--border)" strokeWidth={0.4} />)}
      {has && (
        <>
          <circle cx={W / 2 + (lon! / 180) * (W / 2)} cy={H / 2 - (lat! / 90) * (H / 2)} r={4.5} fill="var(--accent)" opacity={0.18} />
          <circle cx={W / 2 + (lon! / 180) * (W / 2)} cy={H / 2 - (lat! / 90) * (H / 2)} r={2.2} fill="var(--accent)" />
        </>
      )}
    </svg>
  );
}
