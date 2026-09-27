/**
 * Overview: every catalog site on a world map, loaded ones picked out in the
 * accent colour, and the selected site's record in the inspector.
 */
import { useMemo, useRef } from 'react';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import { MapPin, RotateCw, Upload } from 'lucide-react';
import { MapCanvas, type MapCanvasHandle } from '@/components/MapCanvas';
import { Button, Card, Chip, EmptyState, StatTile } from '@/components/ui';
import { useAppStore, type SiteState } from '@/store/useAppStore';
import { useImportActions } from '@/components/DropTarget';
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
    return [
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
  }, [mapSites, focusId, dark]);

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
          icon={<MapPin size={26} />}
          title="No sites to map yet"
          body="The bundled catalog has no coordinates, and no dataset has been imported. Import a site folder, or load a catalog CSV from Settings."
        />
      </div>
    );
  }

  return (
    <MapCanvas
      ref={mapRef}
      basemap={basemap}
      dark={dark}
      layers={layers}
      initialViewState={{ longitude: -30, latitude: 32, zoom: 1.25 }}
      initialBounds={catalogBounds}
      onClick={onClick}
      getTooltip={(info) => {
        const s = info.object as MapSite | undefined;
        if (!s) return null;
        return `<b>${s.label}</b><br/>${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${
          s.loaded ? '<br/><span style="opacity:.7">Imported. Click to open.</span>' : '<br/><span style="opacity:.7">In catalog only</span>'
        }`;
      }}
      className="relative h-full w-full card overflow-hidden"
    >
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex gap-1.5">
        <span className="chip pointer-events-auto bg-[var(--bg-elevated)]">
          <span className="h-2 w-2 rounded-full bg-[var(--accent)]" /> loaded
        </span>
        <span className="chip pointer-events-auto bg-[var(--bg-elevated)]">
          <span className="h-2 w-2 rounded-full bg-[var(--text-faint)]" /> catalog only
        </span>
      </div>
      <div className="absolute right-3 top-3 z-10">
        <FigureMenu actions={figureActions} />
      </div>
    </MapCanvas>
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
  const setView = useAppStore((s) => s.setView);

  const id = focusId ?? activeSiteId;
  if (!id) {
    return (
      <EmptyState
        compact
        icon={<MapPin size={20} />}
        title="Pick a site"
        body="Click a marker on the map to see its record."
      />
    );
  }

  const record = catalogIndex.get(id);
  const loadedId = Object.keys(sites).find(
    (s) => s.replace(/[-_]/g, '').toLowerCase() === id.replace(/[-_]/g, '').toLowerCase(),
  );
  const state = loadedId ? sites[loadedId] : null;

  return (
    <div className="space-y-3">
      <Card
        title={record?.site_name ? `${id} · ${record.site_name}` : id}
        subtitle={state?.status === 'ready' ? 'Loaded and ready' : state ? 'Dataset imported' : 'Catalog record · data not imported'}
        actions={
          state ? (
            loadedId !== activeSiteId ? (
              <Button size="sm" onClick={() => void selectSite(loadedId!)}>
                Open
              </Button>
            ) : null
          ) : (
            <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={openFolder}>
              Import
            </Button>
          )
        }
      >
        <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
          {record?.country ? `A monitoring site in ${record.country}. ` : ''}
          {state?.facts?.timeseriesRows
            ? 'Explore seasonal vegetation greenness across the site, then compare when growth begins, peaks and declines.'
            : 'Explore pixel-level vegetation greenness and annual phenology when site data are imported.'}
        </p>
        {!state && <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">This summary comes from the catalog. Import the site folder to see its actual coverage and dates.</p>}
      </Card>

      <DatasetSummary state={state} record={record} />

      {state?.status === 'ready' && (
        <Card title="Start an analysis">
          <div className="flex flex-col items-start gap-2">
            {([
              ['timeseries', 'Explore seasonal EVI →', !!state.manifest.timeseries],
              ['pixelmap', 'Compare locations within the site →', !!state.geometry],
              ['phenometrics', 'Compare annual phenology →', state.manifest.netcdf.length > 0],
            ] as const).filter(([, , available]) => available).map(([view, label]) => (
              <button key={view} className="text-left text-[12.5px] text-[var(--accent)] hover:underline" onClick={async () => {
                if (loadedId && loadedId !== activeSiteId) await selectSite(loadedId);
                setView(view);
              }}>{label}</button>
            ))}
          </div>
        </Card>
      )}

      <Card title="Site & spatial reference" subtitle="Catalog context and imported metadata">
        <SiteRecord record={record} state={state} />
      </Card>

      {state?.facts && (
        <Card title="Dataset inventory" subtitle="Whole imported site · not the current chart sample">
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Pixels" value={formatCount(state.facts.pixelCount)} />
            <StatTile
              label="Series rows"
              value={formatCount(state.facts.timeseriesRows)}
              hint={state.facts.series.join(' · ')}
            />
            <StatTile
              label="Years"
              value={state.facts.years.length}
              hint={
                state.facts.years.length
                  ? `${state.facts.years[0]}–${state.facts.years[state.facts.years.length - 1]}`
                  : undefined
              }
            />
            <StatTile
              label="On disk"
              value={formatBytes(state.bytesOnDisk)}
              hint={state.meta.radius_m ? `radius ${state.meta.radius_m} m` : undefined}
            />
          </div>
        </Card>
      )}

      {state && (
        <Card title="Annual phenometrics" subtitle="NetCDF years · filled chips are imported">
          <div className="flex flex-wrap gap-1.5">
            {yearChips(state.manifest.netcdf.map((n) => n.year), record).map((c) => (
              <Chip key={c.year} tone={c.tone}>
                {c.year}
                {c.note ? ` · ${c.note}` : ''}
              </Chip>
            ))}
          </div>
        </Card>
      )}

      {state && (state.notes.length > 0 || state.status === 'error' || state.status === 'ready') && (
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
              Reload metadata
            </Button>
          }
        >
          {state.status === 'error' && state.error && (
            <p className="mb-2 rounded-[9px] bg-red-500/10 px-2.5 py-2 text-[12.5px] leading-snug text-red-600 dark:text-red-400">
              {state.error}
            </p>
          )}
          {state.notes.length > 0 ? (
            <ul className="space-y-1.5 text-[12.5px] leading-snug text-[var(--text-muted)]">
              {state.notes.map((n) => (
                <li key={n} className="flex gap-1.5">
                  <span className="text-amber-500">•</span>
                  {n}
                </li>
              ))}
            </ul>
          ) : (
            state.status === 'ready' && (
              <p className="text-[12.5px] text-[var(--text-muted)]">No problems found while loading.</p>
            )
          )}
        </Card>
      )}
    </div>
  );
}

