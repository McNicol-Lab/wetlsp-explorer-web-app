/**
 * Phenology Classes state. Kept apart from the main store: it only holds small
 * metadata (run manifests, settings, job progress); label arrays are read from
 * OPFS by the views when shown.
 *
 * One worker job runs at a time. A job is tagged with the site it was started
 * for, and its result is filed under that site even if the user has switched
 * to another one in the meantime.
 */
import { create } from 'zustand';
import { useAppStore } from './useAppStore';
import { diagnoseSite, inspectSite, resetPhenoclassWorker, trainSite } from '@/engine/phenoclass';
import { deleteRun as deleteRunFiles, listRuns } from '@/lib/phenoclass/storage';
import { DEFAULT_TRAINING_SAMPLE, KMEANS_DEFAULTS } from '@/lib/phenoclass/constants';
import type { Inspection } from '@/lib/phenoclass/pipeline';
import type { DiagnosticsResult, RunManifest } from '@/lib/phenoclass/model';
import { CancelledError } from '@/lib/rpc';
import type { ProgressEvent, SiteManifest } from '@/lib/types';

export type PhenoclassSection = 'build' | 'maps' | 'cover' | 'waveforms';
export type JobKind = 'inspect' | 'diagnose' | 'train' | 'apply';

export interface BuildConfig {
  years: number[];
  k: number;
  /** 0 = every eligible pixel-year. */
  sampleSize: number;
}

export interface PhenoclassJob {
  id: number;
  siteId: string;
  kind: JobKind;
  progress: ProgressEvent | null;
  controller: AbortController;
  startedAt: number;
}

interface Keyed<T> {
  key: string;
  result: T;
}

interface State {
  section: PhenoclassSection;
  config: Record<string, BuildConfig>;
  inspection: Record<string, Keyed<Inspection> | undefined>;
  diagnostics: Record<string, Keyed<DiagnosticsResult> | undefined>;
  runs: Record<string, RunManifest[] | undefined>;
  activeRun: Record<string, string | null | undefined>;
  /** Hidden class ids per run. */
  hidden: Record<string, number[] | undefined>;
  job: PhenoclassJob | null;
  errors: Record<string, string | null | undefined>;

  setSection(s: PhenoclassSection): void;
  setConfig(siteId: string, patch: Partial<BuildConfig>): void;
  loadRuns(siteId: string): Promise<void>;
  selectRun(siteId: string, runId: string | null): void;
  toggleClass(runId: string, classId: number): void;
  isolateClass(runId: string, classId: number, k: number): void;
  showAllClasses(runId: string): void;
  inspect(manifest: SiteManifest, years: number[]): Promise<void>;
  diagnose(manifest: SiteManifest, years: number[]): Promise<void>;
  train(manifest: SiteManifest, cfg: BuildConfig, model?: unknown): Promise<RunManifest | null>;
  cancelJob(): void;
  deleteRun(siteId: string, runId: string): Promise<void>;
  forgetSite(siteId: string): void;
}

let jobCounter = 0;

/** Identifies one site's file set: changes when years are re-imported. */
export function inputKey(manifest: SiteManifest, years: number[]): string {
  const files = [...years]
    .sort((a, b) => a - b)
    .map((y) => {
      const f = manifest.netcdf.find((n) => n.year === y);
      return f ? `${y}:${f.path}:${f.size}` : `${y}:missing`;
    });
  return `${manifest.siteId}|${manifest.importedAt}|${files.join(',')}`;
}

/** Why a saved run no longer matches the site's files, or null when it still does. */
export function runStaleness(run: RunManifest, manifest: SiteManifest | undefined): string | null {
  if (!manifest) return 'The site isn\'t loaded.';
  for (const input of run.inputs) {
    const f = manifest.netcdf.find((n) => n.year === input.year);
    if (!f) return `${input.year} is no longer in this site.`;
    if (f.path !== input.path || f.size !== input.size || manifest.importedAt !== input.importedAt) {
      return `The ${input.year} file changed after this run.`;
    }
  }
  return null;
}

export function defaultConfig(manifest: SiteManifest): BuildConfig {
  const years = manifest.netcdf.map((n) => n.year).sort((a, b) => a - b);
  const preferred = years.filter((y) => y >= 2021 && y <= 2024);
  return {
    years: preferred.length === 4 ? preferred : years.slice(-4),
    k: KMEANS_DEFAULTS.k,
    sampleSize: DEFAULT_TRAINING_SAMPLE,
  };
}

const toast = (...args: Parameters<ReturnType<typeof useAppStore.getState>['toast']>) => useAppStore.getState().toast(...args);

