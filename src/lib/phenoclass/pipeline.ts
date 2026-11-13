/**
 * The classification pipeline, independent of where the data comes from.
 *
 * Memory stays bounded to about one year of decoded variables plus the
 * training sample: years are read one at a time, twice.
 *   Pass A: extract features, accumulate exact scaler statistics over every
 *           eligible pixel-year, draw the (seeded) training sample.
 *   Fit:    k-means on the standardised training rows.
 *   Pass B: re-extract, classify every eligible pixel-year with the fixed model,
 *           accumulate exact class medians and full-resolution cover.
 * Then the consensus, class summaries and synthetic waveforms.
 */
import {
  CODE,
  CONSENSUS_MIN_VALID_YEARS,
  DIAGNOSTIC_SAMPLE,
  DOY_PERIOD,
  FEATURE_ORDER,
  K_MAX,
  K_MIN,
  KMEANS_DEFAULTS,
  MAX_UNSAMPLED_ROWS,
  METHOD_VERSIONS,
  MODEL_SCHEMA,
  MODEL_SCHEMA_VERSION,
  N_FEATURES,
  N_SUMMARY,
  QA_MAX_ACCEPTED,
  REFERENCE,
  RUN_SCHEMA_VERSION,
  SILHOUETTE_SAMPLE,
  SMOOTH_MAX_K_STORED,
  STATUS,
} from './constants';
import { assertIntegerFeatures, extractYear, schemaProblems, type YearFeatures, type YearInput } from './features';
import { ScalerAccumulator, transform, type ScalerParams } from './scaler';
import { Reservoir, Rng } from './rng';
import { assign, fitKMeans, silhouette } from './kmeans';
import { computeConsensus, consensusAvailable, consensusPolicy } from './consensus';
import { annualCover, consensusCover, type AnnualCover } from './cover';
import { MedianAccumulator } from './summary';
import { reconstructWaveform } from './waveform';
import { gridMismatch, type GridSpec } from './grid';
import { CLASS_COLORS } from './palette';
import {
  ENCODING,
  featureUnitLabels,
  newId,
  type DiagnosticsResult,
  type InputFingerprint,
  type PhenoclassModel,
  type RunManifest,
} from './model';
import type { ProgressEvent } from '@/lib/types';

export interface LoadedYear {
  /** Variables decoded to north-up rows; missing ones are simply absent. */
  input: YearInput;
  grid: GridSpec;
  fingerprint: InputFingerprint;
}

export interface YearSource {
  year: number;
  load(): Promise<LoadedYear>;
}

export interface PipelineContext {
  progress(p: ProgressEvent): void;
  /** Yield to the event loop, then throw if the job was cancelled. */
  checkpoint(): Promise<void>;
}

export interface RunSink {
  write(name: string, data: Uint8Array | Float32Array | string): Promise<void>;
}

const GREENNESS_VARS = ['EVImax', 'EVIamp', 'EVIarea', 'EVImax_2', 'EVIamp_2', 'EVIarea_2'];
const CHUNK = 32_768;

/* ------------------------------------------------------------ inspection */

export interface YearInspection {
  year: number;
  ok: boolean;
  problems: string[];
  width: number | null;
  height: number | null;
  epsg: number | null;
  crsName: string | null;
  cellAreaM2: number | null;
  statusCounts: number[] | null;
  eligible: number;
}

export interface Inspection {
  years: YearInspection[];
  /** Problems that involve more than one year, such as different grids. */
  crossYear: string[];
}

