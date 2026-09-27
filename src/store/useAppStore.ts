/**
 * Single app store. Everything the chrome and the five views read lives here;
 * heavy data (geometry, rasters, query results) is cached per site alongside it
 * so switching sites is instant after the first load.
 */
import { create } from 'zustand';
import type {
  CatalogSite,
  PixelGeometry,
  ProgressEvent,
  SiteFacts,
  SiteManifest,
  SiteMeta,
  ViewId,
} from '@/lib/types';
import {
  deleteManifest,
  loadAllManifests,
  loadSetting,
  loadSiteMeta,
  saveSetting,
  saveSiteMeta,
} from '@/lib/idb';
import {
  deleteSite as deleteSiteFiles,
  siteBytes,
  storageBudget,
  storageUsage,
} from '@/lib/opfs';
import { indexCatalog, loadCatalog } from '@/lib/catalog';
import { expandArchives, ingestEntries, type IngestEntry } from '@/lib/ingest';
import { splitSites } from '@/lib/detect';
import { sampleEntries, sampleSites, type SampleSite } from '@/lib/samples';
import { formatBytes, formatCount } from '@/lib/format';
import {
  clearGeometryCache,
  clearQueryCaches,
  getPixelGeometry,
  getSiteFacts,
  getSiteMeta,
} from '@/engine/queries';
import { unregisterSite } from '@/engine/duckdb';
import { releaseSite } from '@/engine/netcdf';
import { DEFAULT_PIXEL_SAMPLE, DEFAULT_SELECTION_CAP, MAX_PIXEL_SAMPLE } from '@/engine/sql';
import { newSeed, randomSample } from '@/lib/sampling';
import { CancelledError } from '@/lib/rpc';
import type { BasemapId } from '@/lib/basemaps';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  /** Milliseconds; 0 keeps it until dismissed. */
  ttl: number;
}

export interface SiteState {
  manifest: SiteManifest;
  meta: SiteMeta;
  facts: SiteFacts | null;
  geometry: PixelGeometry | null;
  bytesOnDisk: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  /** Non-fatal problems: missing files, unresolvable CRS, etc. */
  notes: string[];
}

/** `line`: mean lines; `years`: one line per year on a shared calendar; `3d`: surface. */
export type TimeseriesChart = 'line' | 'years' | '3d';

export interface TimeseriesSettings {
  year: number | null;
  series: string[];
  maxPixels: number;
  dateRange: [string, string] | null;
  useSelection: boolean;
  chart: TimeseriesChart;
  /** Line-chart layers. */
  showMean: boolean;
  showIqr: boolean;
  showPixels: boolean;
  /** Green-up, peak and green-down markers estimated from the mean line. */
  showKeyDates: boolean;
  /** Seed of the random pixel sample; a new seed draws different pixels. */
  sampleSeed: number;
}

/** One site in a multi-site import. */
interface ImportJob {
  entries: IngestEntry[];
  hint?: string;
  origin?: SiteManifest['origin'];
}

/** Open while an import waits for the user to delete something. */
export interface SpaceRequest {
  siteId: string;
  bytes: number;
  /** More sites are queued behind this one, so skipping it is meaningful. */
  canSkip: boolean;
  /** `budget`: the 50 GB limit; `quota`: the browser actually ran out of disk. */
  reason: 'budget' | 'quota';
  /** Site bytes when the dialog opened, to measure what the user has freed. */
  usedAtOpen: number;
  resolve: (choice: 'retry' | 'skip' | 'stop') => void;
}

class SkipSite extends Error {}

export interface PhenometricSettings {
  layer: string | null;
  panels: Array<{ siteId: string; year: number }>;
  maxCells: number;
  mode3d: boolean;
  basemap: boolean;
  syncScale: boolean;
}

interface AppState {
  /* chrome */
  booted: boolean;
  theme: ThemeMode;
  view: ViewId;
  railCollapsed: boolean;
  inspectorCollapsed: boolean;
  paletteOpen: boolean;
  onboardingDone: boolean;
  /** Lets the catalog be browsed before anything is uploaded. */
  heroDismissed: boolean;
  online: boolean;
  basemap: BasemapId | 'auto';
  storage: { usage: number; quota: number; persisted: boolean };
  /** Settings drawer, openable from anywhere (e.g. the storage meter). */
  settingsOpen: boolean;

