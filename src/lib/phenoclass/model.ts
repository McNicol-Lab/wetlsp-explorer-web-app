/**
 * Saved model and analysis-run records, and validation of model files a user
 * imports. A model is plain numbers (scaler statistics and centroids); nothing
 * in it is ever executed.
 */
import {
  CODE,
  DOY_PERIOD,
  FEATURE_ORDER,
  K_MAX,
  K_MIN,
  METHOD_VERSIONS,
  MODEL_SCHEMA,
  MODEL_SCHEMA_VERSION,
  N_FEATURES,
  QA_MAX_ACCEPTED,
  REFERENCE,
  RUN_SCHEMA_VERSION,
} from './constants';
import type { AnnualCover, ConsensusCover } from './cover';
import type { ConsensusPolicy } from './consensus';
import type { GridSpec } from './grid';
import type { ClassSummary } from './summary';
import type { Waveform } from './waveform';

export interface InputFingerprint {
  year: number;
  path: string;
  size: number;
  sha256: string;
  /** The site manifest's import time when the run was made; a re-import changes it. */
  importedAt: number;
}

export interface FeatureUnits {
  /** Stored → physical multiplier for each greenness variable, from the files. */
  storedScale: Record<string, number>;
  /** Human-readable unit of each feature column, in order. */
  units: string[];
}

export interface PhenoclassModel {
  schema: typeof MODEL_SCHEMA;
  schemaVersion: number;
  modelId: string;
  siteId: string;
  createdAt: string;
  method: typeof METHOD_VERSIONS;
  reference: typeof REFERENCE;
  featureOrder: string[];
  featureUnits: FeatureUnits;
  qaPolicy: { validQaCodes: number[]; cycle1MaxQa: number; cycle2MaxQa: number; doyPeriod: number };
  scaler: { mean: number[]; scale: number[]; variance: number[]; nSamples: number; population: string };
  kmeans: {
    k: number;
    centers: number[][];
    nInit: number;
    seed: number;
    maxIter: number;
    tol: number;
    inertia: number | null;
    nIter: number | null;
    converged: boolean | null;
    implementation: string;
  };
  training: {
    years: number[];
    eligibleRows: number;
    perYearEligible: Record<string, number>;
    sampled: boolean;
    sampleSize: number;
    sampleMethod: string;
    sampleSeed: number;
  } | null;
  classColors: string[];
  inputs: InputFingerprint[];
  grid: Pick<GridSpec, 'width' | 'height' | 'geoTransform' | 'epsg' | 'crsWkt'>;
}

export interface DiagnosticsResult {
  years: number[];
  sampleSize: number;
  silhouetteSampleSize: number;
  nInit: number;
  seed: number;
  points: Array<{ k: number; inertia: number; silhouette: number }>;
  note: string;
}

export interface RunManifest {
  schema: 'wetlsp-phenoclass-run';
  schemaVersion: number;
  runId: string;
  siteId: string;
  createdAt: string;
  kind: 'trained' | 'applied';
  model: PhenoclassModel;
  years: number[];
  /** The exact files this run read; a mismatch with the site's current files makes it stale. */
  inputs: InputFingerprint[];
  grid: GridSpec;
  encoding: {
    nodata: number;
    ambiguous: number;
    insufficient: number;
    outside: number;
    classIds: string;
  };
  annual: Array<{ year: number; labelsFile: string; statusFile: string; cover: AnnualCover }>;
  consensus: {
    policy: ConsensusPolicy;
    files: { cls: string; validYears: string; agreement: string };
    cover: ConsensusCover;
  } | null;
  /** Why no consensus was made, when it was not. */
  consensusUnavailable: string | null;
  summaries: {
    pooled: ClassSummary[];
    annual: Record<string, ClassSummary[]>;
    population: string;
    units: string;
  };
  waveforms: {
    pooled: Waveform[];
    annual: Record<string, Waveform[]>;
    eviScale: number;
    smoothMaxKStored: number;
    smoothMaxKPhysical: number;
    note: string;
  };
  diagnostics: DiagnosticsResult | null;
  warnings: string[];
  durationsMs: Record<string, number>;
}

