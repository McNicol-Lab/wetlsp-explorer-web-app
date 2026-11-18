/**
 * Overview: every catalog site on a world map, loaded ones picked out in the
 * accent colour, and the selected site's record in the inspector.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import { ArrowRight, Globe2, Info, MapPin, RotateCw, Upload } from 'lucide-react';
import { MapCanvas, type MapCanvasHandle } from '@/components/MapCanvas';
import { Button, Card, Chip, EmptyState } from '@/components/ui';
import { useAppStore } from '@/store/useAppStore';
import { useImportActions } from '@/components/DropTarget';
import clsx from 'clsx';
import { useBasemap, useDark } from './shared';
import { formatBytes, formatCount, formatValue } from '@/lib/format';
import { compositeCanvas, downloadBlob, exportBackground, timestampedName } from '@/lib/export';
import { canvasToBlob, copyImage } from '@/lib/figure';
import { FigureMenu } from '@/components/FigureMenu';
import type { CatalogSite } from '@/lib/types';
import { nearestPixelIndex } from '@/lib/pixelPicking';

interface MapSite {
  siteId: string;
  lon: number;
  lat: number;
  loaded: boolean;
  label: string;
}

/** Catalog rows plus any loaded site the catalog does not know about. */
function useMapSites(): MapSite[] {
  const catalog = useAppStore((s) => s.catalog);
  const sites = useAppStore((s) => s.sites);

  const order = useAppStore((s) => s.siteOrder);

  return useMemo(() => {
    const out: MapSite[] = [];
    const seen = new Set<string>();
    const norm = (id: string) => id.replace(/[-_]/g, '').toLowerCase();
    const loadedNorm = new Set(order.map(norm));

    for (const c of catalog) {
      if (c.lon === undefined || c.lat === undefined) continue;
      if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) continue;
      seen.add(norm(c.site_id));
      out.push({
        siteId: c.site_id,
        lon: c.lon,
        lat: c.lat,
        loaded: loadedNorm.has(norm(c.site_id)),
        label: c.site_name ? `${c.site_id} · ${c.site_name}` : c.site_id,
      });
    }

    // A site whose coordinates the catalog lacks still belongs on the map:
    // use the centroid of its own pixels.
    for (const id of order) {
      if (seen.has(norm(id))) continue;
      const g = sites[id]?.geometry;
      if (!g || g.lon.length === 0) continue;
      let lon = 0;
      let lat = 0;
      for (let i = 0; i < g.lon.length; i++) {
        lon += g.lon[i];
        lat += g.lat[i];
      }
      out.push({
        siteId: id,
        lon: lon / g.lon.length,
        lat: lat / g.lat.length,
        loaded: true,
        label: `${id} (from pixel geometry)`,
      });
    }
    return out;
  }, [catalog, sites, order]);
}

