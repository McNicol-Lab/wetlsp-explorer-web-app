/**
 * Region comparison for the Time Series line chart: one daily mean and
 * interquartile band per region, in the region's map colour, with the
 * season's key dates read off each mean.
 *
 * Each region is summarised over its own pixels (all of them, or a random
 * `selectionCap` when it holds more), from the same year tables as every
 * other chart, so a region's numbers equal what "Plot these pixels" would
 * give for the same pixel set.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { PlotData } from 'plotly.js-dist-min';
import { Card } from '@/components/ui';
import { useActiveSite, useAppStore, useRegions, type Region } from '@/store/useAppStore';
import { getDailySummary, getTimeseries } from '@/engine/queries';
import { downloadCsv, timestampedName } from '@/lib/export';
import { formatCount, isoFromMs } from '@/lib/format';
import type { DailySummaryRow } from '@/lib/types';
import { useAsyncData } from './shared';
import { keyDates, type KeyDates } from './keyDates';

export interface RegionResult {
  id: string;
  name: string;
  color: string;
  source: string;
  poolSize: number;
  sampleSize: number;
  summary: DailySummaryRow[];
  /** Pixels that had at least one value in the window. */
  pixelsWithData: number;
}

export interface RegionsLoaded {
  regions: RegionResult[];
  year: number;
  series: string[];
}

/** Regions in the comparison, in list order. */
export function useComparedRegions(): Region[] {
  const regions = useRegions();
  return useMemo(() => regions.filter((r) => r.enabled), [regions]);
}

export function useRegionsData() {
  const site = useActiveSite();
  const ts = useAppStore((s) => s.timeseries);
  const setPlottedPixels = useAppStore((s) => s.setPlottedPixels);
  const regions = useComparedRegions();
  const manifest = site?.manifest ?? null;
  const key = regions.map((r) => `${r.id}:${r.seed}:${r.sample.length}`).join('|');
  const enabled = Boolean(
    manifest?.timeseries && ts.compareRegions && ts.chart === 'line' && ts.year !== null && ts.series.length > 0,
  );

  return useAsyncData<RegionsLoaded>(
    async ({ signal, onProgress }) => {
      if (!manifest || ts.year === null) throw new Error('No site selected.');
      if (regions.length === 0) {
        throw new Error('No regions are switched on. Draw or import regions on the Pixel Map, or turn some on in its inspector.');
      }
      const years = [ts.year];
      const out: RegionResult[] = [];
      for (const r of regions) {
        const summary = await getDailySummary(
          manifest,
          { years, series: ts.series, pixelIds: r.sample, dateRange: ts.dateRange },
          { signal, onProgress },
        );
        const maxN = summary.reduce((m, row) => Math.max(m, row.n), 0);
        out.push({
          id: r.id,
          name: r.name,
          color: r.color,
          source: r.source,
          poolSize: r.pool.length,
          sampleSize: r.sample.length,
          summary,
          pixelsWithData: maxN,
        });
      }
      const union = new Set<number>();
      for (const r of regions) for (const id of r.sample) union.add(id);
      setPlottedPixels(Int32Array.from(union));
      return { regions: out, year: ts.year, series: [...ts.series] };
    },
    [manifest?.siteId, key, ts.year, ts.series.join(','), ts.dateRange?.join('..') ?? '', ts.compareRegions],
    { enabled, keepPrevious: true },
  );
}

function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

/** Mean line and IQR band per region and series. */
export function buildRegionTraces(
  loaded: RegionsLoaded,
  opts: { showMean: boolean; showIqr: boolean },
): PlotData[] {
  const traces: PlotData[] = [];
  const multiSeries = loaded.series.length > 1;
  for (const r of loaded.regions) {
    for (const series of loaded.series) {
      const rows = r.summary.filter((row) => row.series === series);
      if (rows.length === 0) continue;
      const label = `${r.name}${multiSeries ? ` · ${series}` : ''}`;
      const group = `${r.id}-${series}`;
      if (opts.showIqr && series !== 'raw') {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: `${label} q25`,
          x: rows.map((row) => row.date),
          y: rows.map((row) => row.q25),
          line: { width: 0 },
          hoverinfo: 'skip',
          showlegend: false,
          legendgroup: group,
        });
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: `${label} IQR`,
          x: rows.map((row) => row.date),
          y: rows.map((row) => row.q75),
          line: { width: 0 },
          fill: 'tonexty',
          fillcolor: rgba(r.color, 0.13),
          hoverinfo: 'skip',
          showlegend: false,
          legendgroup: group,
        });
      }
      if (opts.showMean || !opts.showIqr) {
        traces.push({
          type: 'scatter',
          mode: series === 'raw' ? 'markers' : 'lines',
          name: `${label} (n=${formatCount(r.pixelsWithData)})`,
          x: rows.map((row) => row.date),
          y: rows.map((row) => row.mean),
          line: { color: r.color, width: 2.2, dash: series === 'raw' && multiSeries ? 'dot' : 'solid' },
          marker: { color: r.color, size: 5, symbol: series === 'raw' ? 'circle-open' : 'circle' },
          legendgroup: group,
          customdata: rows.map((row) => [row.q25, row.q75, row.n]),
          hovertemplate:
            `<b>${r.name}</b> ${series} mean %{y:.4f}` +
            '<br>IQR %{customdata[0]:.4f} – %{customdata[1]:.4f}' +
            '<br>%{customdata[2]} pixels<extra></extra>',
        });
      }
    }
  }
  return traces;
}