export const ENCODING: RunManifest['encoding'] = {
  nodata: CODE.NODATA,
  ambiguous: CODE.AMBIGUOUS,
  insufficient: CODE.INSUFFICIENT,
  outside: CODE.OUTSIDE,
  classIds: '1…k are classes; 0 is no data (outside the footprint, excluded or missing).',
};

export function featureUnitLabels(storedScale: Record<string, number>): string[] {
  return FEATURE_ORDER.map((f) => {
    if (f === 'NumCycles') return 'cycles';
    if (f === 'has_cycle2') return '0/1 flag';
    const base = f.replace(/_2$/, '');
    if (base === 'EVImax' || base === 'EVIamp' || base === 'EVIarea') {
      const s = storedScale[f];
      return s ? `stored value (× ${s} = physical)` : 'stored value';
    }
    return `days since cycle-1 OGI, modulo ${DOY_PERIOD}`;
  });
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export { MODEL_SCHEMA, MODEL_SCHEMA_VERSION, RUN_SCHEMA_VERSION };

const finiteArray = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Check a model file before it is used. Returns the model, or throws with every
 * problem found. `siteId` is the site it would be applied to.
 */
export function validateModel(raw: unknown, siteId: string, storedScale?: Record<string, number>): PhenoclassModel {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') throw new Error('The file is not a JSON object.');
  const m = raw as Partial<PhenoclassModel>;
  if (m.schema !== MODEL_SCHEMA) problems.push(`Not a WetLSP phenology-class model (schema "${String(m.schema)}").`);
  if (m.schemaVersion !== MODEL_SCHEMA_VERSION) problems.push(`Unsupported model schema version ${String(m.schemaVersion)}.`);
  if (m.method?.features !== METHOD_VERSIONS.features) {
    problems.push(`Feature method "${String(m.method?.features)}" differs from this app's "${METHOD_VERSIONS.features}".`);
  }
  if (!Array.isArray(m.featureOrder) || m.featureOrder.join('|') !== FEATURE_ORDER.join('|')) {
    problems.push('Feature order does not match the 21 reference features.');
  }
  const k = m.kmeans?.k;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < K_MIN || k > K_MAX) problems.push(`k must be ${K_MIN}–${K_MAX}.`);
  const centers = m.kmeans?.centers;
  if (!Array.isArray(centers) || centers.length !== k || !centers.every((c) => finiteArray(c, N_FEATURES))) {
    problems.push(`Centroids must be ${String(k)} rows of ${N_FEATURES} finite numbers.`);
  }
  if (!finiteArray(m.scaler?.mean, N_FEATURES)) problems.push('Scaler means must be 21 finite numbers.');
  if (!finiteArray(m.scaler?.scale, N_FEATURES) || !m.scaler!.scale.every((s) => s > 0)) {
    problems.push('Scaler scales must be 21 positive finite numbers.');
  }
  const qa = m.qaPolicy;
  if (!qa || qa.cycle1MaxQa !== QA_MAX_ACCEPTED || qa.cycle2MaxQa !== QA_MAX_ACCEPTED || qa.doyPeriod !== DOY_PERIOD) {
    problems.push('QA thresholds or the 365-day timing convention differ from this app.');
  }
  if (m.siteId !== siteId) {
    problems.push(`This model was trained for ${String(m.siteId)}. Models are site-specific; train one for ${siteId} instead.`);
  }
  if (storedScale && m.featureUnits?.storedScale) {
    for (const [name, s] of Object.entries(storedScale)) {
      const ms = m.featureUnits.storedScale[name];
      if (ms !== undefined && ms !== s) problems.push(`${name} is stored with scale ${s} here but ${ms} in the model.`);
    }
  }
  if (problems.length) throw new Error(problems.join(' '));
  return m as PhenoclassModel;
}
