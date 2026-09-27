/**
 * EVI time series. The default is a line chart — the daily mean per series,
 * its interquartile band, and the season's key dates — with the per-pixel
 * "spaghetti" one toggle away. "Compare years" overlays every year's mean on
 * one calendar; "3D ribbon" shows the same rows as a surface.
 *
 * The aggregates come back from SQL already reduced to one row per date x
 * series, so the band costs the same whether it summarises 250 pixels or 5000.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { PlotData } from 'plotly.js-dist-min';
import { Boxes, FileImage, LineChart, Presentation, RefreshCw, Shuffle, Table } from 'lucide-react';
import {
  MODEBAR_BAND,
  PLOT_CONFIG,
  PlotlyChart,
  dataUrlToBlob,
  plotTheme,
  type ExportOptions,
  type PlotlyHandle,
} from '@/components/PlotlyChart';
import { Button, Card, Chip, EmptyState, Field, Segmented, Slider, Toggle } from '@/components/ui';
import { FigureMenu } from '@/components/FigureMenu';
import { useAppStore, useActiveSite, type TimeseriesChart } from '@/store/useAppStore';
import { ErrorPanel, LoadingPanel, seriesColor, useAsyncData, useDark } from './shared';
import {
  getDailySummary,
  getTimeseries,
  samplePixelIds,
  type TimeseriesBundle,
} from '@/engine/queries';
import { DEFAULT_PIXEL_SAMPLE, MAX_PIXEL_SAMPLE } from '@/engine/sql';
import { downloadBlob, downloadCsv, exportBackground, timestampedName } from '@/lib/export';
import { copyImage } from '@/lib/figure';
import { formatCount, isoFromMs } from '@/lib/format';
import { newSeed } from '@/lib/sampling';
import type { DailySummaryRow } from '@/lib/types';
import { pixelLines, type PixelLine } from './timeseriesPlot';
import { keyDates, type KeyDates } from './keyDates';

interface Loaded {
  bundle: TimeseriesBundle;
  summary: DailySummaryRow[];
  requestedPixels: number;
  availablePixels: number;
  usedSelection: boolean;
}

interface YearsLoaded {
  summary: DailySummaryRow[];
  years: number[];
  pixels: number;
  availablePixels: number;
  usedSelection: boolean;
}

/** Up to this many selected pixels are drawn as individual, labelled lines. */
const LABELLED_PIXEL_LIMIT = 12;

/** Distinguishable line colours for pixels and years (Okabe–Ito plus two). */
const LINE_PALETTE = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9', '#6b4c9a', '#8c6d31', '#333333', '#f0439a', '#1b9e77', '#7570b3'];
const LINE_PALETTE_DARK = ['#56b4e9', '#ff8c42', '#34d399', '#f0a3d0', '#fbbf24', '#93c5fd', '#b39ddb', '#d4b483', '#e5e7eb', '#f472b6', '#5eead4', '#a5b4fc'];

function lineColor(i: number, dark: boolean): string {
  const p = dark ? LINE_PALETTE_DARK : LINE_PALETTE;
  return p[i % p.length];
}

async function pixelIdsFor(
  manifest: NonNullable<ReturnType<typeof useActiveSite>>['manifest'],
  years: number[],
  series: string[],
  useSelection: boolean,
  selection: number[],
  maxPixels: number,
  seed: number,
  ctx: { signal: AbortSignal; onProgress: (p: import('@/lib/types').ProgressEvent) => void },
): Promise<{ ids: Int32Array; available: number }> {
  if (useSelection) {
    if (selection.length === 0) {
      throw new Error(
        'No pixels are selected. Draw a selection on the Pixel Map, or switch back to a random sample.',
      );
    }
    return { ids: Int32Array.from(selection), available: selection.length };
  }
  return samplePixelIds(manifest, years, series, maxPixels, { ...ctx, seed });
}

function useTimeseriesData() {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const selection = useAppStore((s) => s.selection);
  const setPlottedPixels = useAppStore((s) => s.setPlottedPixels);

  const manifest = site?.manifest ?? null;
  const year = ts.year;
  const seriesKey = ts.series.join(',');
  const selectionKey = ts.useSelection ? selection.join(',') : '';
  const rangeKey = ts.dateRange ? ts.dateRange.join('..') : '';

  const enabled = Boolean(
    manifest?.timeseries && year !== null && ts.series.length > 0 && ts.chart !== 'years',
  );

  return useAsyncData<Loaded>(
    async ({ signal, onProgress }) => {
      if (!manifest || year === null) throw new Error('No site selected.');
      const years = [year];
      const { ids: pixelIds, available } = await pixelIdsFor(
        manifest, years, ts.series, ts.useSelection, selection, ts.maxPixels, ts.sampleSeed, { signal, onProgress },
      );
      if (pixelIds.length === 0) {
        throw new Error(`No pixels carry ${ts.series.join(' or ')} data for ${year}.`);
      }

      const filters = { years, series: ts.series, pixelIds, dateRange: ts.dateRange };
      const [bundle, summary] = await Promise.all([
        getTimeseries(manifest, filters, { signal, onProgress }),
        getDailySummary(manifest, filters, { signal, onProgress }),
      ]);

      setPlottedPixels(pixelIds);
      return {
        bundle,
        summary,
        requestedPixels: pixelIds.length,
        availablePixels: available,
        usedSelection: ts.useSelection,
      };
    },
    [manifest?.siteId, year, seriesKey, ts.maxPixels, selectionKey, rangeKey, ts.useSelection, ts.sampleSeed],
    { enabled, keepPrevious: true },
  );
}