/** Describe the inventory, without inferring completeness or ecological trends. */
function DatasetSummary({ state, record }: { state: SiteState | null; record?: CatalogSite }) {
  const facts = state?.facts;
  const date = (value: string | null) => {
    if (!value) return 'unknown';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const years = [...new Set(state?.manifest.netcdf.map((file) => file.year) ?? [])].sort((a, b) => a - b);
  const advertised = Object.entries(record?.years ?? {}).filter(([, available]) => available).map(([year]) => year);
  const paragraph = 'text-[12.5px] leading-relaxed text-[var(--text-muted)]';
  if (!state) return (
    <Card title="Catalog availability">
      <p className={paragraph}>{advertised.length ? `Annual phenometrics listed for ${advertised.join(', ')}.` : 'No annual phenometrics are marked available in this catalog record.'}</p>
      <p className="mt-2 text-xs text-[var(--text-faint)]">Availability flags describe the catalog, not files saved on this device.</p>
    </Card>
  );
  return (
    <Card title="Data at a glance" subtitle="Based on the files saved on this device">
      <div className="space-y-4">
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium">Vegetation time series</h3>
          <p className={paragraph}>{facts?.timeseriesRows
            ? `${date(facts.dateMin)} – ${date(facts.dateMax)}. ${facts.years.length} recorded years; ${facts.series.join(' and ')} EVI series.`
            : state.manifest.timeseries ? 'Reading the time-series inventory…' : 'No time-series parquet imported.'}</p>
          {!!facts?.series.includes('raw') && <p className={`mt-1 ${paragraph}`}>Raw values are available observations; gaps can remain.</p>}
          {!!facts?.series.includes('spline') && <p className={`mt-1 ${paragraph}`}>Spline values are a smoothed, gap-filled trajectory, not independent daily observations.</p>}
        </div>
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium">Annual phenology</h3>
          <p className={paragraph}>{years.length
            ? `${years.length} NetCDF ${years.length === 1 ? 'file' : 'files'}: ${years.join(', ')}. They hold seasonal timing, greenness and quality layers. Having a file for a year does not mean every cell has a valid estimate.`
            : 'No annual NetCDF files imported.'}</p>
        </div>
        <div>
          <h3 className="mb-1 text-[12.5px] font-medium">Spatial coverage</h3>
          <p className={paragraph}>{facts?.pixelCount
            ? `${formatCount(facts.pixelCount)} pixel locations${state.meta.radius_m ? `; ${state.meta.radius_m} m extraction radius from the imported metadata` : ''}.`
            : 'Pixel coverage is not available from the imported files.'} {state.geometry ? 'Projected coordinates are transformed to WGS84 for the map.' : ''}</p>
        </div>
        {!!facts?.timeseriesRows && <p className="border-t border-[var(--border)] pt-3 text-xs leading-relaxed text-[var(--text-muted)]">Each row is one pixel on one date in one series, not a separate field measurement. Chart summaries describe only the sampled or selected pixels, so check the QA layers (and raw observations, where a site has them) before reading much into a seasonal pattern.</p>}
      </div>
    </Card>
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
      <p className="text-[12.5px] leading-snug text-[var(--text-muted)]">
        No catalog record for this site. Load the WetLSP site catalog from Settings to fill in
        names, coordinates and network metadata.
      </p>
    );
  }

  return (
    <dl className="space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[12px] text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 break-words text-right text-[12.5px] font-medium" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
