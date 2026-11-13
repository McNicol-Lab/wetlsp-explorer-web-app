/** Annual class maps and the multi-year consensus, at full resolution. */
import { useMemo, useRef, useState } from 'react';
import { FileDown, Maximize2 } from 'lucide-react';
import { FigureMenu, type FigureMenuItem } from '@/components/FigureMenu';
import { IDENTITY_VIEW, RasterFigure, type FigureView, type Probe, type RasterFigureHandle } from '@/components/RasterFigure';
import { Button, Chip, EmptyState, Segmented } from '@/components/ui';
import { canvasToBlob, copyImage } from '@/lib/figure';
import { downloadBlob, exportBackground, timestampedName } from '@/lib/export';
import { CODE } from '@/lib/phenoclass/constants';
import type { RunManifest } from '@/lib/phenoclass/model';
import { classLabel } from '@/lib/phenoclass/palette';
import { runSlug, type RunArrays } from '@/lib/phenoclass/exports';
import type { RasterSlice } from '@/lib/types';
import { formatCount } from '@/lib/format';
import { usePhenoclassStore } from '@/store/usePhenoclassStore';
import { ErrorPanel, LoadingPanel, useDark } from '../shared';
import {
  BLUE_RAMP,
  classFigureCard,
  classScale,
  displaySlice,
  legendItems,
  runSubtitle,
  runTitle,
  sequentialScale,
  Swatch,
  useRunArrays,
} from './shared';
import { downloadAnnualTif, downloadConsensusTif, geotiffBlocker } from './exportActions';

type Mode = 'annual' | 'consensus';
type ConsensusLayer = 'class' | 'agreement' | 'valid';

interface Panel {
  key: string;
  label: string;
  slice: RasterSlice;
  kind: 'class' | 'agreement' | 'valid';
  year?: number;
}