/** Daily means for every year the site has, from one shared pixel sample. */
function useYearsData() {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const selection = useAppStore((s) => s.selection);
  const manifest = site?.manifest ?? null;
  const years = site?.facts?.years ?? [];
  const selectionKey = ts.useSelection ? selection.join(',') : '';
  const enabled = Boolean(
    manifest?.timeseries && years.length > 0 && ts.series.length > 0 && ts.chart === 'years',
  );

  return useAsyncData<YearsLoaded>(
    async ({ signal, onProgress }) => {
      if (!manifest) throw new Error('No site selected.');
      const { ids, available } = await pixelIdsFor(
        manifest, years, ts.series, ts.useSelection, selection, ts.maxPixels, ts.sampleSeed, { signal, onProgress },
      );
      if (ids.length === 0) throw new Error(`No pixels carry ${ts.series.join(' or ')} data.`);
      const summary = await getDailySummary(
        manifest,
        { years, series: ts.series, pixelIds: ids },
        { signal, onProgress },
      );
      return {
        summary,
        years,
        pixels: ids.length,
        availablePixels: available,
        usedSelection: ts.useSelection,
      };
    },
    [manifest?.siteId, years.join(','), ts.series.join(','), ts.maxPixels, selectionKey, ts.useSelection, ts.sampleSeed],
    { enabled, keepPrevious: true },
  );
}

/** The series key dates are read from: spline when present (smooth), else the first. */
function primarySeries(series: string[]): string | null {
  return series.includes('spline') ? 'spline' : (series[0] ?? null);
}

export function useKeyDates(summary: DailySummaryRow[] | undefined, series: string[]): KeyDates | null {
  return useMemo(() => {
    const name = primarySeries(series);
    if (!summary || !name) return null;
    return keyDates(summary.filter((r) => r.series === name));
  }, [summary, series]);
}

/** The chart publishes its key dates here so the inspector never re-queries. */
const useSeason = create<{ kd: KeyDates | null; series: string | null; loaded: boolean }>(() => ({
  kd: null,
  series: null,
  loaded: false,
}));