export async function inspectYears(sources: YearSource[], ctx: PipelineContext): Promise<Inspection> {
  const years: YearInspection[] = [];
  const grids: Array<{ year: number; grid: GridSpec }> = [];
  for (const [i, src] of sources.entries()) {
    ctx.progress({ phase: `Checking ${src.year}`, fraction: i / sources.length, detail: `${i + 1} of ${sources.length}` });
    await ctx.checkpoint();
    const row: YearInspection = {
      year: src.year,
      ok: false,
      problems: [],
      width: null,
      height: null,
      epsg: null,
      crsName: null,
      cellAreaM2: null,
      statusCounts: null,
      eligible: 0,
    };
    try {
      const loaded = await src.load();
      const { input, grid } = loaded;
      row.width = input.width;
      row.height = input.height;
      row.epsg = grid.epsg;
      row.crsName = grid.crsName;
      row.cellAreaM2 = grid.cellAreaM2;
      row.problems = schemaProblems(input.vars, input.width, input.height);
      if (row.problems.length === 0) {
        const f = extractYear(input);
        assertIntegerFeatures(f);
        row.statusCounts = f.statusCounts;
        row.eligible = f.statusCounts[STATUS.ELIGIBLE];
        if (row.eligible === 0) row.problems.push('No pixel passes the quality rules in this year.');
      }
      grids.push({ year: src.year, grid });
    } catch (err) {
      row.problems.push(err instanceof Error ? err.message : String(err));
    }
    row.ok = row.problems.length === 0;
    years.push(row);
  }
  const crossYear: string[] = [];
  for (let i = 1; i < grids.length; i++) {
    const why = gridMismatch(grids[0].grid, grids[i].grid);
    if (why) crossYear.push(`${grids[i].year} does not share ${grids[0].year}'s grid. ${why}`);
  }
  ctx.progress({ phase: 'Done', fraction: 1 });
  return { years, crossYear };
}

/* ------------------------------------------------------------- pass A */

interface PassA {
  scaler: ScalerParams;
  grid: GridSpec;
  storedScale: Record<string, number>;
  perYearEligible: Record<string, number>;
  eligible: number;
  colMin: Float64Array;
  colMax: Float64Array;
  fingerprints: InputFingerprint[];
  /** Training rows in stored units (row-major), and how they were chosen. */
  train: { rows: Float64Array; n: number; sampled: boolean } | null;
}

function scalesOf(input: YearInput): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of GREENNESS_VARS) if (input.vars[v]) out[v] = input.vars[v]!.scale;
  return out;
}

async function passA(
  sources: YearSource[],
  ctx: PipelineContext,
  sample: { size: number; seed: number } | null,
  phaseShare: [number, number],
): Promise<PassA> {
  const acc = new ScalerAccumulator(N_FEATURES);
  const colMin = new Float64Array(N_SUMMARY).fill(Infinity);
  const colMax = new Float64Array(N_SUMMARY).fill(-Infinity);
  const perYearEligible: Record<string, number> = {};
  const fingerprints: InputFingerprint[] = [];
  let grid: GridSpec | null = null;
  let storedScale: Record<string, number> | null = null;
  const reservoir = sample && sample.size > 0 ? new Reservoir(sample.size, N_FEATURES, sample.seed) : null;
  const keepAll: Float32Array[] = [];
  let keptRows = 0;
  const [p0, p1] = phaseShare;

  for (const [i, src] of sources.entries()) {
    ctx.progress({ phase: `Reading ${src.year}`, fraction: p0 + ((p1 - p0) * i) / sources.length, detail: `${i + 1} of ${sources.length}` });
    await ctx.checkpoint();
    const loaded = await src.load();
    const f = extractYear(loaded.input);
    assertIntegerFeatures(f);
    if (!grid) grid = loaded.grid;
    else {
      const why = gridMismatch(grid, loaded.grid);
      if (why) throw new Error(`${src.year} does not share the first year's grid. ${why} Grids are never resampled.`);
    }
    const scales = scalesOf(loaded.input);
    if (!storedScale) storedScale = scales;
    else {
      for (const [k, v] of Object.entries(scales)) {
        if (storedScale[k] !== v) throw new Error(`${k} is stored with scale ${v} in ${src.year} but ${storedScale[k]} in an earlier year.`);
      }
    }
    fingerprints.push(loaded.fingerprint);
    const m = f.index.length;
    perYearEligible[String(src.year)] = m;
    acc.add(f.features, m);
    for (let c = 0; c < N_SUMMARY; c++) {
      colMin[c] = Math.min(colMin[c], f.colMin[c]);
      colMax[c] = Math.max(colMax[c], f.colMax[c]);
    }
    if (reservoir) {
      for (let r = 0; r < m; r++) {
        reservoir.offer(f.features, r * N_FEATURES);
        if ((r & 0xffff) === 0) await ctx.checkpoint();
      }
    } else if (sample) {
      keptRows += m;
      if (keptRows > MAX_UNSAMPLED_ROWS) {
        throw new Error(
          `This site has more than ${MAX_UNSAMPLED_ROWS.toLocaleString('en-US')} eligible pixel-years, too many to fit without sampling in the browser. Choose a training sample size.`,
        );
      }
      keepAll.push(f.features);
    }
  }
  if (!grid || !storedScale) throw new Error('No years to process.');
  const scaler = acc.finish();

  let train: PassA['train'] = null;
  if (reservoir) {
    train = { rows: reservoir.rows(), n: reservoir.size, sampled: reservoir.offered > reservoir.size };
  } else if (sample) {
    const rows = new Float64Array(keptRows * N_FEATURES);
    let o = 0;
    for (const part of keepAll) {
      rows.set(part, o);
      o += part.length;
    }
    train = { rows, n: keptRows, sampled: false };
  }
  return {
    scaler,
    grid,
    storedScale,
    perYearEligible,
    eligible: scaler.nSamples,
    colMin,
    colMax,
    fingerprints,
    train,
  };
}

