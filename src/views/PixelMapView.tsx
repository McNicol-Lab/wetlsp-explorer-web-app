/**
 * Pixel Map: every pixel of the site on a basemap, with click / rectangle /
 * lasso selection, and a hexbin skyline as the 3D mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { HexagonLayer } from '@deck.gl/aggregation-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  Crosshair, Eraser, LassoSelect, MapPin, MousePointer2, Send, Shuffle, Square,
} from 'lucide-react';
import { MapCanvas, type MapCanvasHandle } from '@/components/MapCanvas';
import { Button, Card, Chip, EmptyState, Field, Segmented, Slider } from '@/components/ui';
import { Sparkline } from '@/components/Sparkline';
import { useActiveSite, useAppStore } from '@/store/useAppStore';
import { ErrorPanel, seriesColor, useAsyncData, useBasemap, useDark } from './shared';
import { getPixelMeans, getPixelTrace, pixelsInPolygon } from '@/engine/queries';
import { nearestPixelIndex } from '@/lib/pixelPicking';
import { pixelIndex } from '@/lib/pixelIndex';
import { GREENNESS_RAMP, sampleRamp } from '@/lib/colorscales';
import { compositeCanvas, downloadBlob, downloadCsv, exportBackground, timestampedName } from '@/lib/export';
import { canvasToBlob, copyImage } from '@/lib/figure';
import { FigureMenu } from '@/components/FigureMenu';
import { formatCount, formatValue, isoFromMs } from '@/lib/format';
import { MAX_PIXEL_SAMPLE } from '@/engine/sql';
import type { PixelGeometry } from '@/lib/types';

type Tool = 'point' | 'rect' | 'lasso';

export function PixelMapView() {
  const site = useActiveSite();
  const dark = useDark();
  const basemap = useBasemap();
  const mapRef = useRef<MapCanvasHandle>(null);
  const [tool, setTool] = useState<Tool>('point');
  const [mode3d, setMode3d] = useState(false);
  const [colorByEvi, setColorByEvi] = useState(false);
  const [hexRadius, setHexRadius] = useState(24);
  const [map, setMap] = useState<MapLibreMap | null>(null);

  const selection = useAppStore((s) => s.selection);
  const plotted = useAppStore((s) => s.plottedPixels);
  const canRedraw = useAppStore((s) => (s.selectionPool?.length ?? 0) > s.selectionCap);
  const togglePixel = useAppStore((s) => s.togglePixel);
  const selectShape = useAppStore((s) => s.selectShape);
  const setFocusedPixel = useAppStore((s) => s.setFocusedPixel);
  const ts = useAppStore((s) => s.timeseries);
  const toast = useAppStore((s) => s.toast);

  const geometry = site?.geometry ?? null;

  const means = useAsyncData<Map<number, number>>(
    async ({ signal, onProgress }) => {
      if (!site?.manifest || ts.year === null) return new Map();
      return getPixelMeans(site.manifest, [ts.year], ts.series.slice(0, 1), { signal, onProgress });
    },
    [site?.manifest.siteId, ts.year, ts.series[0]],
    { enabled: colorByEvi && Boolean(site?.manifest.timeseries) && ts.year !== null },
  );

  const positions = useMemo(() => packPositions(geometry), [geometry]);
  const bounds = useMemo(() => boundsOf(geometry), [geometry]);
  const siteSpanMeters = useMemo(() => {
    if (!bounds) return 500;
    const [w, s, e, n] = bounds;
    const midLat = ((s + n) / 2) * (Math.PI / 180);
    return Math.max(100, (n - s) * 111_320, (e - w) * 111_320 * Math.cos(midLat));
  }, [bounds]);
  const subset = useCallback(
    (ids: number[]): Float64Array => {
      if (!geometry) return new Float64Array(0);
      const out = new Float64Array(ids.length * 2);
      let k = 0;
      for (const id of ids) {
        const i = pixelIndex(geometry.pixelId, id);
        if (i < 0) continue;
        out[k++] = geometry.lon[i];
        out[k++] = geometry.lat[i];
      }
      return out.subarray(0, k);
    },
    [geometry],
  );

  const meanRange = useMemo(() => {
    const m = means.data;
    if (!m || m.size === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of m.values()) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi] as [number, number];
  }, [means.data]);

  const layers = useMemo<Layer[]>(() => {
    if (!geometry || positions.length === 0) return [];
    const n = geometry.pixelId.length;
    const accent: [number, number, number] = dark ? [45, 212, 191] : [15, 118, 110];
    const secondary: [number, number, number] = dark ? [251, 146, 60] : [234, 88, 12];

    if (mode3d) {
      // Packed attributes, not one object per pixel: GF-Guy has 1.3 M pixels.
      const evi = meanRange ? new Float32Array(n) : null;
      if (evi) for (let i = 0; i < n; i++) evi[i] = means.data?.get(geometry.pixelId[i]) ?? 0;
      return [
        new HexagonLayer({
          id: 'hex',
          // Aggregation layers read positions through the accessor, not a
          // binary attribute; `target` is deck's reusable scratch array.
          data: { length: n },
          getPosition: (_: unknown, { index, target }: { index: number; target: number[] }) => {
            target[0] = geometry.lon[index];
            target[1] = geometry.lat[index];
            return target as [number, number];
          },
          radius: hexRadius,
          extruded: true,
          // Tallest column about a third of the site's width: the default
          // 0–1000 m range made kilometre towers over a 400 m site.
          elevationRange: [0, siteSpanMeters * 0.35],
          elevationScale: 1,
          coverage: 0.92,
          pickable: true,
          colorRange: GREENNESS_RAMP.slice(2).map((h) => hexToTuple(h)),
          material: { ambient: 0.55, diffuse: 0.6, shininess: 40, specularColor: [255, 255, 255] },
          getColorWeight: (_: unknown, { index }: { index: number }) => (evi ? evi[index] : 1),
          colorAggregation: meanRange ? 'MEAN' : 'SUM',
          getElevationWeight: () => 1,
          elevationAggregation: 'SUM',
        }),
      ];
    }

    const baseColors = (() => {
      if (!colorByEvi || !means.data || !meanRange) return null;
      const arr = new Uint8Array(n * 3);
      const [lo, hi] = meanRange;
      const span = hi - lo || 1;
      for (let i = 0; i < n; i++) {
        const v = means.data.get(geometry.pixelId[i]);
        const c =
          v === undefined ? [140, 148, 160] : sampleRamp(GREENNESS_RAMP, (v - lo) / span);
        arr[i * 3] = c[0];
        arr[i * 3 + 1] = c[1];
        arr[i * 3 + 2] = c[2];
      }
      return arr;
    })();

    const out: Layer[] = [
      new ScatterplotLayer({
        id: 'all-pixels',
        data: {
          length: n,
          attributes: {
            getPosition: { value: positions, size: 2 },
            ...(baseColors ? { getFillColor: { value: baseColors, size: 3 } } : {}),
          },
        },
        getFillColor: baseColors ? undefined : dark ? [150, 162, 178, 175] : [96, 108, 126, 165],
        getRadius: 1.6,
        radiusUnits: 'meters',
        radiusMinPixels: 2.2,
        radiusMaxPixels: 9,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 200],
      }),
    ];

    if (plotted.length > 0) {
      out.push(
        new ScatterplotLayer({
          id: 'plotted-pixels',
          data: {
            length: plotted.length,
            attributes: { getPosition: { value: subset(plotted), size: 2 } },
          },
          getFillColor: [...secondary, 210] as [number, number, number, number],
          getRadius: 2.2,
          radiusUnits: 'meters',
          radiusMinPixels: 2.2,
          radiusMaxPixels: 11,
          pickable: false,
        }),
      );
    }

    if (selection.length > 0) {
      out.push(
        new ScatterplotLayer({
          id: 'selected-pixels',
          data: {
            length: selection.length,
            attributes: { getPosition: { value: subset(selection), size: 2 } },
          },
          getFillColor: [...accent, 245] as [number, number, number, number],
          getLineColor: [255, 255, 255, 220],
          lineWidthUnits: 'pixels',
          getLineWidth: 0.8,
          stroked: true,
          getRadius: 3,
          radiusUnits: 'meters',
          radiusMinPixels: 3,
          radiusMaxPixels: 14,
          pickable: false,
        }),
      );
    }

    return out;
  }, [geometry, positions, selection, plotted, dark, mode3d, hexRadius, colorByEvi, means.data, meanRange, subset, siteSpanMeters]);

  const onPick = useCallback(
    (info: PickingInfo) => {
      if (tool !== 'point' || !geometry || mode3d) return;
      const map = mapRef.current?.map();
      // Some interleaved GPU backends draw binary scatter attributes correctly
      // but return an empty picking buffer. Fall back to the same map transform
      // and five-pixel tolerance, retaining the geometry index as the join key.
      const index = info.layer?.id === 'all-pixels' && info.index >= 0
        ? info.index
        : map ? nearestPixelIndex(geometry, [info.x, info.y], map) : -1;
      if (index < 0 || index >= geometry.pixelId.length) return;
      const id = geometry.pixelId[index];
      togglePixel(id);
      setFocusedPixel(id);
    },
    [tool, geometry, mode3d, togglePixel, setFocusedPixel],
  );

  const finishShape = useCallback(
    async (ring: number[][]) => {
      if (!geometry || ring.length < 3) return;
      const flat = new Float64Array(ring.length * 2);
      ring.forEach((p, i) => {
        flat[i * 2] = p[0];
        flat[i * 2 + 1] = p[1];
      });
      try {
        const inside = await pixelsInPolygon(geometry, flat);
        if (inside.length === 0) {
          toast({
            kind: 'info',
            title: 'Nothing inside that shape',
            detail: 'No pixels fell within it. Try a larger area.',
          });
          return;
        }
        selectShape(inside);
      } catch (err) {
        toast({
          kind: 'error',
          title: 'Selection failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [geometry, selectShape, toast],
  );

  const mapImage = () => {
    mapRef.current?.repaint();
    const canvas = mapRef.current?.canvas();
    if (!canvas) throw new Error('The map is not ready yet.');
    return compositeCanvas([canvas], exportBackground());
  };
  const figureActions = {
    save: async () =>
      downloadBlob(
        await canvasToBlob(mapImage()),
        timestampedName([site?.manifest.siteId, mode3d ? 'hexbin' : 'pixels'], 'png'),
      ),
    copy: () => copyImage(canvasToBlob(mapImage())),
  };

  if (!site) {
    return (
      <div className="card h-full">
        <EmptyState icon={<MapPin size={26} />} title="No site open" body="Import a dataset first." />
      </div>
    );
  }
  if (!geometry) {
    return (
      <div className="card h-full">
        <ErrorPanel
          message={
            site.status === 'loading'
              ? 'Loading pixel geometry…'
              : (site.notes.find((n) => n.startsWith('Pixels cannot be placed')) ??
                site.notes.find((n) => /pixels_geom|CRS/.test(n)) ??
                site.notes.find((n) => n.includes('pixels_meta')) ??
                site.error ??
                'This site has no usable pixel geometry, so pixels cannot be placed on a map. The Time Series view still works.')
          }
          onRetry={
            site.manifest.geom && site.status !== 'loading'
              ? () => void useAppStore.getState().reloadSite(site.manifest.siteId)
              : undefined
          }
          retryLabel="Reload metadata"
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
      initialBounds={bounds}
      pitch={mode3d ? 50 : 0}
      onMapReady={setMap}
      onClick={onPick}
      getTooltip={(info) => {
        if (info.layer?.id === 'hex') {
          const count = (info.object as { count?: number } | undefined)?.count ?? 0;
          return `<b>${count} pixels</b>${
            meanRange ? `<br/>mean EVI ${formatValue((info.object as { colorValue?: number }).colorValue ?? NaN, 4)}` : ''
          }`;
        }
        if (info.layer?.id !== 'all-pixels' || info.index === undefined || info.index < 0) return null;
        const i = info.index;
        const mean = means.data?.get(geometry.pixelId[i]);
        return [
          `<b>pixel ${geometry.pixelId[i]}</b>`,
          `${geometry.lat[i].toFixed(5)}, ${geometry.lon[i].toFixed(5)}`,
          `x ${geometry.x[i].toFixed(1)} · y ${geometry.y[i].toFixed(1)} m`,
          mean !== undefined ? `mean EVI ${formatValue(mean, 4)}` : null,
        ]
          .filter(Boolean)
          .join('<br/>');
      }}
      className="relative h-full w-full card overflow-hidden"
    >
      <DrawOverlay tool={tool} map={map} onShape={finishShape} />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-[12px] border border-[var(--border)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-card)]">
          <ToolButton icon={MousePointer2} label="Click pixels" active={tool === 'point'} onClick={() => setTool('point')} />
          <ToolButton icon={Square} label="Rectangle" active={tool === 'rect'} onClick={() => setTool('rect')} />
          <ToolButton icon={LassoSelect} label="Lasso" active={tool === 'lasso'} onClick={() => setTool('lasso')} />
          <div className="mx-0.5 h-5 w-px bg-[var(--border)]" />
          {canRedraw && (
            <ToolButton
              icon={Shuffle}
              label="Redraw the random sample"
              onClick={() => useAppStore.getState().redrawSample()}
            />
          )}
          <ToolButton
            icon={Eraser}
            label="Clear selection"
            onClick={() => useAppStore.getState().clearSelection()}
          />
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          <Segmented
            size="sm"
            value={mode3d ? '3d' : '2d'}
            onChange={(v) => setMode3d(v === '3d')}
            options={[
              { value: '2d', label: 'Pixels' },
              { value: '3d', label: 'Skyline' },
            ]}
          />
          <Button
            size="sm"
            active={colorByEvi}
            onClick={() => setColorByEvi(!colorByEvi)}
            disabled={!site.manifest.timeseries || ts.year === null}
            title={
              site.manifest.timeseries
                ? `Colour pixels by their mean ${ts.series[0] ?? 'spline'} EVI in ${ts.year ?? '—'}`
                : 'This site has no time series to average'
            }
          >
            {means.loading ? 'Averaging…' : 'Mean EVI'}
          </Button>
          <FigureMenu actions={figureActions} />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-1.5">
        <Chip title="Every pixel in this site">
          <span className="h-2 w-2 rounded-full bg-[var(--text-faint)]" />
          {formatCount(geometry.pixelId.length)} pixels
        </Chip>
        {plotted.length > 0 && (
          <Chip title="Pixels currently in the EVI plot">
            <span className="h-2 w-2 rounded-full" style={{ background: seriesColor('raw', dark) }} />
            {formatCount(plotted.length)} plotted
          </Chip>
        )}
        {selection.length > 0 && (
          <Chip tone="accent">
            <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
            {formatCount(selection.length)} selected
          </Chip>
        )}
        {mode3d && <Chip>hex radius {hexRadius} m</Chip>}
      </div>

      {mode3d && (
        <div className="pointer-events-auto absolute right-3 top-[52px] z-10 w-[190px] rounded-[12px] border border-[var(--border)] bg-[var(--bg-elevated)] p-2.5 shadow-[var(--shadow-card)]">
          <Field label="Hex radius" hint={`${hexRadius} m`}>
            <Slider min={6} max={120} step={2} value={hexRadius} onChange={setHexRadius} />
          </Field>
        </div>
      )}
    </MapCanvas>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Square;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={
        active
          ? 'grid h-7 w-7 place-items-center rounded-[9px] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent)]'
          : 'grid h-7 w-7 place-items-center rounded-[9px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
      }
    >
      <Icon size={14} />
    </button>
  );
}

/* --------------------------------------------------------------- drawing */