export function OverviewView() {
  const mapRef = useRef<MapCanvasHandle>(null);
  const dark = useDark();
  const basemap = useBasemap();
  const mapSites = useMapSites();
  const focusId = useAppStore((s) => s.catalogFocusId);
  const setCatalogFocus = useAppStore((s) => s.setCatalogFocus);
  const selectSite = useAppStore((s) => s.selectSite);
  const sites = useAppStore((s) => s.sites);
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const openInspector = useAppStore((s) => s.openInspector);
  const activeGeometry = useAppStore((s) => (s.activeSiteId ? s.sites[s.activeSiteId]?.geometry ?? null : null));

  // Selecting a site (sidebar, marker or search) focuses the map on its pixels.
  const siteBounds = useMemo(() => geometryBounds(activeGeometry), [activeGeometry]);
  useEffect(() => {
    if (!siteBounds) return;
    // The map may still be mounting; give it a frame.
    const t = window.setTimeout(() => mapRef.current?.fitBounds(siteBounds, 140), 50);
    return () => window.clearTimeout(t);
  }, [siteBounds, activeSiteId]);

  const markerPositions = useMemo(() => ({
    lon: Float64Array.from(mapSites, (s) => s.lon),
    lat: Float64Array.from(mapSites, (s) => s.lat),
  }), [mapSites]);

  const catalogBounds = useMemo<[number, number, number, number] | null>(() => {
    if (mapSites.length < 2) return null;
    return [
      Math.min(...mapSites.map((s) => s.lon)),
      Math.min(...mapSites.map((s) => s.lat)),
      Math.max(...mapSites.map((s) => s.lon)),
      Math.max(...mapSites.map((s) => s.lat)),
    ];
  }, [mapSites]);

  const layers = useMemo(() => {
    const accent = dark ? [45, 212, 191] : [15, 118, 110];
    const neutral = dark ? [130, 142, 158] : [120, 130, 146];
    const focusNorm = focusId?.replace(/[-_]/g, '').toLowerCase();
    const footprint = activeGeometry
      ? new ScatterplotLayer({
          id: 'site-footprint',
          data: { length: activeGeometry.lon.length },
          getPosition: (_: unknown, { index }: { index: number }) => [activeGeometry.lon[index], activeGeometry.lat[index]],
          getRadius: 1,
          radiusUnits: 'pixels',
          getFillColor: [...accent, 120] as [number, number, number, number],
          pickable: false,
          updateTriggers: { getPosition: activeGeometry },
        })
      : null;
    return [
      ...(footprint ? [footprint] : []),
      new ScatterplotLayer<MapSite>({
        id: 'sites',
        data: mapSites,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => (d.loaded ? 7 : 5),
        radiusUnits: 'pixels',
        radiusMinPixels: 4,
        getFillColor: (d) =>
          d.loaded
            ? ([...accent, 235] as [number, number, number, number])
            : ([...neutral, 170] as [number, number, number, number]),
        getLineColor: (d) =>
          d.siteId.replace(/[-_]/g, '').toLowerCase() === focusNorm
            ? [255, 255, 255, 255]
            : [255, 255, 255, 110],
        getLineWidth: (d) => (d.siteId.replace(/[-_]/g, '').toLowerCase() === focusNorm ? 3 : 1),
        lineWidthUnits: 'pixels',
        stroked: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [...accent, 255],
        updateTriggers: { getLineColor: focusId, getLineWidth: focusId, getFillColor: mapSites },
      }),
      new TextLayer<MapSite>({
        id: 'site-labels',
        data: mapSites.filter((d) => d.loaded),
        getPosition: (d) => [d.lon, d.lat],
        getText: (d) => d.siteId,
        getSize: 11,
        getPixelOffset: [0, -14],
        getColor: dark ? [232, 236, 242, 235] : [20, 24, 31, 235],
        outlineWidth: 3,
        outlineColor: dark ? [11, 15, 20, 220] : [255, 255, 255, 230],
        fontSettings: { sdf: true },
        characterSet: 'auto',
        pickable: false,
      }),
    ];
  }, [mapSites, focusId, dark, activeGeometry]);

  const onClick = (info: PickingInfo) => {
    let site = info.object as MapSite | undefined;
    const map = mapRef.current?.map();
    // GPU picking can miss after the interleaved map fits its bounds. Use the
    // same actual-map projection fallback as the pixel map, sized for markers.
    if (!site && map) {
      const index = nearestPixelIndex(markerPositions, [info.x, info.y], map, 10);
      if (index >= 0) site = mapSites[index];
    }
    if (!site) return;
    const selected = site;
    setCatalogFocus(site.siteId);
    openInspector();
    const loadedId = Object.keys(sites).find(
      (id) => id.replace(/[-_]/g, '').toLowerCase() === selected.siteId.replace(/[-_]/g, '').toLowerCase(),
    );
    if (loadedId) void selectSite(loadedId);
  };

  const mapImage = () => {
    mapRef.current?.repaint();
    const canvas = mapRef.current?.canvas();
    if (!canvas) throw new Error('The map is not ready yet.');
    return compositeCanvas([canvas], exportBackground());
  };
  const figureActions = {
    save: async () =>
      downloadBlob(await canvasToBlob(mapImage()), timestampedName(['wetlsp', 'overview'], 'png')),
    copy: () => copyImage(canvasToBlob(mapImage())),
  };

  if (mapSites.length === 0) {
    return (
      <div className="card h-full">
        <EmptyState
          icon={<MapPin size={22} />}
          title="No datasets loaded."
          action={<ImportButton />}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <SiteSummaryBar />
      <MapCanvas
        ref={mapRef}
        basemap={basemap}
        dark={dark}
        layers={layers}
        initialViewState={{ longitude: -30, latitude: 32, zoom: 1.25 }}
        initialBounds={siteBounds ?? catalogBounds}
        onClick={onClick}
        getTooltip={(info) => {
          const s = info.object as MapSite | undefined;
          if (!s) return null;
          return `<b>${s.label}</b><br/>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${
            s.loaded ? '<br/><span style="opacity:.7">Imported · click to open</span>' : '<br/><span style="opacity:.7">Catalog only</span>'
          }`;
        }}
        className="relative min-h-0 w-full flex-1 card overflow-hidden"
      >
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/95 px-2 py-1 text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--accent)]" />Imported</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--text-faint)] opacity-70" />Catalog</span>
        </div>
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
          {catalogBounds && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Globe2 size={13} />}
              onClick={() => mapRef.current?.fitBounds(catalogBounds, 40)}
              title="Show every catalog site"
            >
              World
            </Button>
          )}
          <FigureMenu actions={figureActions} />
        </div>
      </MapCanvas>
    </div>
  );
}