  /* data */
  sites: Record<string, SiteState>;
  siteOrder: string[];
  activeSiteId: string | null;
  catalog: CatalogSite[];
  catalogIndex: Map<string, CatalogSite>;
  catalogSource: 'bundled' | 'user' | 'none';
  /** Catalog row the Overview map is focused on, loaded or not. */
  catalogFocusId: string | null;

  /* interaction */
  selection: number[];
  /** How many pixels a rectangle or lasso takes; larger shapes are sampled. */
  selectionCap: number;
  /** Every pixel inside the last rectangle or lasso, for redrawing its sample. */
  selectionPool: Int32Array | null;
  selectionSeed: number;
  focusedPixel: number | null;
  plottedPixels: number[];

  timeseries: TimeseriesSettings;
  phenometrics: PhenometricSettings;

  /** Sample sites the desktop app can download; empty in the hosted web build. */
  samples: SampleSite[];

  /* transient */
  ingest: {
    active: boolean;
    progress: ProgressEvent | null;
    controller: AbortController | null;
    /** Position in a multi-site import; null for a single site. */
    queue: { index: number; total: number; label: string } | null;
  };
  spaceRequest: SpaceRequest | null;
  toasts: Toast[];

  /* actions */
  boot(): Promise<void>;
  setTheme(t: ThemeMode): void;
  setView(v: ViewId): void;
  toggleRail(): void;
  toggleInspector(): void;
  setPaletteOpen(open: boolean): void;
  dismissOnboarding(): void;
  setHeroDismissed(v: boolean): void;
  setBasemap(b: BasemapId | 'auto'): void;

  toast(t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }): number;
  dismissToast(id: number): void;

  importEntries(entries: IngestEntry[], folderHint?: string): Promise<void>;
  installSamples(siteIds?: string[]): Promise<void>;
  cancelImport(): void;
  setSettingsOpen(open: boolean): void;
  selectSite(siteId: string): Promise<void>;
  loadSite(siteId: string, opts?: { rereadMeta?: boolean }): Promise<void>;
  /** Re-read a site's metadata and geometry from its stored files. */
  reloadSite(siteId: string): Promise<void>;
  removeSite(siteId: string): Promise<void>;
  refreshStorage(): Promise<void>;
  setCatalog(sites: CatalogSite[], source: 'bundled' | 'user' | 'none'): void;
  setCatalogFocus(siteId: string | null): void;

  /** Select the pixels inside a shape, sampling at random above the cap. */
  selectShape(pool: Int32Array): void;
  /** A new random sample of the last shape. */
  redrawSample(): void;
  togglePixel(id: number): void;
  clearSelection(): void;
  setSelectionCap(cap: number): void;
  setFocusedPixel(id: number | null): void;
  setPlottedPixels(ids: number[] | Int32Array): void;

  updateTimeseries(patch: Partial<TimeseriesSettings>): void;
  updatePhenometrics(patch: Partial<PhenometricSettings>): void;
}

let toastId = 0;

const defaultTimeseries: TimeseriesSettings = {
  year: null,
  series: ['spline'],
  maxPixels: DEFAULT_PIXEL_SAMPLE,
  dateRange: null,
  useSelection: false,
  chart: 'line',
  showMean: true,
  showIqr: true,
  showPixels: false,
  showKeyDates: true,
  sampleSeed: newSeed(),
};

const IDLE_INGEST = { active: false, progress: null, controller: null, queue: null };

const defaultPhenometrics: PhenometricSettings = {
  layer: null,
  panels: [],
  maxCells: 50_000,
  mode3d: false,
  basemap: false,
  syncScale: true,
};

