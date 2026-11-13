/**
 * Per-pixel-year feature extraction, matching the reference extractor.
 *
 * Features stay in the NetCDF's *stored* units (EVI × 10⁴, EVIarea × 10²,
 * days), exactly as the reference saw them: WetLSP files carry their scaling
 * in non-CF `scale` attributes, which xarray does not apply. Standardisation
 * makes clustering independent of those units; they only matter for the
 * class summaries and synthetic waveforms, which record them.
 */
import {
  CYCLE1_TIMING,
  CYCLE2_TIMING,
  DOY_PERIOD,
  FEATURE_ORDER,
  N_FEATURES,
  N_SUMMARY,
  QA_MAX_ACCEPTED,
  REQUIRED_VARIABLES,
  STATUS,
  TIMING_FEATURES,
} from './constants';

/** One decoded NetCDF variable. `values` are stored values in north-up row order. */
export interface VariableData {
  values: ArrayLike<number>;
  fill: number | null;
  validMin: number | null;
  validMax: number | null;
  /** stored × scale + offset = physical value. Recorded, never applied to features. */
  scale: number;
  offset: number;
}

export interface YearInput {
  year: number;
  width: number;
  height: number;
  vars: Record<string, VariableData>;
}

export interface YearFeatures {
  year: number;
  /** Per grid cell: a `STATUS` code. */
  status: Uint8Array;
  /** Grid-cell index of each eligible pixel-year, ascending. */
  index: Int32Array;
  /** Eligible rows × 21 features, row-major, in `FEATURE_ORDER`. */
  features: Float32Array;
  /** Raw cycle-1 OGI for each eligible row (interpretation only). */
  ogiRaw: Float32Array;
  /** Count of cells per status code. */
  statusCounts: number[];
  /** Per summary column (21 features + OGI_raw): min and max over eligible rows. */
  colMin: Float64Array;
  colMax: Float64Array;
}

/** Python-style modulo: the result takes the divisor's sign, so it lands in [0, 365). */
export function mod365(x: number): number {
  return ((x % DOY_PERIOD) + DOY_PERIOD) % DOY_PERIOD;
}