export function TimeSeriesView() {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const update = useAppStore((s) => s.updateTimeseries);
  const catalogIndex = useAppStore((s) => s.catalogIndex);
  const dark = useDark();
  const chartRef = useRef<PlotlyHandle>(null);
  const lineState = useTimeseriesData();
  const yearsState = useYearsData();
  const chart = ts.chart;
  const state = chart === 'years' ? yearsState : lineState;

  const kd = useKeyDates(lineState.data?.summary, ts.series);
  useEffect(() => {
    useSeason.setState({ kd, series: primarySeries(ts.series), loaded: Boolean(lineState.data) });
  }, [kd, ts.series, lineState.data]);

  const individual = Boolean(
    lineState.data?.usedSelection && lineState.data.bundle.pixelsLoaded <= LABELLED_PIXEL_LIMIT,
  );

  const pixelPlot = useMemo(
    () =>
      lineState.data && chart === 'line' && ts.showPixels && !individual
        ? pixelLines(lineState.data.bundle)
        : null,
    [lineState.data, chart, ts.showPixels, individual],
  );

  const traces = useMemo<PlotData[]>(() => {
    if (chart === 'years') return yearsState.data ? buildYearTraces(yearsState.data, ts.series, dark) : [];
    if (!lineState.data) return [];
    if (chart === '3d') return build3dTraces(lineState.data.bundle, dark);
    return buildLineTraces(lineState.data, {
      seriesOrder: ts.series,
      dark,
      pixelLines: pixelPlot?.lines ?? [],
      individual,
      showMean: ts.showMean,
      showIqr: ts.showIqr,
    });
  }, [chart, yearsState.data, lineState.data, ts.series, dark, pixelPlot, individual, ts.showMean, ts.showIqr]);

  const layout = useMemo(() => {
    const base = plotTheme(dark);
    if (chart === '3d') {
      return {
        ...base,
        margin: { l: 0, r: 0, t: MODEBAR_BAND, b: 0 },
        scene: {
          xaxis: { title: { text: 'Date' }, color: dark ? '#98a3b3' : '#666d7a' },
          yaxis: { title: { text: 'Pixel' }, color: dark ? '#98a3b3' : '#666d7a' },
          zaxis: { title: { text: 'EVI' }, color: dark ? '#98a3b3' : '#666d7a' },
          camera: { eye: { x: 1.5, y: -1.6, z: 0.85 } },
          aspectratio: { x: 1.9, y: 1, z: 0.55 },
        },
        showlegend: false,
      };
    }
    const markers = chart === 'line' && ts.showKeyDates && ts.showMean && kd ? keyDateMarkers(kd, dark) : null;
    return {
      ...base,
      hovermode: 'x unified',
      xaxis: {
        ...(base.xaxis as object),
        title: { text: chart === 'years' ? 'Day of year' : 'Date' },
        type: 'date',
        ...(chart === 'years' ? { tickformat: '%b', hoverformat: '%b %-d' } : {}),
      },
      yaxis: { ...(base.yaxis as object), title: { text: 'EVI' } },
      ...(markers ?? {}),
    };
  }, [dark, chart, ts.showKeyDates, ts.showMean, kd]);

  const siteId = site?.manifest.siteId ?? '';
  const siteName = catalogIndex.get(siteId)?.site_name;

  /** What the figure shows, in words: shared by the export title and the caption. */
  const describe = useCallback((): { title: string; subtitle: string; caption: string } | null => {
    // Name what is drawn, not what the filters ask for: a reload may still be running.
    const drawn =
      chart === 'years'
        ? [...new Set(yearsState.data?.summary.map((r) => r.series) ?? [])]
        : (lineState.data?.bundle.seriesNames ?? []);
    const seriesLabel = (drawn.length ? drawn : ts.series).join(' + ');
    const place = siteName ? `${siteId} (${siteName})` : siteId;
    if (chart === 'years') {
      const d = yearsState.data;
      if (!d) return null;
      const sample = d.usedSelection
        ? `${formatCount(d.pixels)} selected pixels`
        : `${formatCount(d.pixels)} of ${formatCount(d.availablePixels)} pixels (random sample)`;
      return {
        title: `${siteId} · ${seriesLabel} EVI · ${d.years[0]}–${d.years[d.years.length - 1]}`,
        subtitle: `${siteName ? `${siteName} · ` : ''}daily mean per year · ${sample}`,
        caption:
          `Daily mean ${seriesLabel} EVI at ${place}, one line per year (${d.years.join(', ')}), ` +
          `plotted on a shared January–December axis. Each line averages the same ${sample}. ` +
          'Source: WetLSP pixels_timeseries.',
      };
    }
    const d = lineState.data;
    if (!d || ts.year === null) return null;
    const range = ts.dateRange ? `${ts.dateRange[0]} to ${ts.dateRange[1]}` : `${ts.year}`;
    const sample = d.usedSelection
      ? `${formatCount(d.bundle.pixelsLoaded)} selected pixels`
      : `${formatCount(d.bundle.pixelsLoaded)} of ${formatCount(d.availablePixels)} pixels (random sample)`;
    const layers = [
      ts.showMean && 'the daily mean (bold line)',
      ts.showIqr && chart === 'line' && 'the interquartile range across pixels (band)',
      ts.showPixels && chart === 'line' && !individual && 'individual pixel trajectories (thin lines)',
      individual && 'each selected pixel as its own line',
    ].filter(Boolean);
    const kdText =
      kd && ts.showKeyDates && chart === 'line'
        ? ` Estimated from the ${primarySeries(ts.series)} mean at ${kd.fraction * 100}% of amplitude: ` +
          `${kd.greenUp ? `green-up ${kd.greenUp.date}, ` : ''}peak ${kd.peak.value.toFixed(3)} on ${kd.peak.date}` +
          `${kd.greenDown ? `, green-down ${kd.greenDown.date}` : ''}.`
        : '';
    return {
      title: `${siteId} · ${seriesLabel} EVI · ${range}`,
      subtitle: `${siteName ? `${siteName} · ` : ''}${sample}`,
      caption:
        `${chart === '3d' ? 'Surface of' : 'Time series of'} ${seriesLabel} EVI at ${place}, ${range}, ` +
        `for ${sample}${layers.length && chart !== '3d' ? `, showing ${layers.join(', ')}` : ''}.${kdText} ` +
        'Source: WetLSP pixels_timeseries.',
    };
  }, [chart, yearsState.data, lineState.data, ts, siteId, siteName, individual, kd]);

  if (!site) {
    return (
      <div className="card h-full">
        <EmptyState
          icon={<LineChart size={26} />}
          title="No site open"
          body="Import a WetLSP site folder to plot its EVI trajectories."
        />
      </div>
    );
  }

  if (!site.manifest.timeseries) {
    return (
      <div className="card h-full">
        <EmptyState
          icon={<LineChart size={26} />}
          title="This site has no time series table"
          body="`pixels_timeseries.parquet` was not part of the import, so there is nothing to plot here. The Phenometrics and Overview views still work."
        />
      </div>
    );
  }

  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<TimeseriesChart>
            size="sm"
            value={chart}
            onChange={(v) => update({ chart: v })}
            options={[
              { value: 'line', label: 'Line', title: 'Daily mean, IQR band and key dates' },
              { value: 'years', label: 'Compare years', title: 'Each year’s daily mean on one calendar' },
              { value: '3d', label: '3D ribbon', title: 'The same data as a surface over date × pixel' },
            ]}
          />
          {chart === 'line' && (
            <div className="flex items-center gap-1" role="group" aria-label="Chart layers">
              <LayerChip on={ts.showMean} onClick={() => update({ showMean: !ts.showMean })} label="Mean" />
              <LayerChip on={ts.showIqr} onClick={() => update({ showIqr: !ts.showIqr })} label="IQR band" />
              <LayerChip
                on={ts.showPixels}
                onClick={() => update({ showPixels: !ts.showPixels })}
                label="Pixels"
                title={individual ? 'Selected pixels are already drawn individually' : 'Every sampled pixel as a thin line'}
              />
              <LayerChip
                on={ts.showKeyDates}
                onClick={() => update({ showKeyDates: !ts.showKeyDates })}
                label="Key dates"
                title="Green-up, peak and green-down estimated from the mean line"
              />
            </div>
          )}
          {state.loading && (
            <Chip tone="accent">
              <RefreshCw size={11} className="animate-spin" />
              {state.progress?.detail ?? 'Loading'}
            </Chip>
          )}
        </div>
        <ExportButtons
          chart={chart}
          lineData={lineState.data}
          ready={Boolean(state.data)}
          chartRef={chartRef}
          describe={describe}
        />
      </div>

      {pixelPlot?.simplified && (
        <div className="border-b border-[var(--border)] px-4 py-1.5 text-[11.5px] text-[var(--text-muted)]">
          Trajectory preview: all {formatCount(lineState.data!.bundle.pixelsLoaded)} pixels, {formatCount(pixelPlot.points)} points preserving endpoints and local extremes. Mean, IQR and CSV include every loaded observation.
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {state.error && !state.data ? (
          <ErrorPanel message={state.error} onRetry={state.reload} />
        ) : !state.data && state.loading ? (
          <LoadingPanel progress={state.progress} onCancel={state.cancel} label="Querying pixels" />
        ) : !state.data ? (
          <EmptyState
            icon={<LineChart size={24} />}
            title="Nothing plotted yet"
            body="Choose a year and a series in the inspector."
          />
        ) : (
          <PlotlyChart
            ref={chartRef}
            data={traces}
            layout={layout}
            config={PLOT_CONFIG}
            className="absolute inset-0 p-1"
          />
        )}
      </div>

      <StatusFooter chart={chart} lineState={lineState} yearsState={yearsState} />
    </div>
  );
}

function LayerChip({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={
        on
          ? 'chip border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-[var(--accent)]'
          : 'chip text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
      }
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
      />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------- building */

function buildLineTraces(
  loaded: Loaded,
  opts: {
    seriesOrder: string[];
    dark: boolean;
    pixelLines: PixelLine[];
    individual: boolean;
    showMean: boolean;
    showIqr: boolean;
  },
): PlotData[] {
  const { bundle, summary } = loaded;
  const { seriesOrder, dark } = opts;
  const traces: PlotData[] = [];
  const bySeries = new Map<string, DailySummaryRow[]>();
  for (const r of summary) {
    const list = bySeries.get(r.series);
    if (list) list.push(r);
    else bySeries.set(r.series, [r]);
  }

  // IQR band per series, drawn first so every line sits on top of it.
  if (opts.showIqr) {
    for (const name of seriesOrder) {
      const rows = bySeries.get(name);
      if (!rows?.length) continue;
      const color = seriesColor(name, dark);
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: `${name} q25`,
        x: rows.map((r) => r.date),
        y: rows.map((r) => r.q25),
        line: { width: 0 },
        hoverinfo: 'skip',
        showlegend: false,
        legendgroup: `${name}-iqr`,
      });
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: `${name} · IQR`,
        x: rows.map((r) => r.date),
        y: rows.map((r) => r.q75),
        line: { width: 0 },
        fill: 'tonexty',
        fillcolor: hexWithAlpha(color, 0.16),
        hoverinfo: 'skip',
        legendgroup: `${name}-iqr`,
      });
    }
  }

  // Spaghetti: one WebGL trace per series, pixels separated by a null gap so a
  // single trace can hold thousands of independent lines.
  for (const { series: name, x, y } of opts.pixelLines) {
    traces.push({
      type: 'scattergl',
      mode: 'lines',
      name: `${name} · pixels`,
      x,
      y,
      line: { color: seriesColor(name, dark), width: 0.7 },
      opacity: 0.09,
      hoverinfo: 'skip',
      showlegend: true,
      legendgroup: `${name}-pixels`,
    });
  }

  // A handful of selected pixels: each its own labelled line.
  if (opts.individual) {
    const colourOf = new Map<number, number>();
    for (let start = 0; start < bundle.rows;) {
      let end = start + 1;
      while (end < bundle.rows && bundle.pixelId[end] === bundle.pixelId[start] &&
        bundle.seriesIdx[end] === bundle.seriesIdx[start]) end++;
      const series = bundle.seriesNames[bundle.seriesIdx[start]];
      const id = bundle.pixelId[start];
      const x: string[] = [];
      const y: number[] = [];
      for (let i = start; i < end; i++) {
        x.push(isoFromMs(bundle.time[i]));
        y.push(bundle.evi[i]);
      }
      traces.push({
        type: 'scatter',
        mode: series === 'raw' ? 'lines+markers' : 'lines',
        name: `pixel ${id}${seriesOrder.length > 1 ? ` · ${series}` : ''}`,
        x,
        y,
        line: { color: lineColor(colourOf.get(id) ?? colourOf.set(id, colourOf.size).get(id)!, dark), width: 1.4, dash: series === 'raw' && seriesOrder.length > 1 ? 'dot' : 'solid' },
        marker: { size: 4 },
        hovertemplate: `pixel ${id} · ${series} %{y:.4f}<extra></extra>`,
      });
      start = end;
    }
  }

  if (opts.showMean) {
    for (const name of seriesOrder) {
      const rows = bySeries.get(name);
      if (!rows?.length) continue;
      const raw = name === 'raw';
      traces.push({
        type: 'scatter',
        mode: raw ? 'lines+markers' : 'lines',
        name: `${name} · daily mean`,
        x: rows.map((r) => r.date),
        y: rows.map((r) => r.mean),
        line: {
          color: opts.individual ? (dark ? '#e8ecf2' : '#14181f') : seriesColor(name, dark),
          width: opts.individual ? 2.2 : 2.4,
          dash: opts.individual ? 'dash' : 'solid',
        },
        marker: { size: 4.5 },
        customdata: rows.map((r) => [r.q25, r.q75, r.n]),
        hovertemplate:
          `<b>${name}</b> mean %{y:.4f}` +
          '<br>IQR %{customdata[0]:.4f} – %{customdata[1]:.4f}' +
          '<br>%{customdata[2]} pixels<extra></extra>',
      });
    }
  }

  return traces;
}

