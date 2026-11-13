/**
 * Phenology Classes: site-specific k-means classes of WetLSP phenometrics.
 * Build model → annual maps & consensus → class cover → synthetic waveforms.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, Eye, FileDown, FileJson, Shapes, Trash2, Upload } from 'lucide-react';
import { Button, Card, Chip, EmptyState, Segmented } from '@/components/ui';
import { useActiveSite } from '@/store/useAppStore';
import { runStaleness, usePhenoclassStore, type PhenoclassSection } from '@/store/usePhenoclassStore';
import type { RunManifest } from '@/lib/phenoclass/model';
import { validateModel } from '@/lib/phenoclass/model';
import { classColor } from '@/lib/phenoclass/palette';
import { formatCount, relativeTime } from '@/lib/format';
import { useDark } from '../shared';
import { BuildModelSection, Notice } from './BuildModelSection';
import { MapsSection } from './MapsSection';
import { CoverSection } from './CoverSection';
import { WaveformsSection } from './WaveformsSection';
import { JobPanel } from './JobPanel';
import { Swatch, useRunArrays } from './shared';
import {
  downloadAnnualTif,
  downloadBundle,
  downloadConsensusTif,
  downloadCoverCsv,
  downloadCoverJson,
  downloadManifestJson,
  downloadModelJson,
  downloadSummaryCsv,
  geotiffBlocker,
} from './exportActions';

const SECTIONS: Array<{ value: PhenoclassSection; label: string }> = [
  { value: 'build', label: 'Build model' },
  { value: 'maps', label: 'Annual maps & consensus' },
  { value: 'cover', label: 'Class cover' },
  { value: 'waveforms', label: 'Waveforms' },
];

/** The site's saved runs, loaded once per site, and the selected one. */
function useActiveRun(siteId: string | null): { runs: RunManifest[] | undefined; run: RunManifest | null } {
  const runs = usePhenoclassStore((s) => (siteId ? s.runs[siteId] : undefined));
  const activeId = usePhenoclassStore((s) => (siteId ? s.activeRun[siteId] : null));
  const loadRuns = usePhenoclassStore((s) => s.loadRuns);
  useEffect(() => {
    if (siteId && runs === undefined) void loadRuns(siteId);
  }, [siteId, runs, loadRuns]);
  const run = useMemo(() => runs?.find((r) => r.runId === activeId) ?? null, [runs, activeId]);
  return { runs, run };
}

