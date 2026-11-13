/** Build model: choose years and k, check the data, run diagnostics, train. */
import { useEffect, useMemo, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Play, ScanSearch, Sigma } from 'lucide-react';
import { Button, Card, Field, Segmented, Select } from '@/components/ui';
import { PlotlyChart } from '@/components/PlotlyChart';
import { formatCount } from '@/lib/format';
import {
  DEFAULT_TRAINING_SAMPLE,
  K_MAX,
  K_MIN,
  KMEANS_DEFAULTS,
  MAX_UNSAMPLED_ROWS,
  STATUS,
  STATUS_LABELS,
  TRAINING_SAMPLE_CHOICES,
} from '@/lib/phenoclass/constants';
import { consensusAvailable } from '@/lib/phenoclass/consensus';
import type { SiteManifest } from '@/lib/types';
import type { Inspection } from '@/lib/phenoclass/pipeline';
import { defaultConfig, inputKey, usePhenoclassStore } from '@/store/usePhenoclassStore';
import { useDark } from '../shared';
import { JobPanel } from './JobPanel';

export function BuildModelSection({ manifest }: { manifest: SiteManifest }) {
  const siteId = manifest.siteId;
  const dark = useDark();
  const cfg = usePhenoclassStore((s) => s.config[siteId]) ?? defaultConfig(manifest);
  const setConfig = usePhenoclassStore((s) => s.setConfig);
  const inspection = usePhenoclassStore((s) => s.inspection[siteId]);
  const diagnostics = usePhenoclassStore((s) => s.diagnostics[siteId]);
  const job = usePhenoclassStore((s) => s.job);
  const error = usePhenoclassStore((s) => s.errors[siteId]);
  const { inspect, diagnose, train } = usePhenoclassStore.getState();

  const allYears = useMemo(() => manifest.netcdf.map((n) => n.year).sort((a, b) => a - b), [manifest.netcdf]);
  const key = inputKey(manifest, cfg.years);
  const checked = inspection?.key === key ? inspection.result : null;
  const diag = diagnostics?.key === key ? diagnostics.result : null;
  const busy = job !== null;

  // Check the selected years as soon as they change, so problems show before training.
  useEffect(() => {
    if (cfg.years.length === 0 || busy || inspection?.key === key) return;
    void inspect(manifest, cfg.years);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, busy]);

  const eligible = checked ? checked.years.reduce((n, y) => n + y.eligible, 0) : null;
  const problems = checked ? [...checked.years.flatMap((y) => y.problems.map((p) => `${y.year}: ${p}`)), ...checked.crossYear] : [];
  const unsampledTooBig = cfg.sampleSize === 0 && eligible !== null && eligible > MAX_UNSAMPLED_ROWS;
  const blockers: string[] = [];
  if (cfg.years.length === 0) blockers.push('Pick at least one year.');
  if (!checked) blockers.push('Still checking the files.');
  if (problems.length) blockers.push('Fix or remove the years with problems.');
  if (eligible !== null && eligible < cfg.k) blockers.push(`Only ${eligible} usable pixels for ${cfg.k} classes.`);
  if (unsampledTooBig) blockers.push('Too many pixels to use them all. Pick a sample size.');

  const toggleYear = (y: number) =>
    setConfig(siteId, { years: cfg.years.includes(y) ? cfg.years.filter((v) => v !== y) : [...cfg.years, y].sort((a, b) => a - b) });

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="space-y-3">
        <Card title="1 · Pick years" subtitle={`One model for ${siteId}, trained on all the years you pick`}>
          <div className="space-y-3">
            <Field label="Years" hint={`${cfg.years.length} selected`}>
              <div className="flex flex-wrap gap-1.5">
                {allYears.map((y) => {
                  const on = cfg.years.includes(y);
                  return (
                    <button
                      key={y}
                      disabled={busy}
                      onClick={() => toggleYear(y)}
                      aria-pressed={on}
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
            </Field>
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              {cfg.years.length === 4
                ? 'With 4 years you also get a four-year consensus map.'
                : consensusAvailable(cfg.years.length)
                  ? `The consensus map will cover these ${cfg.years.length} years.`
                  : 'Pick 3 or more years to get a consensus map.'}
            </p>
            <YearTable checked={checked} loading={job?.kind === 'inspect' && job.siteId === siteId} />
            {checked?.crossYear.map((p) => (
              <Notice key={p} tone="danger">
                {p}
              </Notice>
            ))}
          </div>
        </Card>

        <Card title="2 · Settings">
          <div className="space-y-3.5">
            <Field label="Number of classes (k)" hint={cfg.k === KMEANS_DEFAULTS.k ? 'default' : `default is ${KMEANS_DEFAULTS.k}`}>
              <Segmented
                size="sm"
                value={String(cfg.k)}
                onChange={(v) => setConfig(siteId, { k: Number(v) })}
                options={Array.from({ length: K_MAX - K_MIN + 1 }, (_, i) => ({ value: String(K_MIN + i), label: String(K_MIN + i) }))}
              />
            </Field>
            <Field label="Training sample" hint={eligible !== null ? `${formatCount(eligible)} usable pixel-years` : undefined}>
              <Select value={cfg.sampleSize} disabled={busy} onChange={(e) => setConfig(siteId, { sampleSize: Number(e.target.value) })}>
                {TRAINING_SAMPLE_CHOICES.map((n) => (
                  <option key={n} value={n} disabled={n === 0 && eligible !== null && eligible > MAX_UNSAMPLED_ROWS}>
                    {n === 0
                      ? `All pixel-years${eligible !== null && eligible > MAX_UNSAMPLED_ROWS ? ' (too many here)' : ''}`
                      : `${formatCount(n)} random pixel-years${n === DEFAULT_TRAINING_SAMPLE ? ' (default)' : ''}`}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              A pixel-year is one pixel in one year. Only the model fit uses the sample; every usable pixel in every selected year is classified.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-[var(--bg-sunken)] px-3 py-2 text-[12px]">
              <dt className="text-[var(--text-faint)]">Method</dt>
              <dd>K-means, {KMEANS_DEFAULTS.nInit} restarts, seed {KMEANS_DEFAULTS.seed}</dd>
              <dt className="text-[var(--text-faint)]">Inputs</dt>
              <dd>21 phenology measures, with dates counted from each pixel&apos;s green-up</dd>
              <dt className="text-[var(--text-faint)]">Quality</dt>
              <dd>QA 1 to 3 only</dd>
            </dl>
          </div>
        </Card>

        <Card title="3 · Train">
          <div className="space-y-3">
            <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              Classes group pixels with similar seasons. They aren&apos;t vegetation types, and class numbers only mean
              something within this model. Each run is saved separately.
            </p>
            {blockers.length > 0 && !busy && (
              <ul className="space-y-1 text-[12px] text-[var(--text-muted)]">
                {blockers.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
            {job?.siteId === siteId && (job.kind === 'train' || job.kind === 'apply') ? (
              <JobPanel />
            ) : (
              <Button
                variant="primary"
                icon={<Play size={14} />}
                disabled={busy || blockers.length > 0}
                onClick={() => void train(manifest, cfg)}
                title={busy ? 'Wait for the current job to finish.' : blockers[0]}
              >
                Train {cfg.k}-class model
              </Button>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-3">
        <Card
          title="Help choosing k"
          subtitle="Optional. Tries k = 2 to 9 and plots two scores."
          actions={
            <Button size="sm" icon={<Sigma size={13} />} disabled={busy || cfg.years.length === 0 || !checked || problems.length > 0} onClick={() => void diagnose(manifest, cfg.years)}>
              {diag ? 'Run again' : 'Run'}
            </Button>
          }
        >
          {job?.siteId === siteId && job.kind === 'diagnose' ? (
            <JobPanel />
          ) : diag ? (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-2 2xl:grid-cols-2">
                <DiagChart
                  dark={dark}
                  title="Inertia"
                  hint="Pick k where the curve bends."
                  x={diag.points.map((p) => p.k)}
                  y={diag.points.map((p) => p.inertia)}
                  k={cfg.k}
                />
                <DiagChart
                  dark={dark}
                  title="Silhouette"
                  hint="Higher means clearer classes."
                  x={diag.points.map((p) => p.k)}
                  y={diag.points.map((p) => p.silhouette)}
                  k={cfg.k}
                />
              </div>
              <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">{diag.note}</p>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              The original study picked k = 7 from these charts. Takes about a minute.
            </p>
          )}
        </Card>
        {job && job.siteId !== siteId && (
          <Notice tone="info">
            A job for {job.siteId} is running. Its results will be saved to {job.siteId}.
          </Notice>
        )}
      </div>
    </div>
  );
}

function YearTable({ checked, loading }: { checked: Inspection | null; loading: boolean }) {
  if (loading && !checked) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        <ScanSearch size={13} /> Checking the files…
      </div>
    );
  }
  if (!checked) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-[var(--border)]">
      <table className="w-full text-[12px] tabular-nums">
        <thead className="bg-[var(--bg-sunken)] text-[var(--text-faint)]">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Year</th>
            <th className="px-2 py-1.5 text-right font-medium" title={STATUS_LABELS[STATUS.ELIGIBLE]}>
              Usable
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title={STATUS_LABELS[STATUS.QA_REJECTED]}>
              QA 4
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title={`${STATUS_LABELS[STATUS.MISSING_CYCLE1]}; ${STATUS_LABELS[STATUS.MISSING_CYCLE2]}`}>
              Missing
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title={STATUS_LABELS[STATUS.NO_PRODUCT]}>
              No data
            </th>
            <th className="px-2 py-1.5 text-left font-medium">Grid</th>
          </tr>
        </thead>
        <tbody>
          {checked.years.map((y) => (
            <tr key={y.year} className="border-t border-[var(--border)]">
              <td className="px-2 py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  {y.ok ? <CheckCircle2 size={12} className="text-[var(--accent)]" /> : <AlertTriangle size={12} className="text-red-500" />}
                  {y.year}
                </span>
              </td>
              {y.statusCounts ? (
                <>
                  <td className="px-2 py-1.5 text-right">{formatCount(y.eligible)}</td>
                  <td className="px-2 py-1.5 text-right">{formatCount(y.statusCounts[STATUS.QA_REJECTED])}</td>
                  <td className="px-2 py-1.5 text-right">
                    {formatCount(y.statusCounts[STATUS.MISSING_CYCLE1] + y.statusCounts[STATUS.MISSING_CYCLE2])}
                  </td>
                  <td className="px-2 py-1.5 text-right">{formatCount(y.statusCounts[STATUS.NO_PRODUCT])}</td>
                </>
              ) : (
                <td colSpan={4} className="px-2 py-1.5 text-red-600 dark:text-red-400">
                  {y.problems.join(' ')}
                </td>
              )}
              <td className="px-2 py-1.5 text-[var(--text-muted)]">
                {y.width ? `${y.width}×${y.height}` : '—'}
                {y.epsg ? ` · EPSG:${y.epsg}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagChart({ title, hint, x, y, k, dark }: { title: string; hint: string; x: number[]; y: number[]; k: number; dark: boolean }) {
  const ink = dark ? '#98a3b3' : '#617069';
  const grid = dark ? '#212a36' : '#e3e6ec';
  const line = dark ? '#3987e5' : '#2a78d6';
  const i = x.indexOf(k);
  const data = useMemo(
    () => [
      { x, y, type: 'scatter', mode: 'lines+markers', line: { color: line, width: 2 }, marker: { size: 8, color: line }, hovertemplate: 'k = %{x}<br>%{y:.4~g}<extra></extra>', name: title },
      ...(i >= 0
        ? [{ x: [k], y: [y[i]], type: 'scatter', mode: 'markers', marker: { size: 13, color: 'rgba(0,0,0,0)', line: { color: dark ? '#e8ecf2' : '#23332d', width: 2 } }, hoverinfo: 'skip', name: 'selected k' }]
        : []),
    ],
    [x, y, k, i, line, title, dark],
  );
  const layout = useMemo(
    () => ({
      height: 210,
      margin: { l: 56, r: 12, t: 8, b: 36 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', size: 11, color: ink },
      showlegend: false,
      xaxis: { title: { text: 'k' }, dtick: 1, gridcolor: grid, zeroline: false },
      yaxis: { gridcolor: grid, zeroline: false, tickformat: '~s' },
    }),
    [ink, grid],
  );
  return (
    <div className="rounded-md border border-[var(--border)] px-2 pt-2">
      <div className="px-1 text-[12px] font-medium">{title}</div>
      <div className="px-1 text-[11px] text-[var(--text-faint)]">{hint}</div>
      <div className="h-[210px]">
        <PlotlyChart data={data as never} layout={layout as never} config={{ displayModeBar: false, responsive: true } as never} />
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={
        tone === 'danger'
          ? 'rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[12.5px] leading-relaxed text-red-700 dark:text-red-300'
          : tone === 'warning'
            ? 'rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800 dark:text-amber-200'
            : 'rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text-muted)]'
      }
    >
      {children}
    </div>
  );
}