/** Vertical markers and labels for green-up, peak and green-down. */
function keyDateMarkers(kd: KeyDates, dark: boolean): { shapes: unknown[]; annotations: unknown[] } {
  const ink = dark ? '#cbd5e1' : '#475569';
  const points = [
    kd.greenUp && { ...kd.greenUp, label: 'green-up' },
    { ...kd.peak, label: `peak ${kd.peak.value.toFixed(3)}` },
    kd.greenDown && { ...kd.greenDown, label: 'green-down' },
  ].filter((p): p is { date: string; value: number; label: string } => Boolean(p));
  return {
    shapes: points.map((p) => ({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: p.date,
      x1: p.date,
      y0: 0,
      y1: 1,
      line: { color: ink, width: 1, dash: 'dot' },
      layer: 'below',
    })),
    annotations: points.map((p) => ({
      x: p.date,
      y: 1,
      xref: 'x',
      yref: 'paper',
      yanchor: 'bottom',
      showarrow: false,
      text: `${p.label}<br><span style="font-size:10px">${new Date(`${p.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>`,
      font: { size: 10.5, color: ink },
      bgcolor: dark ? 'rgba(11,15,20,0.75)' : 'rgba(255,255,255,0.8)',
    })),
  };
}

/** One daily-mean line per year, all placed on the calendar of leap year 2000. */
function buildYearTraces(loaded: YearsLoaded, seriesOrder: string[], dark: boolean): PlotData[] {
  const traces: PlotData[] = [];
  const latest = loaded.years[loaded.years.length - 1];
  loaded.years.forEach((year, yi) => {
    for (const name of seriesOrder) {
      const rows = loaded.summary.filter((r) => r.series === name && r.date.startsWith(`${year}-`));
      if (rows.length === 0) continue;
      traces.push({
        type: 'scatter',
        mode: name === 'raw' ? 'lines+markers' : 'lines',
        name: seriesOrder.length > 1 ? `${year} · ${name}` : String(year),
        x: rows.map((r) => `2000${r.date.slice(4)}`),
        y: rows.map((r) => r.mean),
        line: {
          color: lineColor(yi, dark),
          width: year === latest ? 2.6 : 1.6,
          dash: name === 'raw' && seriesOrder.length > 1 ? 'dot' : 'solid',
        },
        marker: { size: 4 },
        customdata: rows.map((r) => [r.date, r.n]),
        hovertemplate: `<b>${year}</b> ${name} %{y:.4f}<br>%{customdata[1]} pixels<extra></extra>`,
      });
    }
  });
  return traces;
}

/** The same filtered rows as a surface over date × pixel. */
function build3dTraces(bundle: TimeseriesBundle, dark: boolean): PlotData[] {
  const MAX_PIXELS = 150;
  const MAX_DATES = 220;

  const times = [...new Set(Array.from(bundle.time))].sort((a, b) => a - b);
  const pixels = [...new Set(Array.from(bundle.pixelId))].sort((a, b) => a - b);
  const tStep = Math.ceil(times.length / MAX_DATES);
  const pStep = Math.ceil(pixels.length / MAX_PIXELS);
  const keptTimes = times.filter((_, i) => i % tStep === 0);
  const keptPixels = pixels.filter((_, i) => i % pStep === 0);
  const tIndex = new Map(keptTimes.map((t, i) => [t, i]));
  const pIndex = new Map(keptPixels.map((p, i) => [p, i]));

  const z: Array<Array<number | null>> = keptPixels.map(() =>
    new Array<number | null>(keptTimes.length).fill(null),
  );
  for (let i = 0; i < bundle.rows; i++) {
    const pi = pIndex.get(bundle.pixelId[i]);
    const ti = tIndex.get(bundle.time[i]);
    if (pi === undefined || ti === undefined) continue;
    z[pi][ti] = bundle.evi[i];
  }

  return [
    {
      type: 'surface',
      z,
      x: keptTimes.map((t) => isoFromMs(t)),
      y: keptPixels,
      colorscale: [
        [0, dark ? '#0b2b2b' : '#f7fcf5'],
        [0.35, '#74c476'],
        [0.7, '#238b45'],
        [1, '#00441b'],
      ],
      showscale: true,
      colorbar: { title: { text: 'EVI' }, thickness: 10, len: 0.6, outlinewidth: 0 },
      contours: { z: { show: true, usecolormap: true, project: { z: false } } },
      hovertemplate: 'pixel %{y}<br>%{x}<br>EVI %{z:.4f}<extra></extra>',
    },
  ];
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* --------------------------------------------------------------- footer */

function StatusFooter({
  chart,
  lineState,
  yearsState,
}: {
  chart: TimeseriesChart;
  lineState: ReturnType<typeof useTimeseriesData>;
  yearsState: ReturnType<typeof useYearsData>;
}) {
  const parts: string[] = [];
  let sampled = false;
  const state = chart === 'years' ? yearsState : lineState;
  if (chart === 'years' && yearsState.data) {
    const d = yearsState.data;
    parts.push(`${d.years.length} years`);
    parts.push(d.usedSelection ? `${formatCount(d.pixels)} selected pixels` : `${formatCount(d.pixels)} of ${formatCount(d.availablePixels)} pixels sampled`);
    parts.push(`${formatCount(d.summary.length)} daily means`);
    sampled = !d.usedSelection && d.availablePixels > d.pixels;
  } else if (chart !== 'years' && lineState.data) {
    const d = lineState.data;
    parts.push(`${formatCount(d.bundle.rows)} rows`);
    parts.push(
      d.usedSelection
        ? `${formatCount(d.bundle.pixelsLoaded)} selected pixels`
        : `${formatCount(d.bundle.pixelsLoaded)} of ${formatCount(d.availablePixels)} pixels sampled`,
    );
    if (d.summary.length) parts.push(`${formatCount(d.summary.length)} daily aggregates`);
    sampled = !d.usedSelection && d.availablePixels > d.bundle.pixelsLoaded;
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2 text-[11.5px] text-[var(--text-muted)]">
      <span className="truncate">{parts.join(' · ') || 'Nothing loaded yet'}</span>
      {sampled && (
        <span className="shrink-0 text-[var(--text-faint)]">
          showing a random sample — draw a new one or raise Max pixels in the inspector
        </span>
      )}
      {state.error && state.data && (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">{state.error}</span>
      )}
    </div>
  );
}

function ExportButtons({
  chart,
  lineData,
  ready,
  chartRef,
  describe,
}: {
  chart: TimeseriesChart;
  lineData: Loaded | null;
  ready: boolean;
  chartRef: React.RefObject<PlotlyHandle | null>;
  describe: () => { title: string; subtitle: string; caption: string } | null;
}) {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const d = lineData;

  const baseName = useCallback(
    (ext: string, extra?: string) =>
      timestampedName(
        [site?.manifest.siteId, 'evi', chart === 'years' ? 'years' : ts.year, ts.series.join('-'), extra],
        ext,
      ),
    [site, chart, ts.year, ts.series],
  );

  const render = useCallback(
    async (opts: ExportOptions = {}) => {
      const handle = chartRef.current;
      if (!handle) throw new Error('The chart is not ready to export yet.');
      const words = describe();
      return dataUrlToBlob(
        await handle.toImage({
          title: words?.title,
          subtitle: words?.subtitle,
          background: exportBackground(),
          ...opts,
        }),
      );
    },
    [chartRef, describe],
  );

  const exportRows = useCallback(() => {
    if (!d) return;
    const b = d.bundle;
    const rows: Array<Array<unknown>> = new Array(b.rows);
    for (let i = 0; i < b.rows; i++) {
      rows[i] = [b.pixelId[i], b.seriesNames[b.seriesIdx[i]], isoFromMs(b.time[i]), b.evi[i]];
    }
    downloadCsv(
      timestampedName([site?.manifest.siteId, 'evi-pixels', ts.year], 'csv'),
      ['pixel_id', 'series', 'date', 'evi'],
      rows,
    );
  }, [d, site, ts.year]);

  const exportSummary = useCallback(() => {
    if (!d) return;
    downloadCsv(
      timestampedName([site?.manifest.siteId, 'evi-daily', ts.year], 'csv'),
      ['date', 'series', 'mean', 'q25', 'q75', 'n_pixels'],
      d.summary.map((r) => [r.date, r.series, r.mean, r.q25, r.q75, r.n]),
    );
  }, [d, site, ts.year]);

  const flat = chart !== '3d';
  return (
    <FigureMenu
      disabled={!ready}
      actions={{
        save: async () => downloadBlob(await render(), baseName('png')),
        copy: () => copyImage(render()),
        caption: () => describe()?.caption ?? null,
      }}
      items={[
        ...(flat
          ? [
              {
                label: 'SVG (vector, for papers)',
                hint: '.svg',
                icon: <FileImage size={13} />,
                run: async () => downloadBlob(await render({ format: 'svg', scale: 1 }), baseName('svg')),
              },
            ]
          : []),
        {
          label: 'PNG for slides',
          hint: '1920×1080',
          icon: <Presentation size={13} />,
          run: async () => downloadBlob(await render({ width: 1920, height: 1080, scale: 1 }), baseName('png', 'slide')),
        },
        ...(chart !== 'years'
          ? [
              { label: 'Daily mean + IQR', hint: 'CSV', icon: <Table size={13} />, run: exportSummary, disabled: !d },
              { label: 'Every pixel observation', hint: 'CSV', icon: <Boxes size={13} />, run: exportRows, disabled: !d },
            ]
          : []),
      ]}
    />
  );
}

/* ------------------------------------------------------------ inspector */

/** Season numbers read off the plotted mean line. Shares the chart's query cache. */
function SeasonCard() {
  const { kd, series, loaded } = useSeason();
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const doy = (iso: string) =>
    Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(Number(iso.slice(0, 4)), 0, 1)) / 86_400_000) + 1;

  return (
    <Card
      title="Season"
      subtitle={loaded ? `From the ${series} daily mean` : undefined}
    >
      {!loaded ? (
        <p className="text-[12px] text-[var(--text-muted)]">Waiting for the chart…</p>
      ) : !kd ? (
        <p className="text-[12px] leading-snug text-[var(--text-muted)]">
          No clear seasonal rise and fall in this range.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[12px]">
          {[
            ['Green-up', kd.greenUp ? `${fmt(kd.greenUp.date)} · DOY ${doy(kd.greenUp.date)}` : '—'],
            ['Peak', `${fmt(kd.peak.date)} · ${kd.peak.value.toFixed(3)}`],
            ['Green-down', kd.greenDown ? `${fmt(kd.greenDown.date)} · DOY ${doy(kd.greenDown.date)}` : '—'],
            ['Season length', kd.seasonDays !== null ? `${kd.seasonDays} days` : '—'],
            ['Amplitude', kd.amplitude.toFixed(3)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] text-[var(--text-faint)]">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

export function TimeSeriesInspector() {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const update = useAppStore((s) => s.updateTimeseries);
  const selection = useAppStore((s) => s.selection);
  const setView = useAppStore((s) => s.setView);
  const [pixelDraft, setPixelDraft] = useState<number | null>(null);

  if (!site?.facts) {
    return (
      <EmptyState compact title="No site loaded" body="Import a dataset to see its controls." />
    );
  }

  const facts = site.facts;
  const draft = pixelDraft ?? ts.maxPixels;
  const dateBounds: [string, string] | null =
    facts.dateMin && facts.dateMax ? [facts.dateMin, facts.dateMax] : null;
  const yearBounds: [string, string] | null =
    ts.year !== null ? [`${ts.year}-01-01`, `${ts.year}-12-31`] : dateBounds;

  return (
    <div className="space-y-3">
      <Card title="Filters">
        <div className="space-y-3.5">
          <Field label="Year" htmlFor="ts-year">
            <div className="flex flex-wrap gap-1.5">
              {facts.years.map((y) => (
                <button
                  key={y}
                  onClick={() => update({ year: y, dateRange: null })}
                  className={
                    y === ts.year
                      ? 'chip border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-[var(--accent)]'
                      : 'chip hover:bg-[var(--bg-hover)]'
                  }
                >
                  {y}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Series">
            <div className="flex flex-wrap gap-1.5">
              {facts.series.map((s) => {
                const on = ts.series.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() =>
                      update({
                        series: on
                          ? ts.series.filter((x) => x !== s)
                          : [...ts.series, s].sort((a, b) =>
                              a === 'spline' ? -1 : b === 'spline' ? 1 : a.localeCompare(b),
                            ),
                      })
                    }
                    className="chip"
                    style={
                      on
                        ? {
                            borderColor: seriesColor(s, document.documentElement.classList.contains('dark')),
                            color: seriesColor(s, document.documentElement.classList.contains('dark')),
                            background: 'transparent',
                          }
                        : undefined
                    }
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background: on
                          ? seriesColor(s, document.documentElement.classList.contains('dark'))
                          : 'var(--border-strong)',
                      }}
                    />
                    {s}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Max pixels"
            hint={`${formatCount(draft)} / ${formatCount(MAX_PIXEL_SAMPLE)}`}
          >
            <Slider
              min={25}
              max={MAX_PIXEL_SAMPLE}
              step={25}
              value={draft}
              disabled={ts.useSelection}
              onChange={(v) => setPixelDraft(v)}
            />
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-[var(--text-faint)]">
                default {DEFAULT_PIXEL_SAMPLE}
              </span>
              {pixelDraft !== null && pixelDraft !== ts.maxPixels && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    update({ maxPixels: pixelDraft });
                    setPixelDraft(null);
                  }}
                >
                  Load {formatCount(pixelDraft)} pixels
                </Button>
              )}
            </div>
          </Field>

          {yearBounds && (
            <Field label="Date range">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={ts.dateRange?.[0] ?? yearBounds[0]}
                  min={yearBounds[0]}
                  max={ts.dateRange?.[1] ?? yearBounds[1]}
                  onChange={(e) =>
                    update({ dateRange: [e.target.value, ts.dateRange?.[1] ?? yearBounds[1]] })
                  }
                  className="h-8 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12.5px]"
                />
                <span className="text-[var(--text-faint)]">→</span>
                <input
                  type="date"
                  value={ts.dateRange?.[1] ?? yearBounds[1]}
                  min={ts.dateRange?.[0] ?? yearBounds[0]}
                  max={yearBounds[1]}
                  onChange={(e) =>
                    update({ dateRange: [ts.dateRange?.[0] ?? yearBounds[0], e.target.value] })
                  }
                  className="h-8 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12.5px]"
                />
              </div>
              {ts.dateRange && (
                <button
                  onClick={() => update({ dateRange: null })}
                  className="pt-1 text-[11.5px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
                >
                  Reset to the whole year
                </button>
              )}
            </Field>
          )}
        </div>
      </Card>

      <Card title="Pixel source">
        <Toggle
          checked={ts.useSelection}
          onChange={(v) => update({ useSelection: v })}
          label="Use the map selection"
          hint={
            selection.length
              ? `${formatCount(selection.length)} pixels selected`
              : 'Nothing selected yet'
          }
          disabled={selection.length === 0 && !ts.useSelection}
        />
        {!ts.useSelection && (
          <Button
            size="sm"
            className="mt-2 w-full"
            icon={<Shuffle size={13} />}
            onClick={() => update({ sampleSeed: newSeed() })}
            title="Plot a different random set of pixels"
          >
            New random sample
          </Button>
        )}
        {selection.length === 0 && (
          <button
            onClick={() => setView('pixelmap')}
            className="mt-1.5 px-2 text-[11.5px] text-[var(--accent)] underline underline-offset-2"
          >
            Draw a selection on the Pixel Map →
          </button>
        )}
      </Card>

      {ts.chart === 'line' && <SeasonCard />}

      <Card title="How to read it">
        <ul className="space-y-1.5 text-[12px] leading-snug text-[var(--text-muted)]">
          <li>
            <span className="font-medium text-[var(--text)]">Bold line</span> — the daily mean.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Shaded band</span> — the interquartile
            range across the plotted pixels, per day.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Pixels</span> — turn on to draw every
            sampled pixel as a thin line. Select 12 or fewer pixels on the map to get one labelled
            line each.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">Key dates</span> — where the mean
            crosses half its seasonal amplitude, and its peak. A quick reading of the line; the
            Phenometrics layers are the reference values.
          </li>
          <li>
            <span className="font-medium text-[var(--text)]">spline</span> is gap-filled daily;{' '}
            <span className="font-medium text-[var(--text)]">raw</span> is the observed, sparser
            record.
          </li>
        </ul>
      </Card>
    </div>
  );
}