/** Problems that make a year unusable, as user-facing sentences. */
export function schemaProblems(vars: Record<string, VariableData | undefined>, width: number, height: number): string[] {
  const problems: string[] = [];
  const missing = REQUIRED_VARIABLES.filter((v) => !vars[v]);
  if (missing.length) problems.push(`Missing required variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  const n = width * height;
  for (const name of REQUIRED_VARIABLES) {
    const v = vars[name];
    if (!v) continue;
    if (v.values.length !== n) problems.push(`${name} has ${v.values.length} cells; the grid has ${n}.`);
    const base = name.replace(/_2$/, '');
    if ((TIMING_FEATURES.has(name) || base === 'OGI') && (v.scale !== 1 || v.offset !== 0)) {
      problems.push(`${name} is stored with scale ${v.scale} and offset ${v.offset}; timing variables must be whole days.`);
    }
  }
  for (const sfx of ['', '_2']) {
    const max = vars[`EVImax${sfx}`];
    const amp = vars[`EVIamp${sfx}`];
    if (max && amp && (max.scale !== amp.scale || max.offset !== 0 || amp.offset !== 0)) {
      problems.push(`EVImax${sfx} and EVIamp${sfx} are stored on different scales, so EVImax − EVIamp is not meaningful.`);
    }
  }
  return problems;
}

function present(v: number, d: VariableData): boolean {
  if (!Number.isFinite(v)) return false;
  if (d.fill !== null && v === d.fill) return false;
  if (d.validMin !== null && v < d.validMin) return false;
  if (d.validMax !== null && v > d.validMax) return false;
  return true;
}

/** A QA class the reference understands: an integer 1–4 that is not fill. */
function qaClass(v: number, d: VariableData): number | null {
  if (!present(v, d) || !Number.isInteger(v) || v < 1 || v > 4) return null;
  return v;
}

/**
 * Extract the 21 clustering features for every eligible cell of one year.
 * Throws when the schema is unusable; individual bad cells only get a status.
 */
export function extractYear(input: YearInput): YearFeatures {
  const { width, height, vars, year } = input;
  const problems = schemaProblems(vars, width, height);
  if (problems.length) throw new Error(`${year}: ${problems.join(' ')}`);
  const n = width * height;

  const V = (name: string) => vars[name]!;
  const qa = V('QA');
  const qa2 = V('QA_2');
  const numCycles = V('NumCycles');
  const ogi = V('OGI');
  const c1NonTiming = ['EVImax', 'EVIamp', 'EVIarea'].map(V);
  const c1Timing = CYCLE1_TIMING.map(V);
  const c2NonTiming = ['EVImax_2', 'EVIamp_2', 'EVIarea_2'].map(V);
  const c2Timing = CYCLE2_TIMING.map(V);

  const status = new Uint8Array(n);
  const statusCounts = [0, 0, 0, 0, 0];
  // First pass: status only, so the feature buffer can be sized exactly.
  for (let i = 0; i < n; i++) {
    const s = cellStatus(i);
    status[i] = s;
    statusCounts[s]++;
  }

  const m = statusCounts[STATUS.ELIGIBLE];
  const index = new Int32Array(m);
  const features = new Float32Array(m * N_FEATURES);
  const ogiRaw = new Float32Array(m);
  const colMin = new Float64Array(N_SUMMARY).fill(Infinity);
  const colMax = new Float64Array(N_SUMMARY).fill(-Infinity);

  let r = 0;
  for (let i = 0; i < n; i++) {
    if (status[i] !== STATUS.ELIGIBLE) continue;
    const o = r * N_FEATURES;
    const anchor = Number(ogi.values[i]);
    const hasC2 = cycle2Usable(i);
    features[o] = Number(numCycles.values[i]);
    features[o + 1] = Number(c1NonTiming[0].values[i]);
    features[o + 2] = Number(c1NonTiming[1].values[i]);
    features[o + 3] = Number(c1NonTiming[2].values[i]);
    for (let t = 0; t < 6; t++) features[o + 4 + t] = mod365(Number(c1Timing[t].values[i]) - anchor);
    features[o + 10] = hasC2 ? 1 : 0;
    for (let t = 0; t < 3; t++) features[o + 11 + t] = hasC2 ? Number(c2NonTiming[t].values[i]) : 0;
    for (let t = 0; t < 7; t++) features[o + 14 + t] = hasC2 ? mod365(Number(c2Timing[t].values[i]) - anchor) : 0;
    index[r] = i;
    ogiRaw[r] = anchor;
    for (let c = 0; c < N_FEATURES; c++) {
      const v = features[o + c];
      if (v < colMin[c]) colMin[c] = v;
      if (v > colMax[c]) colMax[c] = v;
    }
    if (anchor < colMin[N_FEATURES]) colMin[N_FEATURES] = anchor;
    if (anchor > colMax[N_FEATURES]) colMax[N_FEATURES] = anchor;
    r++;
  }

  return { year, status, index, features, ogiRaw, statusCounts, colMin, colMax };

  function cycle2Usable(i: number): boolean {
    const nc = Number(numCycles.values[i]);
    const q2 = qaClass(Number(qa2.values[i]), qa2);
    return nc >= 2 && q2 !== null && q2 <= QA_MAX_ACCEPTED;
  }

  function cellStatus(i: number): number {
    const q = qaClass(Number(qa.values[i]), qa);
    if (q === null) return STATUS.NO_PRODUCT;
    if (q > QA_MAX_ACCEPTED) return STATUS.QA_REJECTED;
    if (!present(Number(numCycles.values[i]), numCycles) || !present(Number(ogi.values[i]), ogi)) {
      return STATUS.MISSING_CYCLE1;
    }
    for (const d of c1NonTiming) if (!present(Number(d.values[i]), d)) return STATUS.MISSING_CYCLE1;
    for (const d of c1Timing) if (!present(Number(d.values[i]), d)) return STATUS.MISSING_CYCLE1;
    if (cycle2Usable(i)) {
      for (const d of c2NonTiming) if (!present(Number(d.values[i]), d)) return STATUS.MISSING_CYCLE2;
      for (const d of c2Timing) if (!present(Number(d.values[i]), d)) return STATUS.MISSING_CYCLE2;
    }
    return STATUS.ELIGIBLE;
  }
}

/** Every feature value must be a whole number for the exact-median histograms. */
export function assertIntegerFeatures(f: YearFeatures): void {
  for (let i = 0; i < f.features.length; i++) {
    if (!Number.isInteger(f.features[i])) {
      const col = FEATURE_ORDER[i % N_FEATURES];
      throw new Error(
        `${f.year}: ${col} holds fractional stored values. WetLSP phenometrics are integer-coded; this file is not a supported product.`,
      );
    }
  }
}