/** Key dates per region, read off its primary-series mean. */
export function regionKeyDates(loaded: RegionsLoaded | null): Array<{ r: RegionResult; kd: KeyDates | null }> {
  if (!loaded) return [];
  const primary = loaded.series.includes('spline') ? 'spline' : loaded.series[0];
  return loaded.regions.map((r) => ({ r, kd: keyDates(r.summary.filter((row) => row.series === primary)) }));
}

/** What the comparison shows, for the export title and the caption. */
export function describeRegions(
  loaded: RegionsLoaded,
  ctx: { siteId: string; siteName?: string; range: string },
): { title: string; subtitle: string; caption: string } {
  const place = ctx.siteName ? `${ctx.siteId} (${ctx.siteName})` : ctx.siteId;
  const seriesLabel = loaded.series.join(' + ');
  const parts = loaded.regions.map(
    (r) =>
      `${r.name} (${r.sampleSize < r.poolSize ? `random ${formatCount(r.sampleSize)} of ${formatCount(r.poolSize)}` : formatCount(r.poolSize)} pixels)`,
  );
  const sources = [...new Set(loaded.regions.map((r) => (r.source === 'drawn' ? 'drawn on the map' : r.source)))];
  return {
    title: `${ctx.siteId} · ${seriesLabel} EVI by region · ${ctx.range}`,
    subtitle: `${ctx.siteName ? `${ctx.siteName} · ` : ''}${loaded.regions.length} regions`,
    caption:
      `Daily mean ${seriesLabel} EVI at ${place}, ${ctx.range}, for ${loaded.regions.length} regions: ${parts.join('; ')}. ` +
      'Lines are the daily mean across each region’s pixels and bands their interquartile range. ' +
      `A pixel belongs to a region when its centre lies inside it. Regions: ${sources.join(', ')}. Source: WetLSP pixels_timeseries.`,
  };
}

/** Long-format daily summary: one row per region × date × series. */
export function exportRegionSummary(loaded: RegionsLoaded, siteId: string): void {
  const rows: unknown[][] = [];
  for (const r of loaded.regions) {
    for (const row of r.summary) {
      rows.push([r.id, r.name, r.source, row.date, row.series, row.mean, row.q25, row.q75, row.n, r.poolSize, r.sampleSize]);
    }
  }
  downloadCsv(
    timestampedName([siteId, 'evi-daily-by-region', loaded.year], 'csv'),
    ['region_id', 'region_name', 'source', 'date', 'series', 'mean', 'q25', 'q75', 'n_pixels', 'pixels_in_region', 'pixels_sampled'],
    rows,
  );
}

/** Every observation of every compared region's plotted pixels. */
export async function exportRegionObservations(
  loaded: RegionsLoaded,
  regions: Region[],
  ctx: { siteId: string; dateRange: [string, string] | null },
): Promise<void> {
  const manifest = useAppStore.getState().sites[ctx.siteId]?.manifest;
  if (!manifest) throw new Error('The site is no longer open.');
  const rows: unknown[][] = [];
  for (const r of regions.filter((x) => loaded.regions.some((l) => l.id === x.id))) {
    const b = await getTimeseries(manifest, {
      years: [loaded.year],
      series: loaded.series,
      pixelIds: r.sample,
      dateRange: ctx.dateRange,
    });
    for (let i = 0; i < b.rows; i++) {
      rows.push([r.id, r.name, b.pixelId[i], b.seriesNames[b.seriesIdx[i]], isoFromMs(b.time[i]), Number(b.evi[i].toPrecision(7))]);
    }
  }
  downloadCsv(
    timestampedName([ctx.siteId, 'evi-pixels-by-region', loaded.year], 'csv'),
    ['region_id', 'region_name', 'pixel_id', 'series', 'date', 'evi'],
    rows,
  );
}

/** The chart publishes its results here so the inspector never re-queries. */
export const useRegionResults = create<{ loaded: RegionsLoaded | null }>(() => ({ loaded: null }));

/** Green-up, peak and green-down for each region, side by side. */
export function RegionSeasonCard() {
  const loaded = useRegionResults((s) => s.loaded);
  const rows = regionKeyDates(loaded);
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <Card title="Season by region" subtitle={loaded ? `From each region's ${loaded.series.includes('spline') ? 'spline' : loaded.series[0]} mean` : undefined}>
      {!loaded ? (
        <p className="text-[12px] text-[var(--text-muted)]">Waiting for the chart…</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full whitespace-nowrap text-[11.5px] tabular-nums">
            <thead className="text-[var(--text-faint)]">
              <tr>
                <th className="px-1 py-1 text-left font-medium">Region</th>
                <th className="px-1 py-1 text-right font-medium" title="Green-up">Up</th>
                <th className="px-1 py-1 text-right font-medium">Peak</th>
                <th className="px-1 py-1 text-right font-medium" title="Peak EVI">EVI</th>
                <th className="px-1 py-1 text-right font-medium" title="Green-down">Down</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, kd }) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="max-w-[92px] truncate px-1 py-1" title={r.name}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />
                    {r.name}
                  </td>
                  <td className="px-1 py-1 text-right">{kd?.greenUp ? fmt(kd.greenUp.date) : '—'}</td>
                  <td className="px-1 py-1 text-right">{kd ? fmt(kd.peak.date) : '—'}</td>
                  <td className="px-1 py-1 text-right">{kd ? kd.peak.value.toFixed(2) : '—'}</td>
                  <td className="px-1 py-1 text-right">{kd?.greenDown ? fmt(kd.greenDown.date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-1 pt-1.5 text-[11px] leading-snug text-[var(--text-faint)]">
            A quick reading of each mean line. The Phenometrics layers hold the reference values.
          </p>
        </div>
      )}
    </Card>
  );
}