/* ---------------------------------------------------------- diagnostics */

export interface DiagnosticsOptions {
  kMin?: number;
  kMax?: number;
  nInit?: number;
  seed?: number;
  sampleSize?: number;
  silhouetteSize?: number;
}

export async function runDiagnostics(sources: YearSource[], opts: DiagnosticsOptions, ctx: PipelineContext): Promise<DiagnosticsResult> {
  const kMin = opts.kMin ?? K_MIN;
  const kMax = opts.kMax ?? K_MAX;
  const nInit = opts.nInit ?? KMEANS_DEFAULTS.nInit;
  const seed = opts.seed ?? KMEANS_DEFAULTS.seed;
  const sampleSize = opts.sampleSize ?? DIAGNOSTIC_SAMPLE;
  const silSize = opts.silhouetteSize ?? SILHOUETTE_SAMPLE;

  const a = await passA(sources, ctx, { size: sampleSize, seed }, [0, 0.25]);
  const { rows, n } = a.train!;
  transform(rows, n, a.scaler, rows);

  // Silhouette subset: the first `silSize` rows of a seeded permutation.
  const rng = new Rng(seed + 1);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const m = Math.min(silSize, n);
  const sub = new Float64Array(m * N_FEATURES);
  for (let i = 0; i < m; i++) sub.set(rows.subarray(perm[i] * N_FEATURES, (perm[i] + 1) * N_FEATURES), i * N_FEATURES);

  const points: DiagnosticsResult['points'] = [];
  const ks = Array.from({ length: kMax - kMin + 1 }, (_, i) => kMin + i);
  for (const [ki, k] of ks.entries()) {
    const base = 0.25 + (0.75 * ki) / ks.length;
    const span = 0.75 / ks.length;
    const res = await fitKMeans(rows, n, N_FEATURES, {
      k,
      nInit,
      seed,
      maxIter: KMEANS_DEFAULTS.maxIter,
      tol: KMEANS_DEFAULTS.tol,
      onIteration: async ({ restart }) => {
        ctx.progress({ phase: `Trying k = ${k}`, fraction: base + span * 0.8 * (restart / nInit), detail: `restart ${restart + 1} of ${nInit}` });
        await ctx.checkpoint();
      },
    });
    const subLabels = new Int32Array(m);
    assign(sub, m, N_FEATURES, res.centers, k, subLabels);
    ctx.progress({ phase: `Trying k = ${k}`, fraction: base + span * 0.85, detail: 'scoring' });
    const sil = await silhouette(sub, m, N_FEATURES, subLabels, k, () => ctx.checkpoint());
    points.push({ k, inertia: res.inertia, silhouette: sil });
  }
  ctx.progress({ phase: 'Done', fraction: 1 });
  return {
    years: sources.map((s) => s.year),
    sampleSize: n,
    silhouetteSampleSize: m,
    nInit,
    seed,
    points,
    note: `Based on a random sample of ${n.toLocaleString('en-US')} pixel-years, with silhouette scored on ${m.toLocaleString('en-US')} of them. Use these as a guide, not an exact answer.`,
  };
}

/* -------------------------------------------------------------- training */

export interface TrainOptions {
  siteId: string;
  k: number;
  nInit?: number;
  seed?: number;
  maxIter?: number;
  tol?: number;
  /** Training rows; 0 = every eligible pixel-year. */
  sampleSize: number;
  diagnostics?: DiagnosticsResult | null;
  /** Apply this saved model instead of fitting one. */
  model?: PhenoclassModel;
  runId?: string;
  createdAt?: string;
}

