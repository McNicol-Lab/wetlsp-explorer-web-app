/**
 * Multi-year consensus, policy `consensus-unique-majority-min3/1`.
 *
 * A deliberate departure from the reference notebook, whose `scipy.stats.mode`
 * lets "no data" (−1) vote and breaks ties by the smallest value:
 *  - missing years never vote and never become a class;
 *  - a cell needs at least `minValid` valid annual labels;
 *  - the most frequent class must be unique, otherwise the cell is ambiguous;
 *  - agreement = winning votes / valid years (temporal consistency, not a probability).
 */
import { CODE, CONSENSUS_MIN_VALID_YEARS } from './constants';

export interface ConsensusResult {
  /** 1…k, `CODE.AMBIGUOUS`, `CODE.INSUFFICIENT`, or `CODE.NODATA` (no valid year). */
  cls: Uint8Array;
  /** Valid annual labels per cell, or `CODE.OUTSIDE` when outside the footprint every year. */
  validYears: Uint8Array;
  /** Votes for the most frequent class (shared by tied classes). */
  votes: Uint8Array;
  /** votes / validYears; NaN where there is no valid year. */
  agreement: Float32Array;
}

export interface ConsensusPolicy {
  version: string;
  years: number[];
  minValidYears: number;
  /** "Four-year consensus" only when exactly four years went in. */
  label: string;
  isFourYear: boolean;
}

export function consensusPolicy(years: number[], minValidYears = CONSENSUS_MIN_VALID_YEARS): ConsensusPolicy {
  const sorted = [...years].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    version: 'consensus-unique-majority-min3/1',
    years: sorted,
    minValidYears,
    label: n === 4 ? 'Four-year consensus' : `${n}-year consensus`,
    isFourYear: n === 4,
  };
}

/** Whether a consensus can be formed at all from this many annual maps. */
export function consensusAvailable(nYears: number, minValidYears = CONSENSUS_MIN_VALID_YEARS): boolean {
  return nYears >= minValidYears;
}

/**
 * @param labels one array per year: 0 = no data, 1…k = class.
 * @param inFootprint one array per year: non-zero where the product has a value.
 */
export function computeConsensus(
  labels: Uint8Array[],
  inFootprint: Uint8Array[],
  k: number,
  minValidYears = CONSENSUS_MIN_VALID_YEARS,
): ConsensusResult {
  if (labels.length === 0) throw new Error('A consensus needs at least one annual map.');
  if (labels.length > 254) throw new Error('Too many years for an 8-bit consensus.');
  const n = labels[0].length;
  for (const l of [...labels, ...inFootprint]) {
    if (l.length !== n) throw new Error('Annual maps differ in size; they must share one grid.');
  }
  const cls = new Uint8Array(n);
  const validYears = new Uint8Array(n);
  const votes = new Uint8Array(n);
  const agreement = new Float32Array(n);
  const counts = new Uint8Array(k + 1);

  for (let i = 0; i < n; i++) {
    counts.fill(0);
    let valid = 0;
    let anyFootprint = false;
    for (let y = 0; y < labels.length; y++) {
      const v = labels[y][i];
      if (inFootprint[y][i]) anyFootprint = true;
      if (v >= 1 && v <= k) {
        counts[v]++;
        valid++;
      }
    }
    if (!anyFootprint && valid === 0) {
      validYears[i] = CODE.OUTSIDE;
      cls[i] = CODE.NODATA;
      agreement[i] = Number.NaN;
      continue;
    }
    validYears[i] = valid;
    if (valid === 0) {
      cls[i] = CODE.NODATA;
      agreement[i] = Number.NaN;
      continue;
    }
    let best = 0;
    let bestCount = 0;
    let tied = false;
    for (let c = 1; c <= k; c++) {
      if (counts[c] > bestCount) {
        bestCount = counts[c];
        best = c;
        tied = false;
      } else if (counts[c] === bestCount && bestCount > 0) {
        tied = true;
      }
    }
    votes[i] = bestCount;
    agreement[i] = bestCount / valid;
    if (valid < minValidYears) cls[i] = CODE.INSUFFICIENT;
    else if (tied) cls[i] = CODE.AMBIGUOUS;
    else cls[i] = best;
  }
  return { cls, validYears, votes, agreement };
}