function geometryBounds(g: { lon: Float64Array; lat: Float64Array } | null): [number, number, number, number] | null {
  if (!g || g.lon.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < g.lon.length; i++) {
    const x = g.lon[i], y = g.lat[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

function ImportButton() {
  const { openFolder } = useImportActions();
  return <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={openFolder}>Import dataset</Button>;
}

/** One line: the active site, what it holds, and the one obvious next step. */
function SiteSummaryBar() {
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const state = useAppStore((s) => (s.activeSiteId ? s.sites[s.activeSiteId] : null));
  const record = useAppStore((s) => (s.activeSiteId ? s.catalogIndex.get(s.activeSiteId) : undefined));
  const setView = useAppStore((s) => s.setView);
  const openInspector = useAppStore((s) => s.openInspector);
  const setCatalogFocus = useAppStore((s) => s.setCatalogFocus);

  if (!activeSiteId || !state) {
    return (
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 px-1 text-[13px] text-[var(--text-muted)]">
        <span>Select a site on the map, or import one.</span>
        <ImportButton />
      </div>
    );
  }

  const facts = state.facts;
  const years = [...new Set(state.manifest.netcdf.map((n) => n.year))].sort((a, b) => a - b);
  const status =
    state.status === 'error' ? { text: 'Failed to open', tone: 'text-red-600 dark:text-red-400' }
    : state.status === 'loading' ? { text: 'Loading…', tone: 'text-amber-600 dark:text-amber-400' }
    : state.notes.length ? { text: `${state.notes.length} note${state.notes.length > 1 ? 's' : ''}`, tone: 'text-amber-600 dark:text-amber-400' }
    : { text: 'Ready', tone: 'text-[var(--accent)]' };
  const next = state.manifest.timeseries
    ? { view: 'timeseries' as const, label: 'Explore time series' }
    : state.geometry ? { view: 'pixelmap' as const, label: 'Open pixel map' }
    : state.manifest.netcdf.length ? { view: 'phenometrics' as const, label: 'Open phenometrics' }
    : null;

  return (
    <div className="flex h-10 shrink-0 items-center gap-5 whitespace-nowrap px-1 text-[12px]">
      <div className="min-w-0 truncate">
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{record?.site_name ?? activeSiteId}</span>
        {record?.country && <span className="ml-2 hidden text-[var(--text-muted)] min-[1440px]:inline">{record.country}</span>}
      </div>
      <dl className="flex shrink-0 items-center gap-4">
        <Stat label="Years" value={years.length ? (years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : `${years[0]}`) : '—'} hint={years.length ? `NetCDF for ${years.join(', ')}` : 'No annual NetCDF imported'} />
        <Stat label="Pixels" value={facts?.pixelCount ? formatCount(facts.pixelCount) : state.geometry ? formatCount(state.geometry.lon.length) : '—'} hint={state.meta.radius_m ? `${state.meta.radius_m} m extraction radius` : undefined} />
        {!!facts?.series.length && <Stat className="hidden min-[1360px]:flex" label="EVI" value={facts.series.join(' + ')} hint="spline: smoothed, gap-filled · raw: observed acquisitions" />}
        <div className="flex items-baseline gap-1.5">
          <dt className="text-[var(--text-faint)]">Status</dt>
          <dd className={clsx('font-medium', status.tone)}>{status.text}</dd>
        </div>
      </dl>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={<Info size={13} />} onClick={() => { setCatalogFocus(activeSiteId); openInspector(); }}>
          Details
        </Button>
        {next && state.status === 'ready' && (
          <Button size="sm" variant="primary" onClick={() => setView(next.view)}>
            {next.label} <ArrowRight size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className={clsx('flex items-baseline gap-1.5', className)} title={hint}>
      <dt className="text-[var(--text-faint)]">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------- inspector */

export function OverviewInspector() {
  const focusId = useAppStore((s) => s.catalogFocusId);
  const activeSiteId = useAppStore((s) => s.activeSiteId);
  const catalogIndex = useAppStore((s) => s.catalogIndex);
  const sites = useAppStore((s) => s.sites);
  const selectSite = useAppStore((s) => s.selectSite);
  const { openFolder } = useImportActions();

  const id = focusId ?? activeSiteId;
  if (!id) {
    return <EmptyState compact icon={<MapPin size={18} />} title="Select a site on the map." />;
  }

  const record = catalogIndex.get(id);
  const loadedId = Object.keys(sites).find(
    (s) => s.replace(/[-_]/g, '').toLowerCase() === id.replace(/[-_]/g, '').toLowerCase(),
  );
  const state = loadedId ? sites[loadedId] : null;
  const facts = state?.facts;
  const date = (value: string | null | undefined) => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };

  const data: Array<[string, string]> = [];
  if (state) {
    if (facts?.pixelCount) data.push(['Pixels', formatCount(facts.pixelCount)]);
    if (facts?.timeseriesRows) {
      data.push(['EVI series', facts.series.join(', ')]);
      data.push(['EVI dates', `${date(facts.dateMin)} – ${date(facts.dateMax)}`]);
      data.push(['Series rows', formatCount(facts.timeseriesRows)]);
    } else if (!state.manifest.timeseries) {
      data.push(['EVI series', 'not imported']);
    }
    data.push(['On disk', formatBytes(state.bytesOnDisk)]);
  }

  return (
    <div className="space-y-0">
      <Card
        title={id}
        subtitle={record?.site_name ?? (state ? 'Imported' : 'Catalog only')}
        actions={
          state ? (
            loadedId !== activeSiteId ? (
              <Button size="sm" onClick={() => void selectSite(loadedId!)}>Open</Button>
            ) : null
          ) : (
            <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={openFolder}>Import</Button>
          )
        }
      >
        {state ? <PropertyList rows={data} /> : (
          <p className="text-[12px] text-[var(--text-muted)]">Not imported on this device.</p>
        )}
      </Card>

      <Card title="Annual phenometrics">
        <div className="flex flex-wrap gap-1.5">
          {yearChips(state?.manifest.netcdf.map((n) => n.year) ?? [], record).map((c) => (
            <Chip key={c.year} tone={c.tone} title={c.note ?? 'NetCDF imported'}>
              {c.year}{c.note === 'in catalog' ? ' ·' : ''}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[var(--text-faint)]">
          {state ? 'Filled: imported. A file does not guarantee valid estimates in every cell.' : 'From catalog availability flags.'}
        </p>
      </Card>

      <Card title="Site & projection">
        <SiteRecord record={record} state={state} />
      </Card>

      {state && (state.notes.length > 0 || state.status === 'error') && (
        <Card
          title={state.status === 'error' ? 'Could not open this site' : 'Notes'}
          actions={
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCw size={12} className={state.status === 'loading' ? 'animate-spin' : undefined} />}
              disabled={state.status === 'loading'}
              onClick={() => void useAppStore.getState().reloadSite(state.manifest.siteId)}
              title="Read pixels_meta and the pixel geometry again from the stored files"
            >
              Reload
            </Button>
          }
        >
          {state.status === 'error' && state.error && (
            <p className="mb-2 rounded-md bg-red-500/10 px-2.5 py-2 text-[12px] leading-snug text-red-600 dark:text-red-400">{state.error}</p>
          )}
          <ul className="space-y-1.5 text-[12px] leading-snug text-[var(--text-muted)]">
            {state.notes.map((n) => (
              <li key={n} className="flex gap-1.5"><span className="text-amber-500">•</span>{n}</li>
            ))}
          </ul>
        </Card>
      )}

      {state && (
        <details className="group border-t border-[var(--border)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
          <summary className="cursor-pointer list-none font-medium text-[var(--text)] marker:hidden">
            <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> About this data
          </summary>
          <ul className="mt-2 space-y-1.5 leading-relaxed">
            {!!facts?.series.includes('spline') && <li><b className="font-medium text-[var(--text)]">spline</b> is a smoothed, gap-filled trajectory, not independent daily observations.</li>}
            {!!facts?.series.includes('raw') && <li><b className="font-medium text-[var(--text)]">raw</b> values are per-acquisition observations; gaps remain.</li>}
            <li>Each row is one pixel on one date in one series. Chart summaries describe only the sampled or selected pixels.</li>
            {state.geometry && <li>Projected coordinates are transformed to WGS84 for display.</li>}
            <li>Check the QA layers before reading much into a seasonal pattern.</li>
          </ul>
        </details>
      )}
    </div>
  );
}

function PropertyList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[12px] text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 truncate text-right text-[12px] font-medium" title={v}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function yearChips(
  ingestedYears: number[],
  record: CatalogSite | undefined,
): Array<{ year: number; tone: 'accent' | 'muted'; note?: string }> {
  const catalogYears = record ? Object.keys(record.years).map(Number) : [];
  const all = [...new Set([...ingestedYears, ...catalogYears])].sort((a, b) => a - b);
  if (all.length === 0) return [];
  return all.map((year) => {
    const have = ingestedYears.includes(year);
    const claimed = record?.years[year] ?? false;
    return {
      year,
      tone: have ? 'accent' : 'muted',
      note: have ? undefined : claimed ? 'in catalog' : 'not available',
    };
  });
}

function SiteRecord({
  record,
  state,
}: {
  record: CatalogSite | undefined;
  state: { meta: Record<string, string | undefined>; geometry: { epsg: number | null; crsName: string | null; crsSource: string } | null } | null;
}) {
  const rows: Array<[string, string]> = [];
  if (record?.country) rows.push(['Country', record.country]);
  if (record?.lat !== undefined && record?.lon !== undefined) {
    rows.push(['Coordinates', `${formatValue(record.lat, 5)}, ${formatValue(record.lon, 5)}`]);
  }
  if (record?.base_network) rows.push(['Network', record.base_network]);
  if (record?.tower_height_m !== undefined) rows.push(['Tower height', `${record.tower_height_m} m`]);
  if (record?.canopy_height_m !== undefined)
    rows.push(['Canopy height', `${record.canopy_height_m} m`]);
  if (state?.meta.radius_m) rows.push(['Extraction radius', `${state.meta.radius_m} m`]);
  if (state?.geometry?.epsg) {
    rows.push([
      'CRS',
      `EPSG:${state.geometry.epsg}${state.geometry.crsName ? ` · ${state.geometry.crsName}` : ''}`,
    ]);
  } else if (state?.geometry?.crsName) {
    rows.push(['CRS', state.geometry.crsName]);
  }
  if (state?.meta.pixel_id_source) rows.push(['Pixel id source', state.meta.pixel_id_source]);

  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[var(--text-muted)]">No catalog record. Load one from Settings.</p>
    );
  }

  return (
    <dl className="space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[12px] text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 break-words text-right text-[12px] font-medium" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
