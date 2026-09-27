/**
 * Thin Plotly wrapper. Plotly is a ~3 MB bundle, so it is imported lazily the
 * first time a chart mounts and the shell never pays for it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PlotConfig, PlotData, PlotLayout } from 'plotly.js-dist-min';
import { Skeleton } from './ui';

export interface ExportOptions {
  format?: 'png' | 'svg';
  /** Bold first line stamped above the plot, e.g. "CA-DSM · spline EVI · 2024". */
  title?: string;
  /** Smaller second line: sample size, date range, source. */
  subtitle?: string;
  width?: number;
  height?: number;
  scale?: number;
  background?: string;
}

export interface PlotlyHandle {
  element(): HTMLDivElement | null;
  toPng(filename: string): Promise<void>;
  /** Render a standalone, titled copy of the chart. Returns a data URL. */
  toImage(opts: ExportOptions): Promise<string>;
}

type PlotlyModule = typeof import('plotly.js-dist-min');
let plotlyPromise: Promise<PlotlyModule> | null = null;
function loadPlotly(): Promise<PlotlyModule> {
  plotlyPromise ??= import('plotly.js-dist-min');
  return plotlyPromise;
}

export const PlotlyChart = forwardRef<
  PlotlyHandle,
  {
    data: PlotData[];
    layout: PlotLayout;
    config?: PlotConfig;
    className?: string;
    onRelayout?: (ev: Record<string, unknown>) => void;
  }
>(function PlotlyChart({ data, layout, config, className, onRelayout }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const plotlyRef = useRef<PlotlyModule | null>(null);
  const relayoutRef = useRef(onRelayout);
  relayoutRef.current = onRelayout;

  useImperativeHandle(ref, () => ({
    element: () => hostRef.current,
    toPng: async (filename: string) => {
      const el = hostRef.current;
      const plotly = plotlyRef.current;
      if (!el || !plotly) throw new Error('The chart is not ready to export yet.');
      await plotly.downloadImage(el, { format: 'png', filename, scale: 2 });
    },
    toImage: async (opts: ExportOptions) => {
      const el = hostRef.current as (HTMLDivElement & { data?: PlotData[]; layout?: PlotLayout }) | null;
      const plotly = plotlyRef.current;
      if (!el?.data || !el.layout || !plotly) throw new Error('The chart is not ready to export yet.');
      const width = opts.width ?? Math.max(900, el.clientWidth);
      const height = opts.height ?? Math.max(520, el.clientHeight);
      const onScreen = (el.layout.margin as Record<string, number> | undefined) ?? {};
      // Exported images carry no toolbar, so drop the band reserved for it.
      const margin = { ...onScreen, t: Math.max(0, (onScreen.t ?? MODEBAR_BAND) - MODEBAR_BAND) + 14 };
      const title = opts.title
        ? {
            text: `<b>${escapeHtml(opts.title)}</b>${
              opts.subtitle ? `<br><span style="font-size:12px">${escapeHtml(opts.subtitle)}</span>` : ''
            }`,
            x: 0.01,
            xanchor: 'left',
            // Container coordinates: the title sits in the top margin, never clipped.
            xref: 'container',
            yref: 'container',
            y: 1,
            yanchor: 'top',
            pad: { t: 16, l: 8 },
            font: { size: 17 },
          }
        : undefined;
      const layout: PlotLayout = {
        ...el.layout,
        width,
        height,
        // A transparent export looks broken when pasted onto a dark slide.
        paper_bgcolor: opts.background ?? '#ffffff',
        plot_bgcolor: opts.background ?? '#ffffff',
        ...(title
          ? { title, margin: { ...margin, t: margin.t + (opts.subtitle ? 74 : 52) } }
          : { margin }),
        legend: { ...((el.layout.legend as object) ?? {}), y: 1.02, yanchor: 'bottom' },
      };
      return plotly.toImage(
        { data: el.data, layout },
        { format: opts.format ?? 'png', width, height, scale: opts.scale ?? 2 },
      );
    },
  }));

  useEffect(() => {
    let cancelled = false;
    void loadPlotly().then((plotly) => {
      if (cancelled || !hostRef.current) return;
      plotlyRef.current = plotly;
      void plotly.react(hostRef.current, data, layout, config).then(() => {
        if (cancelled) return;
        setReady(true);
        const el = hostRef.current as (HTMLDivElement & { on?: (e: string, cb: (d: Record<string, unknown>) => void) => void }) | null;
        el?.on?.('plotly_relayout', (d) => relayoutRef.current?.(d));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [data, layout, config]);

  useEffect(() => {
    const el = hostRef.current;
    return () => {
      if (el && plotlyRef.current) plotlyRef.current.purge(el);
    };
  }, []);

  return (
    <div className={className ?? 'relative h-full w-full'}>
      <div ref={hostRef} className="h-full w-full" />
      {!ready && <Skeleton className="absolute inset-3" />}
    </div>
  );
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A data URL from `toImage` as a Blob, for downloads and the clipboard. */
export async function dataUrlToBlob(url: string): Promise<Blob> {
  if (url.startsWith('data:image/svg+xml,')) {
    return new Blob([decodeURIComponent(url.slice('data:image/svg+xml,'.length))], { type: 'image/svg+xml' });
  }
  return (await fetch(url)).blob();
}

/** Height of Plotly's toolbar strip, reserved at the top of every chart. */
export const MODEBAR_BAND = 44;

/** Layout defaults shared by every chart, in the current theme's tokens. */
export function plotTheme(dark: boolean): PlotLayout {
  const text = dark ? '#e8ecf2' : '#14181f';
  const muted = dark ? '#98a3b3' : '#666d7a';
  const grid = dark ? '#212a36' : '#e3e6ec';
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Inter, system-ui, sans-serif', size: 12, color: text },
    // The top band holds the legend on the left and Plotly's toolbar on the
    // right, so the toolbar never sits over the data.
    margin: { l: 56, r: 18, t: MODEBAR_BAND, b: 44 },
    hoverlabel: {
      bgcolor: dark ? '#121821' : '#ffffff',
      bordercolor: grid,
      font: { color: text, size: 12 },
    },
    xaxis: {
      gridcolor: grid,
      zerolinecolor: grid,
      linecolor: grid,
      tickfont: { color: muted, size: 11 },
      title: { font: { color: muted, size: 11.5 } },
    },
    yaxis: {
      gridcolor: grid,
      zerolinecolor: grid,
      linecolor: grid,
      tickfont: { color: muted, size: 11 },
      title: { font: { color: muted, size: 11.5 } },
    },
    legend: {
      orientation: 'h',
      y: 1.08,
      x: 0,
      font: { size: 11.5, color: muted },
      bgcolor: 'rgba(0,0,0,0)',
    },
  };
}

export const PLOT_CONFIG: PlotConfig = {
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'],
};