export const useAppStore = create<AppState>((set, get) => ({
  booted: false,
  theme: 'light',
  view: 'overview',
  railCollapsed: false,
  inspectorCollapsed: false,
  paletteOpen: false,
  onboardingDone: false,
  heroDismissed: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  basemap: 'auto',
  storage: { usage: 0, quota: 0, persisted: false },
  settingsOpen: false,

  sites: {},
  siteOrder: [],
  activeSiteId: null,
  catalog: [],
  catalogIndex: new Map(),
  catalogSource: 'none',
  catalogFocusId: null,

  selection: [],
  selectionCap: DEFAULT_SELECTION_CAP,
  selectionPool: null,
  selectionSeed: newSeed(),
  focusedPixel: null,
  plottedPixels: [],

  timeseries: defaultTimeseries,
  phenometrics: defaultPhenometrics,

  samples: [],

  ingest: IDLE_INGEST,
  spaceRequest: null,
  toasts: [],

  async boot() {
    if (get().booted) return;

    const [theme, onboardingDone, rail, basemap, tsPrefs] = await Promise.all([
      loadSetting<ThemeMode>('theme'),
      loadSetting<boolean>('onboarding.done'),
      loadSetting<boolean>('rail.collapsed'),
      loadSetting<BasemapId | 'auto'>('basemap'),
      loadSetting<Partial<TimeseriesSettings>>('timeseries.chart'),
    ]);
    applyTheme(theme ?? 'light');

    const [manifests, catalog] = await Promise.all([loadAllManifests(), loadCatalog()]);
    const samples = sampleSites();

    const sites: Record<string, SiteState> = {};
    for (const manifest of manifests) {
      sites[manifest.siteId] = {
        manifest,
        meta: (await loadSiteMeta(manifest.siteId)) ?? {},
        facts: null,
        geometry: null,
        bytesOnDisk: manifest.totalBytes,
        status: 'idle',
        notes: manifest.warnings,
      };
    }

    set({
      booted: true,
      theme: theme ?? 'light',
      onboardingDone: onboardingDone ?? false,
      railCollapsed: rail ?? false,
      basemap: basemap ?? 'auto',
      sites,
      siteOrder: manifests.map((m) => m.siteId),
      catalog: catalog.sites,
      catalogIndex: indexCatalog(catalog.sites),
      catalogSource: catalog.source,
      samples,
      timeseries: { ...get().timeseries, ...pickChartPrefs(tsPrefs) },
    });

    void get().refreshStorage();

    const first = manifests[0]?.siteId ?? null;
    if (first) void get().selectSite(first);
  },

  setTheme(t) {
    applyTheme(t);
    set({ theme: t });
    void saveSetting('theme', t);
  },

  setView(v) {
    set({ view: v });
  },

  toggleRail() {
    const next = !get().railCollapsed;
    set({ railCollapsed: next });
    void saveSetting('rail.collapsed', next);
  },

  toggleInspector() {
    set({ inspectorCollapsed: !get().inspectorCollapsed });
  },

  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },

  dismissOnboarding() {
    set({ onboardingDone: true });
    void saveSetting('onboarding.done', true);
  },

  setHeroDismissed(v) {
    set({ heroDismissed: v });
  },

  setBasemap(b) {
    set({ basemap: b });
    void saveSetting('basemap', b);
  },

  toast(t) {
    const id = ++toastId;
    const ttl = t.ttl ?? (t.kind === 'error' ? 0 : 6000);
    set((s) => ({ toasts: [...s.toasts, { ...t, id, ttl }] }));
    if (ttl > 0) {
      window.setTimeout(() => get().dismissToast(id), ttl);
    }
    return id;
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  async importEntries(entries, folderHint) {
    if (entries.length === 0 || get().ingest.active) return;
    let jobs: ImportJob[];
    try {
      set({ ingest: { ...IDLE_INGEST, active: true, progress: { phase: 'Reading the folder', fraction: null } } });
      const expanded = await expandArchives(entries);
      jobs = splitSites(expanded).map((g) => ({ entries: g.files, hint: g.hint ?? folderHint }));
    } catch (err) {
      set({ ingest: IDLE_INGEST });
      get().toast({
        kind: 'error',
        title: 'Import failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    await runImport(jobs);
  },

  async installSamples(siteIds) {
    if (get().ingest.active) return;
    const wanted = get().samples.filter(
      (s) => (siteIds ? siteIds.includes(s.siteId) : true) && !get().sites[s.siteId],
    );
    if (wanted.length === 0) return;
    if (!navigator.onLine) {
      get().toast({
        kind: 'error',
        title: 'No internet connection',
        detail: 'The sample sites download once, then work offline. Connect and try again.',
        ttl: 8000,
      });
      return;
    }
    await runImport(
      wanted.map((s) => ({ entries: sampleEntries(s), hint: s.siteId, origin: 'sample' as const })),
    );
  },

  cancelImport() {
    get().ingest.controller?.abort();
    get().spaceRequest?.resolve('stop');
    set({ ingest: IDLE_INGEST, spaceRequest: null });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  async selectSite(siteId) {
    const site = get().sites[siteId];
    if (!site) return;
    const facts = site.status === 'ready' ? site.facts : null;
    const latest = site.manifest.netcdf[site.manifest.netcdf.length - 1];
    set({
      activeSiteId: siteId,
      catalogFocusId: siteId,
      selection: [],
      selectionPool: null,
      focusedPixel: null,
      plottedPixels: [],
      timeseries: {
        ...get().timeseries,
        year: facts?.years[facts.years.length - 1] ?? null,
        series: facts ? (facts.series.includes('spline') ? ['spline'] : facts.series.slice(0, 1)) : ['spline'],
        dateRange: null,
        useSelection: false,
      },
      phenometrics: {
        ...get().phenometrics,
        panels: facts && latest ? [{ siteId, year: latest.year }] : [],
        layer: null,
      },
    });
    await get().loadSite(siteId);
  },

  async loadSite(siteId, opts = {}) {
    const state = get().sites[siteId];
    if (!state || state.status === 'loading') return;
    if (state.status === 'ready' && !opts.rereadMeta) return;

    const patch = (p: Partial<SiteState>) =>
      set((s) =>
        s.sites[siteId] ? { sites: { ...s.sites, [siteId]: { ...s.sites[siteId], ...p } } } : {},
      );

    patch({ status: 'loading', error: undefined });
    const notes: string[] = [...state.manifest.warnings];

    try {
      // A stored meta with nothing in it is never trusted: an earlier read may
      // have failed. Re-read it, and say why when that fails too.
      let meta = state.meta;
      let metaError: string | null = null;
      if (state.manifest.meta && (opts.rereadMeta || Object.keys(meta).length === 0)) {
        try {
          meta = await getSiteMeta(state.manifest);
          if (Object.keys(meta).length > 0) void saveSiteMeta(siteId, meta);
          else metaError = '`pixels_meta` was read but holds no rows.';
        } catch (err) {
          meta = {};
          // DuckDB appends the failing SQL on later lines; the first says why.
          metaError = (err instanceof Error ? err.message : String(err)).split('\n')[0];
        }
      }
      if (metaError) notes.push(`Could not read \`pixels_meta\`: ${metaError}`);
      // An import-time read failure is history once the meta has been read.
      if (Object.keys(meta).length > 0) {
        for (let i = notes.length - 1; i >= 0; i--) {
          if (notes[i].startsWith('Could not read `pixels_meta` while importing')) notes.splice(i, 1);
        }
      }

      const facts = await getSiteFacts(state.manifest);

      let geometry: PixelGeometry | null = null;
      if (state.manifest.geom) {
        try {
          geometry = await getPixelGeometry(state.manifest, meta);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // "No CRS found" is misleading when the meta itself could not be read.
          notes.push(
            metaError
              ? 'Pixels cannot be placed on the map until `pixels_meta` (which holds the CRS) can be read. Use "Reload metadata" to try again.'
              : message,
          );
        }
      }

      const bytesOnDisk = await siteBytes(siteId).catch(() => state.manifest.totalBytes);

      patch({ meta, facts, geometry, bytesOnDisk, status: 'ready', notes });

      // A load finishing in the background must not change another site's filters.
      if (get().activeSiteId !== siteId) return;

      // Defaults that make the first chart appear untouched: newest year with
      // data, `spline` if present, otherwise whatever the file has.
      const ts = get().timeseries;
      const year =
        ts.year !== null && facts.years.includes(ts.year)
          ? ts.year
          : (facts.years[facts.years.length - 1] ?? null);
      const series = facts.series.includes('spline')
        ? ['spline']
        : facts.series.slice(0, 1);
      set({
        timeseries: { ...ts, year, series: series.length ? series : ts.series },
      });

      const ph = get().phenometrics;
      if (ph.panels.length === 0 && state.manifest.netcdf.length > 0) {
        const latest = state.manifest.netcdf[state.manifest.netcdf.length - 1];
        set({ phenometrics: { ...ph, panels: [{ siteId, year: latest.year }] } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patch({ status: 'error', error: message, notes });
      if (get().activeSiteId === siteId) {
        get().toast({ kind: 'error', title: `${siteId} could not be opened`, detail: message });
      }
    }
  },

  async reloadSite(siteId) {
    const state = get().sites[siteId];
    if (!state || state.status === 'loading') return;
    // Start from the stored files: drop DuckDB's handles and every cache
    // derived from the old metadata, including the reprojected pixels.
    await unregisterSite(state.manifest).catch(() => undefined);
    clearQueryCaches(siteId);
    await clearGeometryCache(siteId);
    set((s) => ({
      sites: { ...s.sites, [siteId]: { ...s.sites[siteId], status: 'idle', facts: null, geometry: null } },
    }));
    await get().loadSite(siteId, { rereadMeta: true });
    const after = get().sites[siteId];
    if (after?.status === 'ready') {
      const problem = after.notes.find((n) => n.startsWith('Could not read `pixels_meta`'));
      get().toast(
        problem
          ? { kind: 'error', title: `${siteId}: metadata still unreadable`, detail: problem }
          : {
              kind: 'success',
              title: `${siteId} reloaded`,
              detail: after.geometry
                ? `Metadata re-read · ${after.geometry.crsName ?? 'CRS resolved'}`
                : 'Metadata re-read.',
            },
      );
    }
  },

  async removeSite(siteId) {
    const state = get().sites[siteId];
    if (!state) return;
    try {
      await unregisterSite(state.manifest);
      await releaseSite(siteId);
      clearQueryCaches(siteId);
      await deleteSiteFiles(siteId);
      await deleteManifest(siteId);
    } catch (err) {
      get().toast({
        kind: 'error',
        title: `Could not remove ${siteId}`,
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    set((s) => {
      const sites = { ...s.sites };
      delete sites[siteId];
      const siteOrder = s.siteOrder.filter((id) => id !== siteId);
      const wasActive = s.activeSiteId === siteId;
      return {
        sites,
        siteOrder,
        activeSiteId: wasActive ? (siteOrder[0] ?? null) : s.activeSiteId,
        ...(wasActive ? { selection: [], selectionPool: null, focusedPixel: null, plottedPixels: [] } : {}),
        phenometrics: {
          ...s.phenometrics,
          panels: s.phenometrics.panels.filter((p) => p.siteId !== siteId),
        },
      };
    });
    get().toast({ kind: 'info', title: `${siteId} removed`, detail: 'Its files were deleted from offline storage.' });
    void get().refreshStorage();
    const next = get().activeSiteId;
    if (next) void get().loadSite(next);
  },

  async refreshStorage() {
    try {
      set({ storage: await storageUsage() });
    } catch {
      /* estimate is unavailable in some browsers */
    }
  },

  setCatalog(sites, source) {
    set({ catalog: sites, catalogIndex: indexCatalog(sites), catalogSource: source });
  },

  setCatalogFocus(siteId) {
    set({ catalogFocusId: siteId });
  },

  selectShape(pool) {
    const cap = get().selectionCap;
    const seed = newSeed();
    set({ selection: Array.from(randomSample(pool, cap, seed)), selectionPool: pool, selectionSeed: seed });
    if (pool.length > cap) {
      get().toast({
        kind: 'info',
        title: `Random sample of ${formatCount(cap)} pixels`,
        detail: `${formatCount(pool.length)} pixels fell inside the shape. Redraw the sample for different pixels, or raise the sample size in the inspector.`,
      });
    }
  },

  redrawSample() {
    const { selectionPool: pool, selectionCap: cap } = get();
    if (!pool || pool.length <= cap) return;
    const seed = newSeed();
    set({ selection: Array.from(randomSample(pool, cap, seed)), selectionSeed: seed });
  },

  togglePixel(id) {
    const current = get().selection;
    const idx = current.indexOf(id);
    if (idx >= 0) {
      set({ selection: current.filter((p) => p !== id) });
      return;
    }
    // The sample size only limits shapes. A click is always honoured up to the
    // most pixels one chart can plot.
    if (current.length >= MAX_PIXEL_SAMPLE) {
      get().toast({
        kind: 'warning',
        title: 'Selection is full',
        detail: `A chart can plot at most ${formatCount(MAX_PIXEL_SAMPLE)} pixels. Click a selected pixel to remove it, or clear the selection.`,
      });
      return;
    }
    set({ selection: [...current, id] });
  },

  clearSelection() {
    set({ selection: [], selectionPool: null, focusedPixel: null });
  },

  setSelectionCap(cap) {
    const next = Math.max(1, Math.min(MAX_PIXEL_SAMPLE, Math.round(cap)));
    const { selectionPool: pool, selectionSeed: seed } = get();
    // Same seed: a larger sample keeps every pixel of the smaller one.
    set(pool ? { selectionCap: next, selection: Array.from(randomSample(pool, next, seed)) } : { selectionCap: next });
  },

  setFocusedPixel(id) {
    set({ focusedPixel: id });
  },

  setPlottedPixels(ids) {
    set({ plottedPixels: Array.from(ids) });
  },

  updateTimeseries(patch) {
    set((s) => ({ timeseries: { ...s.timeseries, ...patch } }));
    if (Object.keys(pickChartPrefs(patch)).length > 0) {
      void saveSetting('timeseries.chart', pickChartPrefs(get().timeseries));
    }
  },

  updatePhenometrics(patch) {
    set((s) => ({ phenometrics: { ...s.phenometrics, ...patch } }));
  },
}));

/* ----------------------------------------------------------------- import */

/** Chart choices worth remembering between launches (not the data filters). */
function pickChartPrefs(p: Partial<TimeseriesSettings> | undefined): Partial<TimeseriesSettings> {
  if (!p) return {};
  const out: Partial<TimeseriesSettings> = {};
  if (p.chart === 'line' || p.chart === 'years' || p.chart === '3d') out.chart = p.chart;
  for (const k of ['showMean', 'showIqr', 'showPixels', 'showKeyDates'] as const) {
    if (typeof p[k] === 'boolean') out[k] = p[k];
  }
  return out;
}

/**
 * Before each site is written: fits inside the storage budget, or the user
 * deletes something, skips the site, or stops the import.
 */
async function ensureSpace(siteId: string, bytes: number, canSkip: boolean): Promise<void> {
  const { getState } = useAppStore;
  for (;;) {
    await getState().refreshStorage();
    const s = getState();
    const existing = s.sites[siteId]?.bytesOnDisk ?? 0;
    const siteTotal = Object.values(s.sites).reduce((n, st) => n + st.bytesOnDisk, 0);
    const budget = storageBudget(siteTotal, s.storage);
    if (budget.used - existing + bytes <= budget.limit) return;
    await askForSpace(siteId, bytes, canSkip, 'budget');
  }
}

/** Open the "make space" dialog; resolves on retry, throws on skip / stop. */
async function askForSpace(
  siteId: string,
  bytes: number,
  canSkip: boolean,
  reason: SpaceRequest['reason'],
): Promise<void> {
  const { getState, setState } = useAppStore;
  const usedAtOpen = Object.values(getState().sites).reduce((n, st) => n + st.bytesOnDisk, 0);
  const choice = await new Promise<'retry' | 'skip' | 'stop'>((resolve) =>
    setState({ spaceRequest: { siteId, bytes, canSkip, reason, usedAtOpen, resolve } }),
  );
  setState({ spaceRequest: null });
  if (choice === 'skip') throw new SkipSite(siteId);
  if (choice === 'stop') throw new CancelledError();
}

/**
 * The browser's estimate is approximate, so the real quota can still run out
 * mid-copy. That is the same situation as a full budget: ask for room.
 */
function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') return true;
  return err instanceof Error && /quota/i.test(err.message);
}

/** Import one or more sites, one after another, with one progress bar. */
async function runImport(jobs: ImportJob[]): Promise<void> {
  const { getState: get, setState: set } = useAppStore;
  const controller = new AbortController();
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ label: string; message: string }> = [];
  set({ ingest: { ...IDLE_INGEST, active: true, controller } });

  try {
    for (const [index, job] of jobs.entries()) {
      if (controller.signal.aborted) break;
      const label = job.hint ?? `site ${index + 1}`;
      const queue = jobs.length > 1 ? { index, total: jobs.length, label } : null;
      set((s) => ({ ingest: { ...s.ingest, queue, progress: null } }));
      const canSkip = index < jobs.length - 1;
      try {
        let result: Awaited<ReturnType<typeof ingestEntries>> | null = null;
        while (!result) {
          try {
            result = await ingestEntries(job.entries, {
              folderHint: job.hint,
              origin: job.origin,
              signal: controller.signal,
              ensureSpace: (siteId, bytes) => ensureSpace(siteId, bytes, canSkip),
              onProgress: (p) => set((s) => ({ ingest: { ...s.ingest, progress: p } })),
            });
          } catch (err) {
            if (!isQuotaError(err) || controller.signal.aborted) throw err;
            // The half-written copy was already removed; retry once there is room.
            await get().refreshStorage();
            await askForSpace(label, job.entries.reduce((n, e) => n + e.size, 0), canSkip, 'quota');
          }
        }
        const { manifest, meta } = result;
        set((s) => ({
          sites: {
            ...s.sites,
            [manifest.siteId]: {
              manifest,
              meta,
              facts: null,
              geometry: null,
              bytesOnDisk: manifest.totalBytes,
              status: 'idle',
              notes: manifest.warnings,
            },
          },
          siteOrder: s.siteOrder.includes(manifest.siteId)
            ? s.siteOrder
            : [...s.siteOrder, manifest.siteId],
        }));
        imported.push(manifest.siteId);

        if (jobs.length === 1) {
          const fileCount =
            (manifest.geom?.parts.length ?? 0) +
            (manifest.meta?.parts.length ?? 0) +
            (manifest.timeseries?.parts.length ?? 0) +
            manifest.netcdf.length;
          get().toast({
            kind: manifest.warnings.length ? 'warning' : 'success',
            title: `${manifest.siteId} imported`,
            detail: manifest.warnings.length
              ? manifest.warnings[0]
              : `${fileCount} files ready — ${manifest.netcdf.length} NetCDF year${
                  manifest.netcdf.length === 1 ? '' : 's'
                }.`,
          });
        }
        // Open the first site straight away; later ones load in the background.
        if (imported.length === 1) void get().selectSite(manifest.siteId);
      } catch (err) {
        if (err instanceof SkipSite) skipped.push(label);
        else if (err instanceof CancelledError || controller.signal.aborted) break;
        else failed.push({ label, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    set({ ingest: IDLE_INGEST, spaceRequest: null });
    void get().refreshStorage();
  }

  if (jobs.length > 1 && imported.length > 0) {
    const bytes = imported.reduce((n, id) => n + (get().sites[id]?.bytesOnDisk ?? 0), 0);
    get().toast({
      kind: failed.length || skipped.length ? 'warning' : 'success',
      title: `${imported.length} of ${jobs.length} sites imported`,
      detail: [
        `${imported.join(', ')} · ${formatBytes(bytes)}`,
        skipped.length ? `Skipped: ${skipped.join(', ')}` : '',
        failed.length ? `Failed: ${failed.map((f) => f.label).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  for (const f of failed) {
    get().toast({
      kind: 'error',
      title: jobs.length > 1 ? `${f.label} could not be imported` : 'Import failed',
      detail: f.message,
    });
  }
}

/* ------------------------------------------------------------------ theme */

export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('wetlsp.theme', mode === 'system' ? 'system' : mode);
  } catch {
    /* private mode */
  }
}

/** Keep `system` mode following the OS while the app is open. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (useAppStore.getState().theme === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export function watchOnline(): () => void {
  const update = () => useAppStore.setState({ online: navigator.onLine });
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

/* --------------------------------------------------------------- helpers */

export function activeSite(): SiteState | null {
  const s = useAppStore.getState();
  return s.activeSiteId ? (s.sites[s.activeSiteId] ?? null) : null;
}

export function useActiveSite(): SiteState | null {
  return useAppStore((s) => (s.activeSiteId ? (s.sites[s.activeSiteId] ?? null) : null));
}