export function PhenologyClassesView() {
  const site = useActiveSite();
  const siteId = site?.manifest.siteId ?? null;
  const section = usePhenoclassStore((s) => s.section);
  const setSection = usePhenoclassStore((s) => s.setSection);
  const job = usePhenoclassStore((s) => s.job);
  const { runs, run } = useActiveRun(siteId);

  if (!site) {
    return (
      <div className="card h-full">
        <EmptyState icon={<Shapes size={26} />} title="No site open" body="Import a site with WetLSP NetCDF files." />
      </div>
    );
  }
  if (site.manifest.netcdf.length === 0) {
    return (
      <div className="card h-full">
        <EmptyState
          icon={<Shapes size={26} />}
          title="No NetCDF files"
          body="This site has no yearly WetLSP NetCDF files, so it can't be classified."
        />
      </div>
    );
  }

  const stale = run ? runStaleness(run, site.manifest) : null;
  const needsRun = section !== 'build' && !run;

  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <Segmented size="sm" value={section} onChange={setSection} options={SECTIONS} />
        <div className="flex min-w-0 items-center gap-1.5">
          {run && (
            <>
              <Chip tone="accent" title={`Model ${run.model.modelId}`}>
                k = {run.model.kmeans.k} · {run.years.join(', ')}
              </Chip>
              {run.model.training?.sampled && <Chip title="The model was fit on a sample. Every pixel was classified.">sampled fit</Chip>}
              {run.kind === 'applied' && <Chip>saved model</Chip>}
              {stale && (
                <Chip tone="warning" title={stale}>
                  stale
                </Chip>
              )}
            </>
          )}
        </div>
      </div>

      {job && section !== 'build' && (
        <div className="border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2">
          <JobPanel compact />
        </div>
      )}
      {run && stale && section !== 'build' && (
        <div className="px-4 pt-3">
          <Notice tone="warning">
            {stale} Train again to update. GeoTIFF export is off until then.
          </Notice>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {section === 'build' ? (
          <BuildModelSection manifest={site.manifest} />
        ) : runs === undefined ? (
          <div className="p-6 text-[12.5px] text-[var(--text-muted)]">Loading…</div>
        ) : needsRun ? (
          <EmptyState
            icon={<Shapes size={26} />}
            title="No analysis yet"
            body="Train a model first. Every run is saved here."
            action={
              <Button variant="primary" onClick={() => setSection('build')}>
                Build a model
              </Button>
            }
          />
        ) : section === 'maps' ? (
          <MapsSection key={run!.runId} run={run!} stale={stale} />
        ) : section === 'cover' ? (
          <CoverSection key={run!.runId} run={run!} />
        ) : (
          <WaveformsSection key={run!.runId} run={run!} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- inspector */

export function PhenologyClassesInspector() {
  const site = useActiveSite();
  const siteId = site?.manifest.siteId ?? null;
  const { runs, run } = useActiveRun(siteId);
  const selectRun = usePhenoclassStore((s) => s.selectRun);
  const deleteRun = usePhenoclassStore((s) => s.deleteRun);
  const job = usePhenoclassStore((s) => s.job);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!site || !siteId) return <EmptyState compact title="No site loaded" />;

  return (
    <div className="space-y-3">
      <Card title="Saved runs" subtitle={runs?.length ? `${runs.length} for ${siteId}` : `None yet for ${siteId}`}>
        {runs === undefined ? (
          <div className="skeleton h-16 w-full" />
        ) : runs.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-muted)]">Runs you train show up here.</p>
        ) : (
          <ul className="-mx-1 space-y-0.5">
            {runs.map((r) => {
              const active = r.runId === run?.runId;
              const stale = runStaleness(r, site.manifest);
              return (
                <li key={r.runId} className={active ? 'rounded-[9px] bg-[var(--bg-hover)]' : 'rounded-[9px] hover:bg-[var(--bg-hover)]'}>
                  <div className="flex items-start gap-1">
                    <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => selectRun(siteId, r.runId)} aria-current={active}>
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        k = {r.model.kmeans.k} · {r.years.join(', ')}
                        {stale && <Chip tone="warning">stale</Chip>}
                      </span>
                      <span className="block text-[11px] text-[var(--text-muted)]">
                        {relativeTime(Date.parse(r.createdAt))} · {r.kind === 'applied' ? 'saved model' : r.model.training?.sampled ? 'sampled fit' : 'full fit'}
                      </span>
                    </button>
                    {confirming === r.runId ? (
                      <Button size="sm" variant="danger" className="mr-1 mt-1" onClick={() => void deleteRun(siteId, r.runId).then(() => setConfirming(null))}>
                        Delete
                      </Button>
                    ) : (
                      <button
                        className="mr-1 mt-1 rounded-md p-1.5 text-[var(--text-faint)] hover:bg-[var(--bg-elevated)] hover:text-red-500"
                        onClick={() => setConfirming(r.runId)}
                        aria-label={`Delete run from ${r.createdAt}`}
                        title="Delete this run"
                        disabled={Boolean(job)}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {run && <ClassesCard run={run} />}
      {run && <ExportCard run={run} stale={runStaleness(run, site.manifest)} />}
      <ImportModelCard />
    </div>
  );
}

function ClassesCard({ run }: { run: RunManifest }) {
  const dark = useDark();
  const hiddenList = usePhenoclassStore((s) => s.hidden[run.runId]);
  const hidden = new Set(hiddenList ?? []);
  const { toggleClass, isolateClass, showAllClasses } = usePhenoclassStore.getState();
  const k = run.model.kmeans.k;
  return (
    <Card
      title="Classes"
      subtitle="Click to hide. Double-click to show one."
      actions={
        hidden.size > 0 ? (
          <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => showAllClasses(run.runId)}>
            Show all
          </Button>
        ) : undefined
      }
    >
      <ul className="-mx-1 space-y-0.5">
        {run.summaries.pooled.map((s) => (
          <li key={s.classId}>
            <button
              onClick={(e) => (e.altKey || e.metaKey ? isolateClass(run.runId, s.classId, k) : toggleClass(run.runId, s.classId))}
              onDoubleClick={() => isolateClass(run.runId, s.classId, k)}
              aria-pressed={!hidden.has(s.classId)}
              title="Click to hide. Double-click to show only this one."
              className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left hover:bg-[var(--bg-hover)]"
            >
              <Swatch color={classColor(s.classId, dark)} hidden={hidden.has(s.classId)} />
              <span className={hidden.has(s.classId) ? 'flex-1 text-[12.5px] text-[var(--text-faint)] line-through' : 'flex-1 text-[12.5px]'}>
                Class {s.classId}
                {(s.cycle2Fraction ?? 0) >= 0.5 && <span className="ml-1 text-[11px] text-[var(--text-faint)]">2 seasons</span>}
              </span>
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{formatCount(s.count)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">
        Pixel counts add up all {run.years.length} years.
      </p>
    </Card>
  );
}

function ExportCard({ run, stale }: { run: RunManifest; stale: string | null }) {
  const arrays = useRunArrays(run);
  const blocker = geotiffBlocker(run, stale);
  const ready = Boolean(arrays.data);
  const item = (label: string, onClick: () => void, opts: { disabled?: boolean; title?: string; icon?: ReactNode } = {}) => (
    <button
      onClick={onClick}
      disabled={opts.disabled}
      title={opts.title}
      className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-45"
    >
      {opts.icon ?? <FileDown size={13} className="text-[var(--text-faint)]" />}
      {label}
    </button>
  );
  return (
    <Card title="Export" subtitle="Full resolution">
      <div className="-mx-1 space-y-0.5">
        {item('Everything (ZIP)', () => void downloadBundle(run, arrays.data!), {
          disabled: !ready || Boolean(blocker),
          title: blocker ?? undefined,
          icon: <Archive size={13} className="text-[var(--accent)]" />,
        })}
        <div className="px-2 pb-0.5 pt-2 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">GeoTIFF</div>
        {run.years.map((y) => (
          <div key={y}>{item(`Classes ${y}`, () => void downloadAnnualTif(run, arrays.data!, y), { disabled: !ready || Boolean(blocker), title: blocker ?? undefined })}</div>
        ))}
        {run.consensus && (
          <>
            {item('Consensus class', () => void downloadConsensusTif(run, arrays.data!, 'class'), { disabled: !ready || Boolean(blocker), title: blocker ?? undefined })}
            {item('Consensus valid years', () => void downloadConsensusTif(run, arrays.data!, 'valid'), { disabled: !ready || Boolean(blocker), title: blocker ?? undefined })}
            {item('Consensus agreement', () => void downloadConsensusTif(run, arrays.data!, 'agreement'), { disabled: !ready || Boolean(blocker), title: blocker ?? undefined })}
          </>
        )}
        <div className="px-2 pb-0.5 pt-2 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Tables & model</div>
        {item('Class cover (CSV)', () => void downloadCoverCsv(run))}
        {item('Class cover (JSON)', () => void downloadCoverJson(run))}
        {item('Class medians (CSV)', () => void downloadSummaryCsv(run))}
        {item('Model (JSON)', () => void downloadModelJson(run), { icon: <FileJson size={13} className="text-[var(--text-faint)]" /> })}
        {item('Run details (JSON)', () => void downloadManifestJson(run), { icon: <FileJson size={13} className="text-[var(--text-faint)]" /> })}
      </div>
      {blocker && <p className="mt-2 text-[11px] leading-snug text-amber-700 dark:text-amber-300">{blocker}</p>}
      <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">For images, use the PNG button on each screen.</p>
    </Card>
  );
}

function ImportModelCard() {
  const site = useActiveSite();
  const job = usePhenoclassStore((s) => s.job);
  const train = usePhenoclassStore((s) => s.train);
  const config = usePhenoclassStore((s) => (site ? s.config[site.manifest.siteId] : undefined));
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  if (!site) return null;
  const years = config?.years ?? site.manifest.netcdf.map((n) => n.year).slice(-4);

  const onFile = async (file: File) => {
    setError(null);
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      // Checked here for a quick answer, and again in the worker before use.
      const model = validateModel(raw, site.manifest.siteId);
      await train(site.manifest, { years, k: model.kmeans.k, sampleSize: 0 }, raw);
    } catch (err) {
      setError(err instanceof SyntaxError ? "That file isn't valid JSON." : err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card title="Apply a saved model" subtitle="Reuse a model.json on this site">
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        Runs the saved model on {years.join(', ')} without retraining. The file is checked first.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
      <Button size="sm" className="mt-2" icon={<Upload size={13} />} disabled={Boolean(job)} onClick={() => inputRef.current?.click()}>
        Choose model.json
      </Button>
      {error && <p className="mt-2 text-[11.5px] leading-snug text-red-600 dark:text-red-400">{error}</p>}
    </Card>
  );
}

