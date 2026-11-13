/** Synthetic class waveforms, reconstructed from class-median phenometrics. */
import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileDown } from 'lucide-react';
import { FigureMenu } from '@/components/FigureMenu';
import { PlotlyChart, dataUrlToBlob, type PlotlyHandle } from '@/components/PlotlyChart';
import { Segmented, Toggle } from '@/components/ui';
import { copyImage } from '@/lib/figure';
import { downloadBlob, exportBackground, timestampedName } from '@/lib/export';
import { runSlug } from '@/lib/phenoclass/exports';
import type { RunManifest } from '@/lib/phenoclass/model';
import { classColor } from '@/lib/phenoclass/palette';
import type { Waveform } from '@/lib/phenoclass/waveform';
import { formatCount } from '@/lib/format';
import { usePhenoclassStore } from '@/store/usePhenoclassStore';
import { useDark } from '../shared';
import { Notice } from './BuildModelSection';
import { runSubtitle, runTitle, Swatch } from './shared';
import { downloadSummaryCsv, downloadWaveformCsv } from './exportActions';

type Layout = 'overlay' | 'grid';

export function WaveformsSection({ run }: { run: RunManifest }) {
  const dark = useDark();
  const hiddenList = usePhenoclassStore((s) => s.hidden[run.runId]);
  const hidden = useMemo(() => new Set(hiddenList ?? []), [hiddenList]);
  const toggleClass = usePhenoclassStore((s) => s.toggleClass);
  const [population, setPopulation] = useState('pooled');
  const [layoutMode, setLayoutMode] = useState<Layout>('overlay');
  const [showFlagged, setShowFlagged] = useState(false);
  const chartRef = useRef<PlotlyHandle>(null);
  const k = run.model.kmeans.k;

  const waves: Waveform[] = useMemo(
    () => (population === 'pooled' ? run.waveforms.pooled : (run.waveforms.annual[population] ?? [])),
    [run, population],
  );
  const summaries = useMemo(
    () => (population === 'pooled' ? run.summaries.pooled : (run.summaries.annual[population] ?? [])),
    [run, population],
  );
  const drawable = useMemo(
    () => waves.filter((w) => !hidden.has(w.classId) && w.evi.length > 0 && (w.status === 'ok' || showFlagged)),
    [waves, hidden, showFlagged],
  );

  const data = useMemo(() => {
    return drawable.map((w, i) => {
      const flagged = w.status !== 'ok';
      const s = summaries.find((x) => x.classId === w.classId);
      return {
        type: 'scatter',
        mode: 'lines',
        name: `Class ${w.classId}${w.bimodal ? ' (2 seasons)' : ''}${flagged ? ' (flagged)' : ''}`,
        x: w.day,
        y: w.evi,
        line: { color: classColor(w.classId, dark), width: 2, dash: flagged ? 'dot' : w.bimodal ? 'dash' : 'solid' },
        hovertemplate: `Class ${w.classId} · day %{x}<br>EVI %{y:.3f}${s ? `<br>${formatCount(s.count)} pixels` : ''}<extra></extra>`,
        ...(layoutMode === 'grid' ? { xaxis: i === 0 ? 'x' : `x${i + 1}`, yaxis: i === 0 ? 'y' : `y${i + 1}`, showlegend: false } : {}),
      };
    });
  }, [drawable, dark, layoutMode, summaries]);

  const layout = useMemo(() => {
    const ink = dark ? '#98a3b3' : '#617069';
    const grid = dark ? '#212a36' : '#e3e6ec';
    const base = {
      margin: { l: 56, r: 16, t: layoutMode === 'grid' ? 36 : 28, b: 44 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11.5, color: ink },
      hovermode: layoutMode === 'overlay' ? 'x unified' : 'closest',
      hoverlabel: { bgcolor: dark ? '#121821' : '#ffffff', bordercolor: grid, font: { color: dark ? '#e8ecf2' : '#23332d' } },
      legend: { orientation: 'h', y: 1.1, x: 0 },
    };
    if (layoutMode === 'overlay') {
      return {
        ...base,
        xaxis: { title: { text: 'Days since green-up' }, range: [0, 364], dtick: 30, gridcolor: grid, zeroline: false },
        yaxis: { title: { text: 'EVI (modelled)' }, gridcolor: grid, zeroline: false },
      };
    }
    const n = drawable.length;
    const cols = Math.min(3, Math.max(1, n));
    const rows = Math.ceil(n / cols);
    const out: Record<string, unknown> = { ...base, grid: { rows, columns: cols, pattern: 'independent', xgap: 0.12, ygap: 0.28 }, annotations: [] as object[] };
    const allY = drawable.flatMap((w) => w.evi);
    const yr = allY.length ? [Math.min(...allY) - 0.02, Math.max(...allY) + 0.02] : [0, 1];
    drawable.forEach((w, i) => {
      const sfx = i === 0 ? '' : String(i + 1);
      out[`xaxis${sfx}`] = { range: [0, 364], dtick: 90, gridcolor: grid, zeroline: false, title: { text: i >= n - cols ? 'Days since green-up' : '' } };
      out[`yaxis${sfx}`] = { range: yr, gridcolor: grid, zeroline: false, title: { text: i % cols === 0 ? 'EVI (modelled)' : '' } };
      (out.annotations as object[]).push({
        text: `<b>Class ${w.classId}</b>${w.bimodal ? ' · 2 seasons' : ''}${w.status !== 'ok' ? ' · flagged' : ''}`,
        xref: `x${sfx} domain`,
        yref: `y${sfx} domain`,
        x: 0,
        y: 1.18,
        showarrow: false,
        xanchor: 'left',
        font: { size: 11.5, color: dark ? '#e8ecf2' : '#23332d' },
      });
    });
    return out;
  }, [dark, layoutMode, drawable]);

  const flagged = waves.filter((w) => w.status !== 'ok' && w.warnings.length);
  const popLabel = population === 'pooled' ? 'all years' : population;

  const exportImage = async () => {
    const url = await chartRef.current!.toImage({
      title: `Seasonal curves · ${runTitle(run)}`,
      subtitle: `Modelled from class medians (${popLabel}), not measured EVI · ${runSubtitle(run)}`,
      background: exportBackground(),
      height: layoutMode === 'grid' ? 260 * Math.ceil(drawable.length / 3) + 160 : 620,
    });
    return dataUrlToBlob(url);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="flex min-h-[460px] flex-col rounded-[11px] border border-[var(--border)]">
        <header className="flex flex-wrap items-start justify-between gap-2 px-3 pt-2.5">
          <div className="min-w-0">
            <h3 className="text-[13.5px] font-semibold">Typical seasonal curves</h3>
            <p className="text-[12px] text-[var(--text-muted)]">
              Modelled from each class&apos;s median values, so they show a typical season, not measured EVI. Day 0 is green-up.
            </p>
          </div>
          <FigureMenu
            disabled={drawable.length === 0}
            items={[
              { label: `Curves (CSV, ${popLabel})`, icon: <FileDown size={13} />, run: () => downloadWaveformCsv(run, population) },
              { label: 'Medians (CSV)', icon: <FileDown size={13} />, run: () => downloadSummaryCsv(run) },
            ]}
            actions={{
              save: async () => downloadBlob(await exportImage(), timestampedName([runSlug(run), 'waveforms', population], 'png')),
              copy: () => copyImage(exportImage()),
              caption: () =>
                `Typical seasonal EVI curves for ${k} phenology classes at ${run.siteId} (${popLabel}). Modelled from class medians, not measured EVI.`,
            }}
          />
        </header>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Segmented
            size="sm"
            value={population}
            onChange={setPopulation}
            options={[{ value: 'pooled', label: 'All years' }, ...run.years.map((y) => ({ value: String(y), label: String(y) }))]}
          />
          <Segmented
            size="sm"
            value={layoutMode}
            onChange={setLayoutMode}
            options={[
              { value: 'overlay', label: 'Overlay' },
              { value: 'grid', label: 'One per class' },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 px-1 pb-1">
          {drawable.length === 0 ? (
            <p className="p-6 text-center text-[12.5px] text-[var(--text-muted)]">Nothing to draw. Every class is hidden or flagged.</p>
          ) : (
            <PlotlyChart ref={chartRef} data={data as never} layout={layout as never} config={{ displayModeBar: false, responsive: true } as never} />
          )}
        </div>
      </section>

      <section className="space-y-3">
        {flagged.length > 0 && (
          <Notice tone="warning">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle size={13} /> {flagged.length} class{flagged.length === 1 ? '' : 'es'} can&apos;t be drawn reliably
            </div>
            <ul className="space-y-1">
              {flagged.map((w) => (
                <li key={w.classId}>
                  <b>Class {w.classId}</b>: {w.warnings.join(' ')}
                </li>
              ))}
            </ul>
            <div className="-mx-2 mt-1">
              <Toggle checked={showFlagged} onChange={setShowFlagged} label="Show them anyway (dotted)" hint="Their shape may be misleading" />
            </div>
          </Notice>
        )}
        <div className="overflow-x-auto rounded-[11px] border border-[var(--border)]">
          <table className="w-full text-[12px] tabular-nums">
            <caption className="px-3 pt-2 text-left text-[12.5px] font-medium">Median values · {popLabel}</caption>
            <thead className="text-[11px] text-[var(--text-faint)]">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Class</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Pixels in this class">Pixels</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Share with a second growing season">2 seasons</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Highest EVI">EVI max</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Rise from lowest to highest EVI">EVI rise</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Days from green-up to peak">Peak</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Days from green-up to the end of the season">End</th>
                <th className="px-2 py-1.5 text-right font-medium" title="Calendar day of green-up">Start day</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const m = s.medians;
                const evi = (v: number | null) => (v === null ? '—' : (v * run.waveforms.eviScale).toFixed(3));
                const day = (v: number | null) => (v === null ? '—' : String(Math.round(v)));
                return (
                  <tr key={s.classId} className="border-t border-[var(--border)]">
                    <td className="px-3 py-1.5">
                      <button className="inline-flex items-center gap-2 hover:underline" onClick={() => toggleClass(run.runId, s.classId)}>
                        <Swatch color={classColor(s.classId, dark)} hidden={hidden.has(s.classId)} />
                        {s.classId}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{formatCount(s.count)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{s.cycle2Fraction === null ? '—' : `${Math.round(s.cycle2Fraction * 100)} %`}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{evi(m.EVImax)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{evi(m.EVIamp)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{day(m.Peak)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{day(m.OGMn)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">{day(m.OGI_raw)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">
          Medians use every classified pixel. Dashed lines are classes with two growing seasons. Peak and end are days after green-up.
        </p>
      </section>
    </div>
  );
}
