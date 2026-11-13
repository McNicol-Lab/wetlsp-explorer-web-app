/** Class cover from full-resolution labels: per year and for the consensus. */
import { useMemo, useRef, useState } from 'react';
import { FileDown } from 'lucide-react';
import { FigureMenu } from '@/components/FigureMenu';
import { PlotlyChart, dataUrlToBlob, type PlotlyHandle } from '@/components/PlotlyChart';
import { Segmented, StatTile } from '@/components/ui';
import { copyImage } from '@/lib/figure';
import { downloadBlob, exportBackground, timestampedName } from '@/lib/export';
import { STATUS } from '@/lib/phenoclass/constants';
import type { CoverRow } from '@/lib/phenoclass/cover';
import { runSlug } from '@/lib/phenoclass/exports';
import type { RunManifest } from '@/lib/phenoclass/model';
import { classColor, STATUS_COLORS } from '@/lib/phenoclass/palette';
import { formatCount } from '@/lib/format';
import { usePhenoclassStore } from '@/store/usePhenoclassStore';
import { useDark } from '../shared';
import { formatArea, formatPct, runSubtitle, runTitle, Swatch } from './shared';
import { downloadCoverCsv, downloadCoverJson } from './exportActions';

/** Unclassified shares: neutral greys, distinct from every class hue. */
const EXCLUDED = '#8a939e';
const NEVER = '#c3c9d1';

