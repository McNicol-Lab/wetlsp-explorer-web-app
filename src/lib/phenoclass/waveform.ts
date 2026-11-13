/**
 * Synthetic class waveforms, reconstructed from class-median phenometrics.
 *
 * Reference method: each cycle is an asymmetric Gaussian centred on Peak, its
 * rising width fitted to OGI/50PCGI/OGMx at 15/50/90 % of amplitude and its
 * falling width to OGD/50PCGD/OGMn at 90/50/15 %, measured as circular
 * distances on a 365-day onset-relative axis, tapered by cos²(π·d/365), on a
 * baseline of EVImax − EVIamp. A second cycle is added when the class median
 * has_cycle2 ≥ 0.5, merged with a log-sum-exp smooth maximum.
 *
 * Units: the reference ran on stored values (EVI × 10⁴) with smooth-max
 * sharpness 0.15. The curve is reconstructed in those same stored units and
 * only then multiplied by the EVI scale, so 0.15 is never applied to
 * incompatible units. (Equivalently, k = 0.15 / 10⁻⁴ = 1500 in physical EVI.)
 *
 * These are reconstructions, not observed EVI time series.
 */
import { DOY_PERIOD, SMOOTH_MAX_K_STORED } from './constants';

export type WaveformStatus = 'ok' | 'inconsistent' | 'invalid';

export interface Waveform {
  classId: number;
  status: WaveformStatus;
  /** Plain-language reasons for a non-ok status. */
  warnings: string[];
  bimodal: boolean;
  /** Onset-relative day, 0…364. */
  day: number[];
  /** Physical EVI (stored × evIScale); empty when invalid. */
  evi: number[];
}

/** Shortest signed distance from t to centre on the circular axis, in [−P/2, P/2). */
export function circularDistance(t: number, centre: number, period = DOY_PERIOD): number {
  const v = t - centre + period / 2;
  return (((v % period) + period) % period) - period / 2;
}

/** σ from f(d) = exp(−d² / 2σ²) at three anchors: sqrt(mean of the per-anchor σ²). */
export function fitSigma(days: number[], fracs: number[], centre: number, period = DOY_PERIOD): number {
  let s = 0;
  for (let i = 0; i < days.length; i++) {
    const d = circularDistance(days[i], centre, period);
    const f = Math.min(0.999999, Math.max(1e-6, fracs[i]));
    s += -(d * d) / (2 * Math.log(f));
  }
  return Math.sqrt(s / days.length);
}

/** Log-sum-exp smooth maximum, in the reference's numerically stable form. */
export function smoothMax(a: number, b: number, k: number): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp((a - m) * k) + Math.exp((b - m) * k)) / k;
}

export type MedianRow = Record<string, number | null>;

interface CycleCurve {
  values: number[];
  warnings: string[];
  valid: boolean;
}

const RISE = ['OGI', '50PCGI', 'OGMx'];
const FALL = ['OGD', '50PCGD', 'OGMn'];

function buildCycle(row: MedianRow, suffix: '' | '_2', axis: number[], period: number): CycleCurve {
  const warnings: string[] = [];
  const get = (name: string): number | null => {
    if (name === 'OGI' && suffix === '') return 0; // cycle-1 OGI is the onset anchor
    const v = row[`${name}${suffix}`];
    return v === null || v === undefined || !Number.isFinite(v) ? null : v;
  };
  const names = [...RISE, 'Peak', ...FALL, 'EVImax', 'EVIamp'];
  const vals = Object.fromEntries(names.map((n) => [n, get(n)])) as Record<string, number | null>;
  const missing = names.filter((n) => vals[n] === null);
  const cycle = suffix === '' ? 'Cycle 1' : 'Cycle 2';
  if (missing.length) return { values: [], warnings: [`${cycle}: missing ${missing.join(', ')}.`], valid: false };

  const v = vals as Record<string, number>;
  const peak = v.Peak;
  const amp = v.EVIamp;
  const base = v.EVImax - amp;
  if (amp < 0) return { values: [], warnings: [`${cycle}: EVI rise is negative.`], valid: false };

  // Seasonal order, measured forward from this cycle's onset.
  const onset = v.OGI;
  const order = [...RISE, 'Peak', ...FALL].map((n) => ((((v[n] - onset) % period) + period) % period));
  for (let i = 1; i < order.length; i++) {
    if (order[i] < order[i - 1]) {
      warnings.push(`${cycle}: dates are out of order (${[...RISE, 'Peak', ...FALL][i - 1]} comes after ${[...RISE, 'Peak', ...FALL][i]}).`);
      break;
    }
  }
  for (const n of RISE) {
    if (circularDistance(v[n], peak, period) > 0) {
      warnings.push(`${cycle}: ${n} comes after the peak.`);
      break;
    }
  }
  for (const n of FALL) {
    if (circularDistance(v[n], peak, period) < 0) {
      warnings.push(`${cycle}: ${n} comes before the peak.`);
      break;
    }
  }

  const sigR = fitSigma(RISE.map((n) => v[n]), [0.15, 0.5, 0.9], peak, period);
  const sigF = fitSigma(FALL.map((n) => v[n]), [0.9, 0.5, 0.15], peak, period);
  if (!(sigR > 0) || !(sigF > 0) || !Number.isFinite(sigR) || !Number.isFinite(sigF)) {
    return { values: [], warnings: [...warnings, `${cycle}: the curve has no width.`], valid: false };
  }

  const values = axis.map((t) => {
    const d = circularDistance(t, peak, period);
    const taper = Math.cos((Math.PI * d) / period) ** 2;
    const s = d <= 0 ? sigR : sigF;
    return base + amp * Math.exp(-(d * d) / (2 * s * s)) * taper;
  });
  return { values, warnings, valid: values.every(Number.isFinite) };
}

/**
 * @param row class medians in stored units (as `ClassSummary.medians`).
 * @param eviScale stored → physical EVI multiplier (the file's `scale`, 0.0001).
 */
export function reconstructWaveform(
  classId: number,
  row: MedianRow,
  eviScale: number,
  smoothK = SMOOTH_MAX_K_STORED,
  period = DOY_PERIOD,
): Waveform {
  const axis = Array.from({ length: period }, (_, i) => i);
  const c1 = buildCycle(row, '', axis, period);
  const hasC2 = (row.has_cycle2 ?? 0) >= 0.5;
  const warnings = [...c1.warnings];
  let stored = c1.values;
  let valid = c1.valid;
  if (hasC2) {
    const c2 = buildCycle(row, '_2', axis, period);
    warnings.push(...c2.warnings);
    valid = valid && c2.valid;
    if (valid) stored = c1.values.map((a, i) => smoothMax(a, c2.values[i], smoothK));
  }
  if (!Number.isFinite(eviScale) || eviScale <= 0) {
    return { classId, status: 'invalid', warnings: [...warnings, 'The EVI scale is unknown.'], bimodal: hasC2, day: axis, evi: [] };
  }
  if (!valid) return { classId, status: 'invalid', warnings, bimodal: hasC2, day: axis, evi: [] };
  return {
    classId,
    status: warnings.length ? 'inconsistent' : 'ok',
    warnings,
    bimodal: hasC2,
    day: axis,
    evi: stored.map((s) => s * eviScale),
  };
}