/** Transparent capture layer for rectangle and lasso drawing. */
function DrawOverlay({
  tool,
  map,
  onShape,
}: {
  tool: Tool;
  map: MapLibreMap | null;
  onShape: (ring: number[][]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<number[][]>([]);
  const [screenPts, setScreenPts] = useState<number[][]>([]);

  useEffect(() => {
    if (tool === 'point') {
      screenRef.current = [];
      setScreenPts([]);
    }
  }, [tool]);

  if (tool === 'point' || !map) return null;

  const toLngLat = (pts: number[][]) =>
    pts.map((p) => {
      const ll = map.unproject([p[0], p[1]]);
      return [ll.lng, ll.lat];
    });

  const rectRing = (a: number[], b: number[]) => [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];

  const local = (e: React.PointerEvent) => {
    const r = hostRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    screenRef.current = [local(e)];
    setScreenPts([...screenRef.current]);
  };

  const onMove = (e: React.PointerEvent) => {
    if (screenRef.current.length === 0) return;
    const p = local(e);
    if (tool === 'rect') screenRef.current = [screenRef.current[0], p];
    else screenRef.current.push(p);
    setScreenPts([...screenRef.current]);
  };

  const onUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const pts = screenRef.current;
    screenRef.current = [];
    setScreenPts([]);
    if (pts.length < 2) return;
    const ring = tool === 'rect' ? rectRing(pts[0], pts[1]) : pts;
    if (ring.length < 3) return;
    onShape(toLngLat(ring));
  };

  const path =
    screenPts.length > 1
      ? (tool === 'rect' ? rectRing(screenPts[0], screenPts[1]) : screenPts)
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`)
          .join(' ') + ' Z'
      : '';

  return (
    <div
      ref={hostRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className="absolute inset-0 z-[5] cursor-crosshair touch-none"
      style={{ pointerEvents: 'auto' }}
    >
      {path && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <path
            d={path}
            fill="color-mix(in oklab, var(--accent) 16%, transparent)"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeDasharray={tool === 'lasso' ? '4 3' : undefined}
          />
        </svg>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

function packPositions(g: PixelGeometry | null): Float64Array {
  if (!g) return new Float64Array(0);
  const out = new Float64Array(g.pixelId.length * 2);
  for (let i = 0; i < g.pixelId.length; i++) {
    out[i * 2] = g.lon[i];
    out[i * 2 + 1] = g.lat[i];
  }
  return out;
}

function boundsOf(g: PixelGeometry | null): [number, number, number, number] | null {
  if (!g || g.lon.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let i = 0; i < g.lon.length; i++) {
    if (g.lon[i] < w) w = g.lon[i];
    if (g.lon[i] > e) e = g.lon[i];
    if (g.lat[i] < s) s = g.lat[i];
    if (g.lat[i] > n) n = g.lat[i];
  }
  const padX = (e - w) * 0.08 || 0.002;
  const padY = (n - s) * 0.08 || 0.002;
  return [w - padX, s - padY, e + padX, n + padY];
}

function hexToTuple(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/* ------------------------------------------------------------- inspector */

export function PixelMapInspector() {
  const site = useActiveSite();
  const dark = useDark();
  const selection = useAppStore((s) => s.selection);
  const selectionCap = useAppStore((s) => s.selectionCap);
  const setSelectionCap = useAppStore((s) => s.setSelectionCap);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const redrawSample = useAppStore((s) => s.redrawSample);
  const poolSize = useAppStore((s) => s.selectionPool?.length ?? 0);
  const focused = useAppStore((s) => s.focusedPixel);
  const ts = useAppStore((s) => s.timeseries);
  const update = useAppStore((s) => s.updateTimeseries);
  const setView = useAppStore((s) => s.setView);
  const [capDraft, setCapDraft] = useState<number | null>(null);

  const trace = useAsyncData(
    async ({ signal }) => {
      if (!site?.manifest || focused === null || ts.year === null) return null;
      return getPixelTrace(site.manifest, focused, [ts.year], ts.series, { signal });
    },
    [site?.manifest.siteId, focused, ts.year, ts.series.join(',')],
    { enabled: focused !== null && ts.year !== null && Boolean(site?.manifest.timeseries) },
  );

  if (!site?.geometry) {
    return <EmptyState compact title="No pixel geometry" body="Nothing to select here." />;
  }

  const cap = capDraft ?? selectionCap;

  return (
    <div className="space-y-3">
      <Card
        title="Selection"
        subtitle={
          selection.length
            ? `${formatCount(selection.length)} of ${formatCount(site.geometry.pixelId.length)} pixels`
            : 'Nothing selected'
        }
        actions={
          selection.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          ) : null
        }
      >
        <div className="space-y-3">
          <Field label="Sample size" hint={formatCount(cap)}>
            <Slider
              min={25}
              max={MAX_PIXEL_SAMPLE}
              step={25}
              value={cap}
              onChange={(v) => setCapDraft(v)}
            />
            <p className="pt-1 text-[11px] leading-snug text-[var(--text-faint)]">
              A rectangle or lasso around more pixels than this takes a random sample of them.
            </p>
            {capDraft !== null && capDraft !== selectionCap && (
              <Button
                size="sm"
                variant="primary"
                className="mt-1"
                onClick={() => {
                  setSelectionCap(capDraft);
                  setCapDraft(null);
                }}
              >
                {poolSize > 0 ? 'Resample the shape' : 'Apply'}
              </Button>
            )}
          </Field>

          {poolSize > selectionCap && (
            <div className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--bg-sunken)] px-2.5 py-2">
              <span className="text-[11.5px] leading-snug text-[var(--text-muted)]">
                Random {formatCount(selectionCap)} of the {formatCount(poolSize)} pixels in the shape
              </span>
              <Button size="sm" icon={<Shuffle size={13} />} onClick={redrawSample}>
                Redraw
              </Button>
            </div>
          )}

          <Button
            className="w-full"
            variant={selection.length ? 'primary' : 'secondary'}
            icon={<Send size={13} />}
            disabled={selection.length === 0}
            onClick={() => {
              update({ useSelection: true });
              setView('timeseries');
            }}
          >
            Plot these pixels
          </Button>

          {selection.length > 0 && (
            <button
              onClick={() =>
                downloadCsv(
                  timestampedName([site.manifest.siteId, 'selection'], 'csv'),
                  ['pixel_id', 'lon', 'lat', 'x', 'y'],
                  selection.map((id) => {
                    const i = pixelIndex(site.geometry!.pixelId, id);
                    return i < 0
                      ? [id, '', '', '', '']
                      : [
                          id,
                          site.geometry!.lon[i],
                          site.geometry!.lat[i],
                          site.geometry!.x[i],
                          site.geometry!.y[i],
                        ];
                  }),
                )
              }
              className="w-full text-[11.5px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
            >
              Export the selected pixel list as CSV
            </button>
          )}
        </div>
      </Card>

      <Card title={focused === null ? 'Pixel detail' : `Pixel ${focused}`}>
        {focused === null ? (
          <p className="text-[12.5px] leading-snug text-[var(--text-muted)]">
            Click a single pixel on the map to see where it sits and how its EVI moved through the
            year.
          </p>
        ) : (
          <div className="space-y-2">
            <PixelFacts geometry={site.geometry} pixelId={focused} />
            {trace.loading && <div className="skeleton h-[46px] w-full" />}
            {trace.data && trace.data.rows > 1 && (
              <>
                {trace.data.seriesNames.map((name, idx) => {
                  const xs: number[] = [];
                  const ys: number[] = [];
                  for (let i = 0; i < trace.data!.rows; i++) {
                    if (trace.data!.seriesIdx[i] !== idx) continue;
                    xs.push(trace.data!.time[i]);
                    ys.push(trace.data!.evi[i]);
                  }
                  return (
                    <div key={name}>
                      <div className="flex items-baseline justify-between text-[11px] text-[var(--text-muted)]">
                        <span>{name}</span>
                        <span className="tabular-nums">
                          {xs.length ? `${isoFromMs(xs[0])} → ${isoFromMs(xs[xs.length - 1])}` : ''}
                        </span>
                      </div>
                      <Sparkline x={xs} y={ys} color={seriesColor(name, dark)} />
                    </div>
                  );
                })}
              </>
            )}
            {trace.data && trace.data.rows <= 1 && !trace.loading && (
              <p className="text-[12px] text-[var(--text-muted)]">
                No {ts.series.join('/')} values for this pixel in {ts.year}.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Tools">
        <ul className="space-y-1.5 text-[12px] leading-snug text-[var(--text-muted)]">
          <li>
            <Crosshair size={11} className="mr-1 inline" /> Click toggles one pixel in and out.
          </li>
          <li>
            <Square size={11} className="mr-1 inline" /> Drag a rectangle to take everything inside,
            or a random sample when it holds more than the sample size.
          </li>
          <li>
            <LassoSelect size={11} className="mr-1 inline" /> Lasso for irregular shapes; release to
            apply.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function PixelFacts({ geometry, pixelId }: { geometry: PixelGeometry; pixelId: number }) {
  const i = pixelIndex(geometry.pixelId, pixelId);
  if (i < 0) return null;
  const rows: Array<[string, string]> = [
    ['Longitude', geometry.lon[i].toFixed(6)],
    ['Latitude', geometry.lat[i].toFixed(6)],
    ['Projected x', `${geometry.x[i].toFixed(1)} m`],
    ['Projected y', `${geometry.y[i].toFixed(1)} m`],
  ];
  if (geometry.cell[i] >= 0) rows.push(['Raster cell', String(geometry.cell[i])]);
  return (
    <dl className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className="text-[11.5px] text-[var(--text-muted)]">{k}</dt>
          <dd className="text-[12px] font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