export function CoverSection({ run }: { run: RunManifest }) {
  const dark = useDark();
  const hiddenList = usePhenoclassStore((s) => s.hidden[run.runId]);
  const hidden = useMemo(() => new Set(hiddenList ?? []), [hiddenList]);
  const toggleClass = usePhenoclassStore((s) => s.toggleClass);
  const periods = [...run.years.map(String), ...(run.consensus ? ['consensus'] : [])];
  const [period, setPeriod] = useState<string>(run.consensus ? 'consensus' : String(run.years[0]));
  const chartRef = useRef<PlotlyHandle>(null);
  const k = run.model.kmeans.k;
  const consensusLabel = run.consensus?.policy.label ?? 'Consensus';
  const periodLabel = (p: string) => (p === 'consensus' ? consensusLabel : p);

  /** Everything as % of each period's footprint, so missing data is visible, never folded into a class. */
  const chart = useMemo(() => {
    const xs = periods.map(periodLabel);
    const rowsFor = (p: string): { rows: CoverRow[]; extras: Array<[string, number, string]>; footprint: number } => {
      if (p === 'consensus') {
        const c = run.consensus!.cover;
        return {
          rows: c.rows,
          footprint: c.footprintCells,
          extras: [
            ['Tie', c.ambiguousCells, STATUS_COLORS.ambiguous],
            ['Too few years', c.insufficientCells, STATUS_COLORS.insufficient],
            ['Never classified', c.noValidYearCells, NEVER],
          ],
        };
      }
      const a = run.annual.find((x) => String(x.year) === p)!.cover;
      const excluded = a.statusCounts[STATUS.QA_REJECTED] + a.statusCounts[STATUS.MISSING_CYCLE1] + a.statusCounts[STATUS.MISSING_CYCLE2];
      return { rows: a.rows, footprint: a.footprintCells, extras: [['Not classified', excluded, EXCLUDED]] };
    };
    const perPeriod = periods.map(rowsFor);
    const traces: object[] = [];
    for (let c = 1; c <= k; c++) {
      if (hidden.has(c)) continue;
      traces.push({
        type: 'bar',
        name: `Class ${c}`,
        x: xs,
        y: perPeriod.map((p) => p.rows[c - 1].pctFootprint ?? 0),
        customdata: perPeriod.map((p) => p.rows[c - 1].count),
        marker: { color: classColor(c, dark), line: { color: dark ? '#121821' : '#ffffff', width: 1 } },
        hovertemplate: `Class ${c} · %{x}<br>%{y:.1f}% of site<br>%{customdata:,} pixels<extra></extra>`,
      });
    }
    const extraNames = [...new Set(perPeriod.flatMap((p) => p.extras.map((e) => e[0])))];
    for (const name of extraNames) {
      const color = perPeriod.flatMap((p) => p.extras).find((e) => e[0] === name)![2];
      traces.push({
        type: 'bar',
        name,
        x: xs,
        y: perPeriod.map((p) => {
          const e = p.extras.find((x) => x[0] === name);
          return e && p.footprint ? (100 * e[1]) / p.footprint : 0;
        }),
        customdata: perPeriod.map((p) => p.extras.find((x) => x[0] === name)?.[1] ?? 0),
        marker: { color, line: { color: dark ? '#121821' : '#ffffff', width: 1 } },
        hovertemplate: `${name} · %{x}<br>%{y:.1f}% of site<br>%{customdata:,} pixels<extra></extra>`,
      });
    }
    return traces;
  }, [run, k, hidden, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(() => {
    const ink = dark ? '#98a3b3' : '#617069';
    const grid = dark ? '#212a36' : '#e3e6ec';
    return {
      barmode: 'stack',
      bargap: 0.35,
      margin: { l: 56, r: 12, t: 12, b: 40 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11.5, color: ink },
      legend: { orientation: 'h', y: -0.12, yanchor: 'top', x: 0, traceorder: 'normal' },
      xaxis: { type: 'category', gridcolor: grid },
      yaxis: { title: { text: '% of site' }, range: [0, 100.5], gridcolor: grid, ticksuffix: '%', zeroline: false },
      hoverlabel: { bgcolor: dark ? '#121821' : '#ffffff', bordercolor: grid, font: { color: dark ? '#e8ecf2' : '#23332d' } },
    };
  }, [dark]);

  const isConsensus = period === 'consensus';
  const annual = run.annual.find((a) => String(a.year) === period)?.cover;
  const cons = run.consensus?.cover;
  const rows = isConsensus ? cons!.rows : annual!.rows;
  const footprint = isConsensus ? cons!.footprintCells : annual!.footprintCells;
  const classified = isConsensus ? cons!.classifiedCells : annual!.classifiedCells;
  const cellArea = run.grid.cellAreaM2;

  const exportImage = async () => {
    const url = await chartRef.current!.toImage({
      title: `Class cover · ${runTitle(run)}`,
      subtitle: `${runSubtitle(run)} · grey = not classified`,
      background: exportBackground(),
      legendPosition: 'bottom',
    });
    return dataUrlToBlob(url);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="flex min-h-[420px] flex-col rounded-[11px] border border-[var(--border)]">
        <header className="flex items-start justify-between gap-2 px-3 pt-2.5">
          <div>
            <h3 className="text-[13.5px] font-semibold">Class share by year</h3>
            <p className="text-[12px] text-[var(--text-muted)]">How much of the site each class covers. Grey parts weren&apos;t classified.</p>
          </div>
          <FigureMenu
            items={[
              { label: 'Cover table (CSV)', icon: <FileDown size={13} />, run: () => downloadCoverCsv(run) },
              { label: 'Cover object (JSON)', icon: <FileDown size={13} />, run: () => downloadCoverJson(run) },
            ]}
            actions={{
              save: async () => downloadBlob(await exportImage(), timestampedName([runSlug(run), 'class-cover'], 'png')),
              copy: () => copyImage(exportImage()),
              caption: () =>
                `Share of ${run.siteId} in each of ${k} classes, by year${run.consensus ? ` and for the ${consensusLabel.toLowerCase()}` : ''}. Grey parts weren't classified.`,
            }}
          />
        </header>
        <div className="min-h-0 flex-1 px-1 pb-1">
          <PlotlyChart ref={chartRef} data={chart as never} layout={layout as never} config={{ displayModeBar: false, responsive: true } as never} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented size="sm" value={period} onChange={setPeriod} options={periods.map((p) => ({ value: p, label: periodLabel(p) }))} />
          {cellArea !== null ? (
            <span className="text-[11.5px] text-[var(--text-faint)]">{cellArea} m² per pixel</span>
          ) : (
            <span className="text-[11.5px] text-[var(--text-faint)]">Pixel counts only (map isn&apos;t in metres)</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 2xl:grid-cols-4">
          <StatTile label="Site" value={formatCount(footprint)} hint={cellArea !== null ? formatArea(footprint * cellArea) : 'pixels'} />
          <StatTile label="Classified" value={formatPct((100 * classified) / Math.max(1, footprint))} hint={`${formatCount(classified)} pixels`} />
          {isConsensus ? (
            <>
              <StatTile label="Ties" value={formatCount(cons!.ambiguousCells)} hint="no single winner" />
              <StatTile label="Too few years" value={formatCount(cons!.insufficientCells)} hint={`under ${run.consensus!.policy.minValidYears} years`} />
            </>
          ) : (
            <>
              <StatTile label="QA 4" value={formatCount(annual!.statusCounts[STATUS.QA_REJECTED])} hint="low quality" />
              <StatTile
                label="Missing"
                value={formatCount(annual!.statusCounts[STATUS.MISSING_CYCLE1] + annual!.statusCounts[STATUS.MISSING_CYCLE2])}
                hint="a value is missing"
              />
            </>
          )}
        </div>
        <div className="overflow-x-auto rounded-[11px] border border-[var(--border)]">
          <table className="w-full text-[12.5px] tabular-nums">
            <caption className="sr-only">Class cover for {periodLabel(period)}</caption>
            <thead className="bg-[var(--bg-sunken)] text-[11.5px] text-[var(--text-faint)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Class</th>
                <th className="px-3 py-2 text-right font-medium">Pixels</th>
                <th className="px-3 py-2 text-right font-medium" title="Out of the pixels that got a class">% classified</th>
                <th className="px-3 py-2 text-right font-medium" title="Out of every pixel in the site">% of site</th>
                <th className="px-3 py-2 text-right font-medium">Area</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.classId} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5">
                    <button className="inline-flex items-center gap-2 hover:underline" onClick={() => toggleClass(run.runId, r.classId)} title="Show or hide this class">
                      <Swatch color={classColor(r.classId, dark)} hidden={hidden.has(r.classId)} />
                      Class {r.classId}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatCount(r.count)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatPct(r.pctClassified)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatPct(r.pctFootprint)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatArea(r.areaM2)}</td>
                </tr>
              ))}
              {(isConsensus
                ? ([
                    ['Tie', cons!.ambiguousCells],
                    ['Too few years', cons!.insufficientCells],
                    ['Never classified', cons!.noValidYearCells],
                  ] as Array<[string, number]>)
                : ([
                    ['Low quality (QA 4)', annual!.statusCounts[STATUS.QA_REJECTED]],
                    ['Missing a cycle 1 value', annual!.statusCounts[STATUS.MISSING_CYCLE1]],
                    ['Missing a cycle 2 value', annual!.statusCounts[STATUS.MISSING_CYCLE2]],
                  ] as Array<[string, number]>)
              ).map(([label, n]) => (
                <tr key={label} className="border-t border-[var(--border)] text-[var(--text-muted)]">
                  <td className="px-3 py-1.5">{label}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatCount(n)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">—</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{formatPct((100 * n) / Math.max(1, footprint))}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">{cellArea !== null ? formatArea(n * cellArea) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">
          Counted on every pixel. The site is every pixel with a QA value{isConsensus ? ' in any year' : ''}.
          {!isConsensus && annual && annual.statusCounts[STATUS.NO_PRODUCT] > 0 ? ` ${formatCount(annual.statusCounts[STATUS.NO_PRODUCT])} pixels have no data.` : ''}
        </p>
      </section>
    </div>
  );
}
