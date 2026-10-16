/**
 * Pixel Map layers the user brings: regions (drawn boxes and lassos, or
 * shapefile polygons) and a raster overlay (GeoTIFF or NetCDF).
 *
 * Regions are compared in the Time Series; this file holds their import,
 * their map layers and their inspector cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BitmapLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { Download, Eye, EyeOff, Layers, LineChart, Shuffle, Trash2, Upload, X } from 'lucide-react';
import { Button, Card, Field, Select, Slider } from '@/components/ui';
import { useActiveSite, useAppStore, useOverlay, useRegions, type Region } from '@/store/useAppStore';
import { extractShapes } from '@/engine/queries';
import { readRasterOverlay } from '@/engine/overlay';
import { isZipPath, listZip, openZipMember } from '@/lib/zip';
import { groupShapefileParts, type ShapefileParts } from '@/lib/shapefile';
import {
  MAX_COMPARED_REGIONS,
  formatBox,
  isNwiLayer,
  kmToBox,
  regionDrafts,
  regionsToGeoJson,
  summarizeLayers,
  type ShapeLayerSummary,
} from '@/lib/regions';
import { OVERLAY_RAMPS, colorize, type OverlayRamp } from '@/lib/overlay';
import { hexToRgb, rampToCssGradient } from '@/lib/colorscales';
import { downloadBlob, downloadCsv, timestampedName } from '@/lib/export';
import { formatCount, formatValue } from '@/lib/format';
import { pixelIndex } from '@/lib/pixelIndex';
import type { PixelGeometry } from '@/lib/types';
import { useMapImportQueue } from '@/lib/mapImport';

export { useMapImportQueue };

/* ---------------------------------------------------------------- files */

const SHAPE_PART = /\.(shp|shx|dbf|prj|cpg)$/i;
const RASTER = /\.(tiff?|nc4?)$/i;
const SHAPE_ACCEPT = '.shp,.shx,.dbf,.prj,.cpg,.zip,.tif,.tiff,.nc';

const setBusy = (busy: string | null) => useMapImportQueue.setState({ busy });

let picker: HTMLInputElement | null = null;

/** Open the file picker for shapefiles and rasters; the Pixel Map imports them. */
export function pickMapLayerFiles(): void {
  picker ??= Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: SHAPE_ACCEPT });
  picker.value = '';
  picker.onchange = () => {
    if (picker?.files?.length) useMapImportQueue.setState({ files: Array.from(picker.files) });
  };
  picker.click();
}

async function readImportFiles(files: File[]): Promise<{ shapes: ShapefileParts[]; rasters: File[] }> {
  const parts: Array<{ path: string; data: ArrayBuffer }> = [];
  const rasters: File[] = [];
  for (const f of files) {
    if (isZipPath(f.name)) {
      for (const m of await listZip(f)) {
        if (m.path.includes('__MACOSX/')) continue;
        const name = m.path.split('/').pop() ?? m.path;
        if (SHAPE_PART.test(name)) {
          parts.push({ path: m.path, data: await new Response(await openZipMember(f, m)).arrayBuffer() });
        } else if (RASTER.test(name)) {
          rasters.push(new File([await new Response(await openZipMember(f, m)).blob()], name));
        }
      }
    } else if (SHAPE_PART.test(f.name)) {
      parts.push({ path: f.name, data: await f.arrayBuffer() });
    } else if (RASTER.test(f.name)) {
      rasters.push(f);
    }
  }
  return { shapes: groupShapefileParts(parts).filter((l) => l.shp), rasters };
}

/* --------------------------------------------------------------- import */

interface PendingShapes {
  layers: ShapefileParts[];
  summaries: ShapeLayerSummary[];
}

/**
 * Imports queued files into the active site: shapefiles become regions (after
 * the layer dialog this returns), rasters become the overlay.
 */