export function MapsSection({ run, stale }: { run: RunManifest; stale: string | null }) {
  const dark = useDark();
  const arrays = useRunArrays(run);
  const hiddenList = usePhenoclassStore((s) => s.hidden[run.runId]);
  const hidden = useMemo(() => new Set(hiddenList ?? []), [hiddenList]);
  const { toggleClass, isolateClass } = usePhenoclassStore.getState();
  const [mode, setMode] = useState<Mode>('annual');
  const [layer, setLayer] = useState<ConsensusLayer>('class');
  const [years, setYears] = useState<number[]>(() => run.years.slice(0, 4));
  const [view, setView] = useState<FigureView>(IDENTITY_VIEW);
  const [probe, setProbe] = useState<(Probe & { panel: number }) | null>(null);
  const refs = useRef<Array<RasterFigureHandle | null>>([]);
  const k = run.model.kmeans.k;
  const effectiveMode: Mode = mode === 'consensus' && !run.consensus ? 'annual' : mode;
  const shownYears = years.filter((y) => run.years.includes(y));

  const panels = useMemo<Panel[]>(() => {
    const a = arrays.data;
    if (!a) return [];
    if (effectiveMode === 'annual') {
      return shownYears.map((y) => ({ key: `y${y}`, label: String(y), year: y, kind: 'class', slice: displaySlice(`classes ${y}`, a.labels[String(y)], run, { codes: true }) }));
    }
    const c = a.consensus!;
    if (layer === 'class') return [{ key: 'cc', label: run.consensus!.policy.label, kind: 'class', slice: displaySlice('consensus class', c.cls, run, { codes: true }) }];
    if (layer === 'agreement') return [{ key: 'ca', label: 'Agreement', kind: 'agreement', slice: displaySlice('agreement', c.agreement, run, { codes: false }) }];
    return [{ key: 'cv', label: 'Valid years', kind: 'valid', slice: displaySlice('valid years', c.validYears, run, { codes: true, nodataAsNaN: CODE.OUTSIDE }) }];
  }, [arrays.data, effectiveMode, layer, shownYears.join(','), run]); // eslint-disable-line react-hooks/exhaustive-deps

  const scales = useMemo(
    () => ({
      class: classScale(k, hidden, dark),
      agreement: sequentialScale([0, 1], dark),
      valid: sequentialScale([0, run.years.length], dark, run.years.length + 1),
    }),
    [k, hidden, dark, run.years.length],
  );

  if (arrays.error) return <ErrorPanel message={arrays.error} onRetry={arrays.reload} />;
  if (arrays.loading || !arrays.data) return <LoadingPanel progress={arrays.progress} label="Reading saved maps" />;

  const downsample = panels[0]?.slice.downsample ?? 1;
  const blocker = geotiffBlocker(run, stale);
  const consensusTitle = run.consensus?.policy.label ?? 'Consensus';

  const renderFigure = () => {
    const canvases = panels.map((_, i) => refs.current[i]?.canvas()).filter((c): c is HTMLCanvasElement => Boolean(c));
    const isClass = panels[0]?.kind === 'class';
    const notes = [
      'Classes group pixels with similar seasons. They are not vegetation types.',
      ...(downsample > 1 ? [`Shown at 1/${downsample} resolution. Exports use every pixel.`] : []),
      ...(run.model.training?.sampled ? [`Model fit on ${formatCount(run.model.training.sampleSize)} sampled pixel-years. Every usable pixel in every selected year is classified.`] : []),
      ...(effectiveMode === 'consensus' ? [`Consensus: missing years don't vote, ${run.consensus!.policy.minValidYears} or more years needed, ties marked.`] : []),
    ];
    return classFigureCard(canvases, {
      title: `${effectiveMode === 'annual' ? 'Phenology classes' : consensusTitle} · ${runTitle(run)}`,
      subtitle: runSubtitle(run),
      notes,
      panelLabels: panels.map((p) => p.label),
      cols: Math.min(2, panels.length),
      background: exportBackground(),
      legend: legendItems(run, document.documentElement.classList.contains('dark'), { consensus: effectiveMode === 'consensus' }),
      hidden,
      ramp: isClass
        ? undefined
        : panels[0]?.kind === 'agreement'
          ? { stops: BLUE_RAMP, lo: '0', hi: '1', label: 'Share of years that agree' }
          : { stops: BLUE_RAMP, lo: '0', hi: String(run.years.length), label: 'Years with a class' },
    });
  };

  const tifItems: FigureMenuItem[] =
    effectiveMode === 'annual'
      ? shownYears.map((y) => ({
          label: `GeoTIFF: ${y}`,
          icon: <FileDown size={13} />,
          disabled: Boolean(blocker),
          run: () => downloadAnnualTif(run, arrays.data!, y),
        }))
      : (['class', 'valid', 'agreement'] as const).map((w) => ({
          label: `GeoTIFF: consensus ${w === 'valid' ? 'valid years' : w}`,
          icon: <FileDown size={13} />,
          disabled: Boolean(blocker),
          run: () => downloadConsensusTif(run, arrays.data!, w),
        }));

  const probeText = describeProbe(probe, panels, arrays.data, run);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={effectiveMode}
            onChange={setMode}
            options={[
              { value: 'annual', label: 'Annual' },
              { value: 'consensus', label: run.consensus ? consensusTitle : 'Consensus (needs 3+ years)', title: run.consensusUnavailable ?? undefined },
            ]}
          />
          {effectiveMode === 'annual' ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Years to compare">
              {run.years.map((y) => {
                const on = years.includes(y);
                return (
                  <button
                    key={y}
                    aria-pressed={on}
                    onClick={() => setYears(on ? (years.length > 1 ? years.filter((v) => v !== y) : years) : [...years, y].sort((a, b) => a - b).slice(-4))}
                    className={
                      on
                        ? 'chip border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-[var(--accent)]'
                        : 'chip hover:bg-[var(--bg-hover)]'
                    }
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          ) : (
            <Segmented
              size="sm"
              value={layer}
              onChange={setLayer}
              options={[
                { value: 'class', label: 'Class' },
                { value: 'agreement', label: 'Agreement' },
                { value: 'valid', label: 'Valid years' },
              ]}
            />
          )}
          {downsample > 1 && <Chip title="Only the screen view is reduced. Stats and exports use every pixel.">Shown at 1/{downsample} resolution</Chip>}
          {!run.consensus && run.consensusUnavailable && mode === 'consensus' && <Chip tone="warning">{run.consensusUnavailable}</Chip>}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" icon={<Maximize2 size={13} />} onClick={() => setView(IDENTITY_VIEW)}>
            Reset zoom
          </Button>
          <FigureMenu
            disabled={panels.length === 0}
            items={tifItems}
            actions={{
              save: async () => downloadBlob(await canvasToBlob(renderFigure()), timestampedName([runSlug(run), effectiveMode === 'annual' ? 'classes' : `consensus-${layer}`], 'png')),
              copy: () => copyImage(canvasToBlob(renderFigure())),
              caption: () =>
                `${effectiveMode === 'annual' ? `Phenology classes, ${shownYears.join(', ')}` : `${consensusTitle} (${layer})`}, ${run.siteId}. ${k} k-means classes from one model for all years. Classes group similar seasons and are not vegetation types.`,
            }}
          />
        </div>
      </div>

      {panels.length === 0 ? (
        <EmptyState title="Pick a year" body="Choose at least one year to show." />
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-2 p-2"
          style={{
            gridTemplateColumns: `repeat(${panels.length <= 1 ? 1 : 2}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${panels.length <= 2 ? 1 : 2}, minmax(0, 1fr))`,
          }}
        >
          {panels.map((p, i) => (
            <div key={p.key} className="relative min-h-0 overflow-hidden rounded-[11px] border border-[var(--border)] bg-[var(--bg-sunken)]">
              <span className="chip pointer-events-none absolute left-[76px] top-[34px] z-10 bg-[var(--bg-elevated)] font-medium text-[var(--text)]">{p.label}</span>
              <RasterFigure
                ref={(r) => {
                  refs.current[i] = r;
                }}
                slice={p.slice}
                scale={scales[p.kind]}
                view={view}
                onView={setView}
                onProbe={(pr) => setProbe(pr ? { ...pr, panel: i } : null)}
                dark={dark}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] px-3 py-2">
        {panels[0]?.kind === 'class' ? (
          legendItems(run, dark, { consensus: effectiveMode === 'consensus' }).map((item) =>
            item.classId ? (
              <button
                key={item.key}
                onClick={(e) => (e.altKey || e.metaKey ? isolateClass(run.runId, item.classId!, k) : toggleClass(run.runId, item.classId!))}
                onDoubleClick={() => isolateClass(run.runId, item.classId!, k)}
                aria-pressed={!hidden.has(item.classId)}
                title="Click to hide. Double-click to show only this one."
                className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] hover:bg-[var(--bg-hover)]"
              >
                <Swatch color={item.color} hidden={hidden.has(item.classId)} />
                <span className={hidden.has(item.classId) ? 'text-[var(--text-faint)] line-through' : ''}>{item.label}</span>
              </button>
            ) : (
              <span key={item.key} className="inline-flex items-center gap-1.5 px-1 text-[12px] text-[var(--text-muted)]">
                <Swatch color={item.color} />
                {item.label}
              </span>
            ),
          )
        ) : (
          <span className="inline-flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span className="inline-block h-2.5 w-40 rounded-sm" style={{ background: `linear-gradient(90deg, ${(dark ? [...BLUE_RAMP].reverse() : BLUE_RAMP).join(',')})` }} />
            {panels[0]?.kind === 'agreement' ? 'Share of years that agree (0 to 1)' : `Years with a class (0 to ${run.years.length})`}
          </span>
        )}
        <span role="status" className="ml-auto text-[12px] tabular-nums text-[var(--text-muted)]">
          {probeText}
        </span>
      </div>
    </div>
  );
}

function describeProbe(probe: (Probe & { panel: number }) | null, panels: Panel[], arrays: RunArrays | null, run: RunManifest): string {
  if (!probe || !arrays) return 'Hover the map to see a cell';
  const p = panels[probe.panel];
  if (!p) return '';
  const where = probe.projected ? ` · ${Math.round(probe.projected[0]).toLocaleString('en-US')} E, ${Math.round(probe.projected[1]).toLocaleString('en-US')} N` : '';
  if (p.slice.downsample > 1) return `${p.label}: ${p.kind === 'class' ? classLabel(probe.value) : probe.value.toFixed(2)} (reduced view)${where}`;
  const idx = probe.row * run.grid.width + probe.col;
  if (p.year !== undefined) {
    const v = arrays.labels[String(p.year)][idx];
    const others = run.years.map((y) => `${y}: ${arrays.labels[String(y)][idx] || 'none'}`).join(', ');
    return `${p.year}: ${classLabel(v)} (${others})${where}`;
  }
  const c = arrays.consensus!;
  const vy = c.validYears[idx];
  if (vy === CODE.OUTSIDE) return `Outside the site${where}`;
  const ag = c.agreement[idx];
  return `${classLabel(c.cls[idx])} · ${vy} year${vy === 1 ? '' : 's'} with a class${Number.isFinite(ag) ? ` · ${(ag * 100).toFixed(0)}% agree` : ''}${where}`;
}