export const usePhenoclassStore = create<State>((set, get) => {
  /** Run one worker job with the shared progress/cancel/error handling. */
  async function runJob<T>(siteId: string, kind: JobKind, work: (opts: { signal: AbortSignal; onProgress: (p: ProgressEvent) => void }) => Promise<T>): Promise<T | null> {
    if (get().job) {
      toast({ kind: 'info', title: 'Another job is running', detail: 'Wait for it or cancel it.' });
      return null;
    }
    const id = ++jobCounter;
    const controller = new AbortController();
    set({ job: { id, siteId, kind, progress: null, controller, startedAt: Date.now() }, errors: { ...get().errors, [siteId]: null } });
    try {
      return await work({
        signal: controller.signal,
        onProgress: (p) => {
          const j = get().job;
          if (j?.id === id) set({ job: { ...j, progress: p } });
        },
      });
    } catch (err) {
      if (!(err instanceof CancelledError) && !controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        set({ errors: { ...get().errors, [siteId]: message } });
      }
      return null;
    } finally {
      if (get().job?.id === id) set({ job: null });
    }
  }

  return {
    section: 'build',
    config: {},
    inspection: {},
    diagnostics: {},
    runs: {},
    activeRun: {},
    hidden: {},
    job: null,
    errors: {},

    setSection(section) {
      set({ section });
    },

    setConfig(siteId, patch) {
      const site = useAppStore.getState().sites[siteId];
      const base = get().config[siteId] ?? (site ? defaultConfig(site.manifest) : { years: [], k: KMEANS_DEFAULTS.k, sampleSize: DEFAULT_TRAINING_SAMPLE });
      set({ config: { ...get().config, [siteId]: { ...base, ...patch } } });
    },

    async loadRuns(siteId) {
      try {
        const runs = await listRuns(siteId);
        const active = get().activeRun[siteId];
        set({
          runs: { ...get().runs, [siteId]: runs },
          activeRun: { ...get().activeRun, [siteId]: active && runs.some((r) => r.runId === active) ? active : (runs[0]?.runId ?? null) },
        });
      } catch (err) {
        set({ runs: { ...get().runs, [siteId]: [] }, errors: { ...get().errors, [siteId]: err instanceof Error ? err.message : String(err) } });
      }
    },

    selectRun(siteId, runId) {
      set({ activeRun: { ...get().activeRun, [siteId]: runId } });
    },

    toggleClass(runId, classId) {
      const cur = new Set(get().hidden[runId] ?? []);
      if (cur.has(classId)) cur.delete(classId);
      else cur.add(classId);
      set({ hidden: { ...get().hidden, [runId]: [...cur] } });
    },

    isolateClass(runId, classId, k) {
      const cur = get().hidden[runId] ?? [];
      const alreadyIsolated = cur.length === k - 1 && !cur.includes(classId);
      set({
        hidden: {
          ...get().hidden,
          [runId]: alreadyIsolated ? [] : Array.from({ length: k }, (_, i) => i + 1).filter((c) => c !== classId),
        },
      });
    },

    showAllClasses(runId) {
      set({ hidden: { ...get().hidden, [runId]: [] } });
    },

    async inspect(manifest, years) {
      const key = inputKey(manifest, years);
      // Store the result before the job clears, so nothing sees "idle and unchecked" in between.
      await runJob(manifest.siteId, 'inspect', async (o) => {
        const result = await inspectSite(manifest, years, o);
        set({ inspection: { ...get().inspection, [manifest.siteId]: { key, result } } });
        return result;
      });
    },

    async diagnose(manifest, years) {
      const key = inputKey(manifest, years);
      await runJob(manifest.siteId, 'diagnose', async (o) => {
        const result = await diagnoseSite(manifest, years, {}, o);
        set({ diagnostics: { ...get().diagnostics, [manifest.siteId]: { key, result } } });
        return result;
      });
    },

    async train(manifest, cfg, model) {
      const siteId = manifest.siteId;
      const key = inputKey(manifest, cfg.years);
      const diag = get().diagnostics[siteId];
      const run = await runJob(siteId, model ? 'apply' : 'train', async (o) => {
        const made = await trainSite(manifest, cfg.years, { k: cfg.k, sampleSize: cfg.sampleSize, diagnostics: diag?.key === key ? diag.result : null, model }, o);
        // File the run under the site it was made for, wherever the user is now.
        const runs = [made, ...(get().runs[siteId] ?? []).filter((r) => r.runId !== made.runId)];
        set({ runs: { ...get().runs, [siteId]: runs }, activeRun: { ...get().activeRun, [siteId]: made.runId } });
        return made;
      });
      if (!run) return null;
      const here = useAppStore.getState().activeSiteId === siteId;
      toast({
        // The sampling note is information, not a problem; anything else is worth the amber.
        kind: run.warnings.some((w) => !w.startsWith('Model fit on a random sample')) ? 'warning' : 'success',
        title: `${siteId}: ${model ? 'model applied' : `${run.model.kmeans.k} classes ready`}`,
        detail: `${run.years.join(', ')} classified.`,
        action: here
          ? { label: 'Open maps', run: () => get().setSection('maps') }
          : { label: `Open ${siteId}`, run: () => void useAppStore.getState().selectSite(siteId).then(() => get().setSection('maps')) },
      });
      return run;
    },

    cancelJob() {
      get().job?.controller.abort();
    },

    async deleteRun(siteId, runId) {
      await deleteRunFiles(siteId, runId);
      const runs = (get().runs[siteId] ?? []).filter((r) => r.runId !== runId);
      const active = get().activeRun[siteId] === runId ? (runs[0]?.runId ?? null) : get().activeRun[siteId];
      const hidden = { ...get().hidden };
      delete hidden[runId];
      set({ runs: { ...get().runs, [siteId]: runs }, activeRun: { ...get().activeRun, [siteId]: active }, hidden });
    },

    forgetSite(siteId) {
      const job = get().job;
      if (job?.siteId === siteId) {
        // Its files are going away: stop reading them now.
        job.controller.abort();
        resetPhenoclassWorker();
        set({ job: null });
      }
      const drop = <T,>(r: Record<string, T>) => {
        const out = { ...r };
        delete out[siteId];
        return out;
      };
      set({
        config: drop(get().config),
        inspection: drop(get().inspection),
        diagnostics: drop(get().diagnostics),
        runs: drop(get().runs),
        activeRun: drop(get().activeRun),
        errors: drop(get().errors),
      });
    },
  };
});

// A removed site takes its phenology-class state with it (its OPFS runs are
// deleted by `removeSite`).
let knownSites = new Set<string>();
useAppStore.subscribe((s) => {
  const now = new Set(s.siteOrder);
  for (const id of knownSites) if (!now.has(id)) usePhenoclassStore.getState().forgetSite(id);
  knownSites = now;
});