export function useMapLayerImport(geometry: PixelGeometry | null) {
  const site = useActiveSite();
  const toast = useAppStore((s) => s.toast);
  const addRegions = useAppStore((s) => s.addRegions);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const [pending, setPending] = useState<PendingShapes | null>(null);
  const queued = useMapImportQueue((s) => s.files);
  const catalog = useAppStore((s) => s.catalog);
  const catalogIndex = useAppStore((s) => s.catalogIndex);
  const loadedSites = useAppStore((s) => s.siteOrder);
  /** The files of the last import, to re-run it on another site. */
  const lastFiles = useRef<File[]>([]);

  const fail = useCallback(
    (title: string, err: unknown) => toast({ kind: 'error', title, detail: err instanceof Error ? err.message : String(err) }),
    [toast],
  );

  const importRaster = useCallback(
    async (file: File) => {
      setBusy(`Reading ${file.name}`);
      try {
        const data = await readRasterOverlay(file);
        setOverlay({ file, data, visible: true, opacity: 0.75, ramp: 'viridis', range: null });
        const pixels = geometry ? overlapCount(geometry, data.bboxWgs84) : 0;
        toast({
          kind: pixels > 0 ? 'success' : 'warning',
          title: `${file.name} overlaid`,
          detail:
            pixels > 0
              ? `${data.format} · ${data.variable} · ${data.width}×${data.height} cells · ${data.crsName ?? 'CRS unknown'}`
              : `It does not cover any of this site's pixels (${data.crsName ?? 'CRS unknown'}). Check that it is the right area.`,
        });
      } catch (err) {
        fail(`${file.name} could not be overlaid`, err);
      } finally {
        setBusy(null);
      }
    },
    [geometry, setOverlay, toast, fail],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!geometry) {
        toast({ kind: 'error', title: 'No pixel map', detail: 'This site has no pixel geometry to match layers against.' });
        return;
      }
      lastFiles.current = files;
      setBusy('Reading files');
      let read: Awaited<ReturnType<typeof readImportFiles>>;
      try {
        read = await readImportFiles(files);
      } catch (err) {
        setBusy(null);
        fail('Those files could not be read', err);
        return;
      }
      setBusy(null);
      if (read.shapes.length === 0 && read.rasters.length === 0) {
        toast({
          kind: 'error',
          title: 'Nothing to import',
          detail: 'Choose a shapefile (.shp with its .dbf, .shx and .prj, or a .zip of them), a GeoTIFF or a NetCDF.',
        });
        return;
      }
      if (read.rasters.length) await importRaster(read.rasters[0]);
      if (read.shapes.length) setPending({ layers: read.shapes, summaries: summarizeLayers(read.shapes) });
    },
    [geometry, importRaster, toast, fail],
  );

  useEffect(() => {
    if (!queued || !geometry) return;
    useMapImportQueue.setState({ files: null });
    void handleFiles(queued);
  }, [queued, geometry, handleFiles]);

  const runShapes = useCallback(
    async (layerName: string, groupBy: string | null) => {
      const layer = pending?.layers.find((l) => l.name === layerName);
      if (!layer || !geometry || !site) return;
      setPending(null);
      setBusy(`Matching ${layer.name} to pixels`);
      try {
        const out = await extractShapes(geometry, layer);
        if (out.features.length === 0) {
          // Usually the layer is for another place: say where, and which sites it does cover.
          const siteId = site.manifest.siteId;
          const box = out.layerBboxWgs84;
          let cLon = 0;
          let cLat = 0;
          for (let i = 0; i < geometry.lon.length; i++) {
            cLon += geometry.lon[i];
            cLat += geometry.lat[i];
          }
          const here: [number, number] = [cLon / geometry.lon.length, cLat / geometry.lon.length];
          const km = kmToBox(here, box);
          const inside = catalog.filter(
            (c) => c.lon !== undefined && c.lat !== undefined && kmToBox([c.lon, c.lat], box) === 0,
          );
          const loaded = inside.find((c) => loadedSites.includes(c.site_id) && c.site_id !== siteId);
          const country = catalogIndex.get(siteId)?.country;
          const nwi = isNwiLayer(out.fields);
          const files = lastFiles.current;
          toast({
            kind: 'warning',
            title: `${layer.name} does not reach ${siteId}`,
            detail: [
              km > 0
                ? `The layer covers ${formatBox(box)}, about ${formatCount(Math.round(km))} km from ${siteId}.`
                : `The layer's extent includes ${siteId}, but none of its ${formatCount(out.totalFeatures)} polygons holds a pixel centre (a gap between polygons).`,
              km > 0 && inside.length
                ? `WetLSP sites inside it: ${inside.slice(0, 4).map((c) => c.site_id).join(', ')}${inside.length > 4 ? ` and ${inside.length - 4} more` : ''}.`
                : '',
              nwi && country && country !== 'United States'
                ? `The National Wetlands Inventory maps the United States only, so it has no layer for ${siteId} (${country}).`
                : nwi && km > 0
                  ? `Download the NWI layer for ${siteId}'s watershed from fws.gov/wetlands/data.`
                  : '',
            ]
              .filter(Boolean)
              .join(' '),
            ttl: 0,
            action: loaded
              ? {
                  label: `Open ${loaded.site_id} and import there`,
                  run: () => {
                    void useAppStore.getState().selectSite(loaded.site_id);
                    useMapImportQueue.setState({ files });
                  },
                }
              : undefined,
          });
          return;
        }
        const drafts = regionDrafts(out, groupBy);
        const enabled = addRegions(
          drafts.map((d) => ({
            name: d.name,
            description: d.description,
            source: `${layer.name}.shp`,
            attributes: d.attributes,
            polygons: d.polygons,
            pool: d.pixelIds,
          })),
        );
        const total = geometry.pixelId.length;
        toast({
          kind: 'success',
          title: `${drafts.length} region${drafts.length === 1 ? '' : 's'} from ${layer.name}`,
          detail:
            `${formatCount(out.features.length)} of ${formatCount(out.totalFeatures)} polygons hold pixels; ` +
            `${formatCount(out.pixelsCovered)} of ${formatCount(total)} pixels are inside one.` +
            (enabled < drafts.length ? ` The ${enabled} largest are switched on for comparison.` : '') +
            (out.assumedWgs84 ? ' No .prj was given, so WGS 84 degrees were assumed.' : ''),
          ttl: 10000,
        });
      } catch (err) {
        fail(`${layer.name} could not be imported`, err);
      } finally {
        setBusy(null);
      }
    },
    [pending, geometry, site, addRegions, toast, fail, catalog, catalogIndex, loadedSites],
  );

  return pending ? (
    <ShapeImportDialog pending={pending} onCancel={() => setPending(null)} onImport={runShapes} />
  ) : null;
}