export async function trainAndClassify(
  sources: YearSource[],
  opts: TrainOptions,
  ctx: PipelineContext,
  sink: RunSink,
): Promise<RunManifest> {
  const t0 = performance.now();
  const durations: Record<string, number> = {};
  const lap = (name: string, since: number) => (durations[name] = Math.round(performance.now() - since));
  const applying = Boolean(opts.model);
  const years = sources.map((s) => s.year);
  if (new Set(years).size !== years.length) throw new Error('Each year may be used once.');
  const k = applying ? opts.model!.kmeans.k : opts.k;
  if (!Number.isInteger(k) || k < K_MIN || k > K_MAX) throw new Error(`The number of classes must be ${K_MIN}–${K_MAX}.`);
  const seed = opts.seed ?? KMEANS_DEFAULTS.seed;
  const nInit = opts.nInit ?? KMEANS_DEFAULTS.nInit;
  const maxIter = opts.maxIter ?? KMEANS_DEFAULTS.maxIter;
  const tol = opts.tol ?? KMEANS_DEFAULTS.tol;
  const warnings: string[] = [];

  /* Pass A */
  const tA = performance.now();
  const a = await passA(sources, ctx, applying ? null : { size: opts.sampleSize, seed }, [0, applying ? 0.3 : 0.25]);
  lap('passA', tA);
  if (!applying && a.eligible < k) {
    throw new Error(`Only ${a.eligible} eligible pixel-years in the selected years, fewer than the ${k} classes requested.`);
  }

  /* Fit, or take the imported model */
  let scaler: ScalerParams;
  let centers: Float64Array;
  let fitInfo: { inertia: number | null; nIter: number | null; converged: boolean | null };
  let training: PhenoclassModel['training'];
  const tFit = performance.now();
  if (applying) {
    const mdl = opts.model!;
    scaler = { mean: mdl.scaler.mean, scale: mdl.scaler.scale, variance: mdl.scaler.variance, nSamples: mdl.scaler.nSamples };
    centers = Float64Array.from(mdl.kmeans.centers.flat());
    fitInfo = { inertia: mdl.kmeans.inertia, nIter: mdl.kmeans.nIter, converged: mdl.kmeans.converged };
    training = mdl.training;
    for (const [name, s] of Object.entries(a.storedScale)) {
      const ms = mdl.featureUnits.storedScale[name];
      if (ms !== undefined && ms !== s) throw new Error(`${name} is stored with scale ${s} here but ${ms} in the model.`);
    }
  } else {
    scaler = a.scaler;
    const train = a.train!;
    transform(train.rows, train.n, scaler, train.rows);
    const res = await fitKMeans(train.rows, train.n, N_FEATURES, {
      k,
      nInit,
      seed,
      maxIter,
      tol,
      onIteration: async ({ restart, iteration }) => {
        ctx.progress({
          phase: `Fitting ${k} classes`,
          fraction: 0.25 + 0.4 * ((restart + Math.min(1, Math.max(0, iteration) / 60)) / nInit),
          detail: `restart ${restart + 1} of ${nInit}`,
        });
        await ctx.checkpoint();
      },
    });
    centers = res.centers;
    fitInfo = { inertia: res.inertia, nIter: res.nIter, converged: res.converged };
    if (!res.converged) warnings.push(`The fit stopped at ${maxIter} iterations before it fully settled.`);
    training = {
      years,
      eligibleRows: a.eligible,
      perYearEligible: a.perYearEligible,
      sampled: train.sampled,
      sampleSize: train.n,
      sampleMethod: train.sampled
        ? 'Uniform random sample without replacement (reservoir sampling over years in order, seeded)'
        : 'All eligible pixel-years',
      sampleSeed: seed,
    };
    if (train.sampled) {
      warnings.push(
        `Model fit on a random sample of ${train.n.toLocaleString('en-US')} of ${a.eligible.toLocaleString('en-US')} pixel-years. Every usable pixel in every selected year was then classified. A fit on all pixel-years could differ slightly.`,
      );
    }
    a.train = null; // release the training matrix before pass B
  }
  lap('fit', tFit);

  /* Pass B */
  const tB = performance.now();
  const n = a.grid.width * a.grid.height;
  const pooled = new MedianAccumulator(k, a.colMin, a.colMax);
  const annualMedians: Record<string, MedianAccumulator> = {};
  const labelsByYear: Uint8Array[] = [];
  const footprintByYear: Uint8Array[] = [];
  const annual: RunManifest['annual'] = [];
  const chunk = new Float64Array(CHUNK * N_FEATURES);
  const chunkLabels = new Int32Array(CHUNK);
  const bStart = applying ? 0.3 : 0.65;
  const bSpan = applying ? 0.55 : 0.25;

  for (const [yi, src] of sources.entries()) {
    ctx.progress({ phase: `Classifying ${src.year}`, fraction: bStart + (bSpan * yi) / sources.length, detail: `${yi + 1} of ${sources.length}` });
    await ctx.checkpoint();
    const loaded = await src.load();
    const f: YearFeatures = extractYear(loaded.input);
    const m = f.index.length;
    if (m !== a.perYearEligible[String(src.year)]) throw new Error(`${src.year} changed while it was being classified.`);
    const labels = new Uint8Array(n);
    const yAcc = new MedianAccumulator(k, a.colMin, a.colMax);
    for (let start = 0; start < m; start += CHUNK) {
      const rows = Math.min(CHUNK, m - start);
      const view = f.features.subarray(start * N_FEATURES, (start + rows) * N_FEATURES);
      transform(view, rows, scaler, chunk);
      assign(chunk, rows, N_FEATURES, centers, k, chunkLabels);
      for (let r = 0; r < rows; r++) {
        const cls = chunkLabels[r];
        labels[f.index[start + r]] = cls + 1;
        pooled.add(cls, f.features, (start + r) * N_FEATURES, f.ogiRaw[start + r]);
        yAcc.add(cls, f.features, (start + r) * N_FEATURES, f.ogiRaw[start + r]);
      }
      await ctx.checkpoint();
    }
    const footprint = new Uint8Array(n);
    for (let i = 0; i < n; i++) footprint[i] = f.status[i] === STATUS.NO_PRODUCT ? 0 : 1;
    labelsByYear.push(labels);
    footprintByYear.push(footprint);
    annualMedians[String(src.year)] = yAcc;
    const cover: AnnualCover = annualCover(src.year, labels, f.status, k, a.grid.cellAreaM2);
    const labelsFile = `labels-${src.year}.u8`;
    const statusFile = `status-${src.year}.u8`;
    await sink.write(labelsFile, labels);
    await sink.write(statusFile, f.status);
    annual.push({ year: src.year, labelsFile, statusFile, cover });
  }
  lap('passB', tB);

  /* Consensus */
  const tC = performance.now();
  let consensus: RunManifest['consensus'] = null;
  let consensusUnavailable: string | null = null;
  if (consensusAvailable(years.length)) {
    ctx.progress({ phase: 'Making consensus map', fraction: 0.92 });
    await ctx.checkpoint();
    const policy = consensusPolicy(years, CONSENSUS_MIN_VALID_YEARS);
    const res = computeConsensus(labelsByYear, footprintByYear, k, policy.minValidYears);
    const files = { cls: 'consensus-class.u8', validYears: 'consensus-valid-years.u8', agreement: 'consensus-agreement.f32' };
    await sink.write(files.cls, res.cls);
    await sink.write(files.validYears, res.validYears);
    await sink.write(files.agreement, res.agreement);
    consensus = { policy, files, cover: consensusCover(policy.label, policy.years, res.cls, res.validYears, k, a.grid.cellAreaM2) };
  } else {
    consensusUnavailable = `A consensus map needs ${CONSENSUS_MIN_VALID_YEARS} or more years.`;
  }
  lap('consensus', tC);

  /* Summaries and waveforms */
  ctx.progress({ phase: 'Summing up classes', fraction: 0.96 });
  await ctx.checkpoint();
  const pooledSummaries = pooled.summaries();
  const annualSummaries: Record<string, ReturnType<MedianAccumulator['summaries']>> = {};
  for (const [y, accY] of Object.entries(annualMedians)) annualSummaries[y] = accY.summaries();

  const s = a.storedScale;
  const eviScale = s.EVImax;
  const scalesAgree = ['EVIamp', 'EVImax_2', 'EVIamp_2'].every((v) => s[v] === eviScale);
  const waveFor = (rows: typeof pooledSummaries) =>
    rows.map((row) => {
      if (row.count === 0) {
        return { classId: row.classId, status: 'invalid' as const, warnings: ['No pixels in this class.'], bimodal: false, day: [], evi: [] };
      }
      const w = reconstructWaveform(row.classId, row.medians, scalesAgree ? eviScale : Number.NaN);
      if (!scalesAgree) w.warnings.push('The two seasons use different EVI scales.');
      return w;
    });
  const waveforms: RunManifest['waveforms'] = {
    pooled: waveFor(pooledSummaries),
    annual: Object.fromEntries(Object.entries(annualSummaries).map(([y, rows]) => [y, waveFor(rows)])),
    eviScale,
    smoothMaxKStored: SMOOTH_MAX_K_STORED,
    smoothMaxKPhysical: SMOOTH_MAX_K_STORED / eviScale,
    note: `Synthetic curves reconstructed from class-median phenometrics (reference method), not observed EVI. Built in stored units (EVI × ${Math.round(1 / eviScale)}) with smooth-max k = ${SMOOTH_MAX_K_STORED}, then scaled by ${eviScale}; equivalent to k = ${Math.round(SMOOTH_MAX_K_STORED / eviScale)} on physical EVI. Day 0 is each pixel's cycle-1 onset (OGI); the axis wraps at ${DOY_PERIOD} days.`,
  };

  const createdAt = opts.createdAt ?? new Date().toISOString();
  const runId = opts.runId ?? newId('run');
  const model: PhenoclassModel = applying
    ? opts.model!
    : {
        schema: MODEL_SCHEMA,
        schemaVersion: MODEL_SCHEMA_VERSION,
        modelId: newId('model'),
        siteId: opts.siteId,
        createdAt,
        method: METHOD_VERSIONS,
        reference: REFERENCE,
        featureOrder: [...FEATURE_ORDER],
        featureUnits: { storedScale: a.storedScale, units: featureUnitLabels(a.storedScale) },
        qaPolicy: { validQaCodes: [1, 2, 3, 4], cycle1MaxQa: QA_MAX_ACCEPTED, cycle2MaxQa: QA_MAX_ACCEPTED, doyPeriod: DOY_PERIOD },
        scaler: {
          mean: scaler.mean,
          scale: scaler.scale,
          variance: scaler.variance,
          nSamples: scaler.nSamples,
          population: 'All eligible pixel-years of the training years',
        },
        kmeans: {
          k,
          centers: Array.from({ length: k }, (_, j) => Array.from(centers.subarray(j * N_FEATURES, (j + 1) * N_FEATURES))),
          nInit,
          seed,
          maxIter,
          tol,
          ...fitInfo,
          implementation: 'WetLSP Explorer TypeScript Lloyd k-means with greedy k-means++ (xoshiro128** RNG)',
        },
        training,
        classColors: CLASS_COLORS.slice(0, k),
        inputs: a.fingerprints,
        grid: { width: a.grid.width, height: a.grid.height, geoTransform: a.grid.geoTransform, epsg: a.grid.epsg, crsWkt: a.grid.crsWkt },
      };

  const manifest: RunManifest = {
    schema: 'wetlsp-phenoclass-run',
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    siteId: opts.siteId,
    createdAt,
    kind: applying ? 'applied' : 'trained',
    model,
    years,
    inputs: a.fingerprints,
    grid: a.grid,
    encoding: ENCODING,
    annual,
    consensus,
    consensusUnavailable,
    summaries: {
      pooled: pooledSummaries,
      annual: annualSummaries,
      population:
        'Pooled: every classified pixel-year across the selected years (pixel-years, not area). Annual: the classified pixels of that year.',
      units: 'Stored units: timing in days since cycle-1 OGI (modulo 365); EVImax/EVIamp in EVI × 10⁴; EVIarea × 10²; OGI_raw in day of year.',
    },
    waveforms,
    diagnostics: opts.diagnostics ?? null,
    warnings,
    durationsMs: { ...durations, total: Math.round(performance.now() - t0) },
  };
  if (CODE.NODATA !== 0) throw new Error('Encoding invariant broken.');
  ctx.progress({ phase: 'Saving', fraction: 0.99 });
  // The manifest goes last: a run directory without one is an incomplete run.
  await sink.write('manifest.json', JSON.stringify(manifest));
  return manifest;
}