/** How many site pixels fall inside a lon/lat box. */
function overlapCount(g: PixelGeometry, [w, s, e, n]: [number, number, number, number]): number {
  let k = 0;
  for (let i = 0; i < g.lon.length; i++) if (g.lon[i] >= w && g.lon[i] <= e && g.lat[i] >= s && g.lat[i] <= n) k++;
  return k;
}

function ShapeImportDialog({
  pending,
  onCancel,
  onImport,
}: {
  pending: PendingShapes;
  onCancel: () => void;
  onImport: (layer: string, groupBy: string | null) => void;
}) {
  const usable = pending.summaries.filter((s) => s.polygons);
  // NWI downloads hold several layers; the wetland polygons are the useful one.
  const preferred = usable.find((s) => /wetland/i.test(s.name)) ?? usable[0];
  const [layer, setLayer] = useState(preferred?.name ?? '');
  const [groupBy, setGroupBy] = useState('');
  const chosen = pending.summaries.find((s) => s.name === layer);

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/25 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Import shapefile regions"
        className="w-[min(440px,100%)] rounded-[14px] border border-[var(--border)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold">Import regions from a shapefile</h3>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              Each polygon that holds pixel centres becomes a region you can compare in Time Series.
            </p>
          </div>
          <button aria-label="Cancel" onClick={onCancel} className="text-[var(--text-muted)] hover:text-[var(--text)]">
            <X size={16} />
          </button>
        </div>

        <Field label="Layer">
          <div className="space-y-1">
            {pending.summaries.map((s) => (
              <label
                key={s.name}
                className={`flex cursor-pointer items-start gap-2 rounded-[9px] px-2 py-1.5 text-[12.5px] ${s.polygons ? 'hover:bg-[var(--bg-hover)]' : 'opacity-50'}`}
              >
                <input
                  type="radio"
                  name="shape-layer"
                  className="mt-0.5 accent-[var(--accent)]"
                  disabled={!s.polygons}
                  checked={layer === s.name}
                  onChange={() => {
                    setLayer(s.name);
                    setGroupBy('');
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    {s.shapeType}
                    {s.features !== null ? ` · ${formatCount(s.features)} feature${s.features === 1 ? '' : 's'}` : ''}
                    {s.crsName ? ` · ${s.crsName}` : ''}
                    {s.missing.length ? ` · missing .${s.missing.join(', .')}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        {chosen && chosen.fields.length > 0 && (
          <Field label="Regions" htmlFor="shape-group">
            <Select id="shape-group" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">One per polygon</option>
              {chosen.fields.map((f) => (
                <option key={f} value={f}>
                  One per value of {f}
                </option>
              ))}
            </Select>
            <p className="pt-1 text-[11px] leading-snug text-[var(--text-faint)]">
              {chosen.fields.includes('ATTRIBUTE')
                ? 'For NWI layers, "ATTRIBUTE" pools every polygon with the same wetland code (e.g. PEM1Cm).'
                : 'Pooling merges every polygon with the same value into one region.'}
            </p>
          </Field>
        )}

        {chosen?.missing.includes('prj') && (
          <p className="mt-2 rounded-[9px] bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
            No .prj file: the layer can only be placed if its coordinates are WGS 84 degrees.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!chosen?.polygons} onClick={() => onImport(layer, groupBy || null)}>
            Import regions
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- map layers */

/** Region outlines, their plotted pixels and labels. */
export function regionLayers(regions: Region[], geometry: PixelGeometry, dark: boolean): Layer[] {
  if (regions.length === 0) return [];
  const shown = regions.filter((r) => r.enabled);
  const rows = regions.flatMap((r) => r.polygons.map((polygon) => ({ polygon, region: r })));

  // Sampled pixels of the enabled regions, coloured by region.
  let count = 0;
  for (const r of shown) count += r.sample.length;
  const positions = new Float64Array(count * 2);
  const colors = new Uint8Array(count * 3);
  let k = 0;
  for (const r of shown) {
    const [cr, cg, cb] = hexToRgb(r.color);
    for (const id of r.sample) {
      const i = pixelIndex(geometry.pixelId, id);
      if (i < 0) continue;
      positions[k * 2] = geometry.lon[i];
      positions[k * 2 + 1] = geometry.lat[i];
      colors[k * 3] = cr;
      colors[k * 3 + 1] = cg;
      colors[k * 3 + 2] = cb;
      k++;
    }
  }

  return [
    new PolygonLayer({
      id: 'region-polygons',
      data: rows,
      getPolygon: (d: (typeof rows)[number]) => d.polygon,
      getFillColor: (d: (typeof rows)[number]) => [...hexToRgb(d.region.color), d.region.enabled ? 34 : 10] as [number, number, number, number],
      getLineColor: (d: (typeof rows)[number]) => [...hexToRgb(d.region.color), d.region.enabled ? 235 : 90] as [number, number, number, number],
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: true,
      updateTriggers: { getFillColor: regions.map((r) => r.enabled), getLineColor: regions.map((r) => r.enabled) },
    }),
    new ScatterplotLayer({
      id: 'region-pixels',
      data: {
        length: k,
        attributes: {
          getPosition: { value: positions.subarray(0, k * 2), size: 2 },
          getFillColor: { value: colors.subarray(0, k * 3), size: 3, normalized: true },
        },
      },
      getRadius: 2.2,
      radiusUnits: 'meters',
      radiusMinPixels: 2,
      radiusMaxPixels: 9,
      stroked: true,
      getLineColor: dark ? [11, 15, 20, 200] : [255, 255, 255, 210],
      lineWidthUnits: 'pixels',
      getLineWidth: 0.6,
      pickable: false,
    }),
    new TextLayer({
      id: 'region-labels',
      data: shown,
      getPosition: (r: Region) => labelPoint(r, geometry),
      getText: (r: Region) => r.name,
      getSize: 12,
      getColor: (r: Region) => [...hexToRgb(r.color), 255] as [number, number, number, number],
      // The app's own face; deck's default is a monospace stack.
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 600,
      outlineWidth: 3,
      outlineColor: dark ? [11, 15, 20, 230] : [255, 255, 255, 235],
      fontSettings: { sdf: true },
      characterSet: 'auto',
      pickable: false,
    }),
  ];
}

/** Label at the mean of the region's plotted pixels, so it sits on the site. */
function labelPoint(r: Region, g: PixelGeometry): [number, number] {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of r.sample) {
    const i = pixelIndex(g.pixelId, id);
    if (i < 0) continue;
    x += g.lon[i];
    y += g.lat[i];
    n++;
  }
  return n ? [x / n, y / n] : (r.polygons[0]?.[0]?.[0] as [number, number]) ?? [0, 0];
}

/** The raster overlay as a bitmap pinned at its four corners. */
export function useOverlayLayer(): Layer | null {
  const overlay = useOverlay();
  const image = useMemo(() => {
    if (!overlay) return null;
    const { data, ramp, range } = overlay;
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rgba = colorize(data.values, OVERLAY_RAMPS[ramp], range ?? [data.p2, data.p98]);
    ctx.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, data.width, data.height), 0, 0);
    return canvas;
    // Re-colour only when the data, ramp or range change, not on opacity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay?.data, overlay?.ramp, overlay?.range]);

  return useMemo(() => {
    if (!overlay || !image || !overlay.visible) return null;
    return new BitmapLayer({
      id: 'raster-overlay',
      image,
      bounds: overlay.data.corners as [[number, number], [number, number], [number, number], [number, number]],
      opacity: overlay.opacity,
      pickable: true,
      textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
    });
  }, [overlay, image]);
}

/** Tooltip text for the overlay or a region polygon, or null for other layers. */
export function layerTooltip(info: PickingInfo, overlay: ReturnType<typeof useOverlay>): string | null {
  if (info.layer?.id === 'raster-overlay' && overlay) {
    const px = (info as unknown as { bitmap?: { pixel: [number, number] } }).bitmap?.pixel;
    if (!px) return null;
    const [col, row] = px.map(Math.floor);
    const { data } = overlay;
    if (col < 0 || row < 0 || col >= data.width || row >= data.height) return null;
    const v = data.values[row * data.width + col];
    return `<b>${data.variable}</b>${data.units ? ` (${data.units})` : ''}<br/>${Number.isFinite(v) ? formatValue(v, 4) : 'no data'}`;
  }
  if (info.layer?.id === 'region-polygons' && info.object) {
    const r = (info.object as { region: Region }).region;
    return [
      `<b>${r.name}</b>`,
      r.description,
      `${formatCount(r.pool.length)} pixels${r.sample.length < r.pool.length ? ` · ${formatCount(r.sample.length)} sampled` : ''}`,
    ]
      .filter(Boolean)
      .join('<br/>');
  }
  return null;
}

/* ------------------------------------------------------------ inspector */

export function RegionsCard() {
  const busy = useMapImportQueue((s) => s.busy);
  const site = useActiveSite();
  const regions = useRegions();
  const cap = useAppStore((s) => s.selectionCap);
  const update = useAppStore((s) => s.updateTimeseries);
  const setView = useAppStore((s) => s.setView);
  const { toggleRegion, removeRegion, clearRegions, renameRegion, redrawRegionSamples } = useAppStore.getState();
  const enabled = regions.filter((r) => r.enabled);
  const sampled = regions.some((r) => r.pool.length > cap);
  const siteId = site?.manifest.siteId ?? 'site';

  const exportMembership = () => {
    const g = site?.geometry;
    if (!g) return;
    const rows: unknown[][] = [];
    for (const r of regions) {
      const sample = new Set(r.sample);
      for (const id of r.pool) {
        const i = pixelIndex(g.pixelId, id);
        rows.push([r.id, r.name, r.source, id, sample.has(id) ? 1 : 0, i < 0 ? '' : g.lon[i], i < 0 ? '' : g.lat[i], i < 0 ? '' : g.x[i], i < 0 ? '' : g.y[i]]);
      }
    }
    downloadCsv(timestampedName([siteId, 'region-pixels'], 'csv'), ['region_id', 'region_name', 'source', 'pixel_id', 'in_plotted_sample', 'lon', 'lat', 'x', 'y'], rows);
  };

  return (
    <Card
      title="Regions"
      subtitle={regions.length ? `${regions.length} region${regions.length === 1 ? '' : 's'} · ${enabled.length} compared` : 'Compare areas side by side'}
      actions={
        regions.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={clearRegions}>
            Clear
          </Button>
        ) : null
      }
    >
      <div className="space-y-2.5">
        {regions.length === 0 && (
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">
            Switch shapes to <b>Add region</b> on the map toolbar and drag boxes or lassos, or import a shapefile such as an NWI wetlands layer.
          </p>
        )}
        {regions.length > 0 && (
          <ul className="max-h-[260px] space-y-1 overflow-y-auto pr-0.5">
            {regions.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-[9px] px-1.5 py-1 hover:bg-[var(--bg-hover)]">
                <button
                  aria-label={r.enabled ? `Leave ${r.name} out of the comparison` : `Compare ${r.name}`}
                  title={r.enabled ? 'Compared · click to leave out' : 'Left out · click to compare'}
                  onClick={() => toggleRegion(r.id)}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border"
                  style={{ borderColor: r.color, background: r.enabled ? r.color : 'transparent' }}
                >
                  {r.enabled ? <Eye size={11} color="#fff" /> : <EyeOff size={11} color={r.color} />}
                </button>
                <span className="min-w-0 flex-1">
                  <input
                    defaultValue={r.name}
                    aria-label="Region name"
                    onBlur={(e) => renameRegion(r.id, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className="w-full truncate bg-transparent text-[12.5px] font-medium outline-none focus:underline"
                  />
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">
                    {formatCount(r.pool.length)} px{r.sample.length < r.pool.length ? ` · ${formatCount(r.sample.length)} sampled` : ''}
                    {r.description ? ` · ${r.description}` : ''}
                  </span>
                </span>
                <button
                  aria-label={`Delete ${r.name}`}
                  onClick={() => removeRegion(r.id)}
                  className="shrink-0 text-[var(--text-faint)] hover:text-red-500"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {regions.length > MAX_COMPARED_REGIONS && (
          <p className="text-[11px] text-[var(--text-faint)]">Up to {MAX_COMPARED_REGIONS} regions can be compared at once.</p>
        )}
        {sampled && (
          <div className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--bg-sunken)] px-2.5 py-2">
            <span className="text-[11.5px] leading-snug text-[var(--text-muted)]">
              Regions over {formatCount(cap)} pixels plot a random {formatCount(cap)} (sample size above).
            </span>
            <Button size="sm" icon={<Shuffle size={13} />} onClick={redrawRegionSamples}>
              Redraw
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" icon={<Upload size={13} />} onClick={pickMapLayerFiles} disabled={Boolean(busy)}>
            {busy ? 'Working…' : 'Import shapefile'}
          </Button>
          <Button
            size="sm"
            variant={enabled.length ? 'primary' : 'secondary'}
            icon={<LineChart size={13} />}
            disabled={enabled.length === 0 || !site?.manifest.timeseries}
            onClick={() => {
              update({ compareRegions: true, useSelection: false, chart: 'line' });
              setView('timeseries');
            }}
          >
            Compare
          </Button>
        </div>
        {regions.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
            <button
              className="text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
              onClick={() =>
                downloadBlob(
                  new Blob(
                    [regionsToGeoJson(regions.map((r) => ({ ...r, pixelCount: r.pool.length })), siteId)],
                    { type: 'application/geo+json' },
                  ),
                  timestampedName([siteId, 'regions'], 'geojson'),
                )
              }
            >
              <Download size={11} className="mr-0.5 inline" />
              Regions (GeoJSON)
            </button>
            <button className="text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]" onClick={exportMembership}>
              <Download size={11} className="mr-0.5 inline" />
              Pixels per region (CSV)
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function OverlayCard() {
  const busy = useMapImportQueue((s) => s.busy);
  const onImport = pickMapLayerFiles;
  const overlay = useOverlay();
  const { updateOverlay, setOverlay, toast } = useAppStore.getState();
  const [switching, setSwitching] = useState(false);

  if (!overlay) {
    return (
      <Card title="Raster overlay" subtitle="GeoTIFF or NetCDF">
        <p className="mb-2 text-[12px] leading-snug text-[var(--text-muted)]">
          Lay a land-cover, elevation or flooding grid under the pixels. The file is read on this computer and not stored.
        </p>
        <Button size="sm" className="w-full" icon={<Layers size={13} />} onClick={onImport} disabled={Boolean(busy)}>
          Import raster
        </Button>
      </Card>
    );
  }

  const { data } = overlay;
  const range = overlay.range ?? [data.p2, data.p98];
  const switchTo = async (choice: string) => {
    setSwitching(true);
    try {
      const next = await readRasterOverlay(overlay.file, { choice });
      updateOverlay({ data: next, range: null });
    } catch (err) {
      toast({ kind: 'error', title: `${choice} could not be read`, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Card
      title="Raster overlay"
      subtitle={data.name}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            aria-label={overlay.visible ? 'Hide overlay' : 'Show overlay'}
            onClick={() => updateOverlay({ visible: !overlay.visible })}
          >
            {overlay.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </Button>
          <Button size="sm" variant="ghost" aria-label="Remove overlay" onClick={() => setOverlay(null)}>
            <X size={13} />
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {data.choices.length > 1 && (
          <Field label={data.format === 'NetCDF' ? 'Variable' : 'Band'} htmlFor="overlay-choice">
            <Select id="overlay-choice" value={data.variable} disabled={switching} onChange={(e) => void switchTo(e.target.value)}>
              {data.choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Opacity" hint={`${Math.round(overlay.opacity * 100)}%`}>
          <Slider min={0} max={1} step={0.05} value={overlay.opacity} onChange={(v) => updateOverlay({ opacity: v })} />
        </Field>
        <Field label="Colours" htmlFor="overlay-ramp">
          <Select id="overlay-ramp" value={overlay.ramp} onChange={(e) => updateOverlay({ ramp: e.target.value as OverlayRamp })}>
            <option value="viridis">Viridis</option>
            <option value="greens">Greens</option>
            <option value="rainbow">Rainbow (timing)</option>
            <option value="greys">Greys</option>
          </Select>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums text-[var(--text-muted)]">
            <span>{formatValue(range[0], 3)}</span>
            <span className="h-2 flex-1 rounded-full" style={{ background: rampToCssGradient(OVERLAY_RAMPS[overlay.ramp]) }} />
            <span>{formatValue(range[1], 3)}</span>
          </div>
          <div className="mt-1 flex gap-3 text-[11px]">
            <button
              className={overlay.range ? 'text-[var(--text-muted)] underline underline-offset-2' : 'font-medium text-[var(--accent)]'}
              onClick={() => updateOverlay({ range: null })}
            >
              2–98th percentile
            </button>
            <button
              className={overlay.range ? 'font-medium text-[var(--accent)]' : 'text-[var(--text-muted)] underline underline-offset-2'}
              onClick={() => updateOverlay({ range: [data.min, data.max] })}
            >
              Full range
            </button>
          </div>
        </Field>
        <dl className="space-y-0.5 text-[11.5px] text-[var(--text-muted)]">
          <div>
            {data.format} · {formatCount(data.sourceWidth)}×{formatCount(data.sourceHeight)} cells
            {data.units ? ` · ${data.units}` : ''}
          </div>
          <div>{data.crsName ?? 'CRS unknown'}{data.epsg ? ` (EPSG:${data.epsg})` : ''}</div>
          <div title="The grid is drawn by its four corners. This is the largest gap between that and exact reprojection, at the edge midpoints and centre.">
            Placement within {data.placementErrorM < 1 ? '1 m' : `${formatValue(data.placementErrorM, 2)} m`} of exact reprojection
          </div>
          {data.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </dl>
        <Button size="sm" variant="ghost" className="w-full" icon={<Layers size={13} />} onClick={onImport} disabled={Boolean(busy)}>
          Replace raster
        </Button>
      </div>
    </Card>
  );
}
