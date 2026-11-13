/**
 * Exact per-class medians of integer features, by counting.
 *
 * Every feature (and raw OGI) is a whole number, so a histogram per class and
 * column gives the exact median over millions of pixel-years without sorting
 * or holding them. Medians follow NumPy/pandas: the mean of the two middle
 * values when the count is even.
 */
import { N_SUMMARY, SUMMARY_COLUMNS } from './constants';

export interface ClassSummary {
  /** 1…k. */
  classId: number;
  count: number;
  /** Median per summary column, in stored units; null when the class is empty. */
  medians: Record<string, number | null>;
  /** Share of this population's pixel-years with a usable second cycle. */
  cycle2Fraction: number | null;
}

export class MedianAccumulator {
  private readonly hist: Uint32Array[];
  private readonly counts: Float64Array;
  private readonly c2: Float64Array;

  constructor(
    readonly k: number,
    private readonly lo: Float64Array,
    hi: Float64Array,
  ) {
    if (lo.length !== N_SUMMARY || hi.length !== N_SUMMARY) throw new Error('Median bounds must cover every summary column.');
    this.hist = [];
    for (let cls = 0; cls < k; cls++) {
      for (let c = 0; c < N_SUMMARY; c++) {
        const width = Number.isFinite(lo[c]) && Number.isFinite(hi[c]) ? hi[c] - lo[c] + 1 : 0;
        if (width > 1 << 20) throw new Error(`${SUMMARY_COLUMNS[c]} spans ${width} values; too wide for exact medians.`);
        this.hist.push(new Uint32Array(Math.max(0, width)));
      }
    }
    this.counts = new Float64Array(k);
    this.c2 = new Float64Array(k);
  }

  /** One row: 21 features followed by raw OGI, for 0-based class `cls`. */
  add(cls: number, features: ArrayLike<number>, offset: number, ogiRaw: number): void {
    this.counts[cls]++;
    const base = cls * N_SUMMARY;
    for (let c = 0; c < N_SUMMARY; c++) {
      const v = c < N_SUMMARY - 1 ? features[offset + c] : ogiRaw;
      this.hist[base + c][v - this.lo[c]]++;
    }
    if (features[offset + 10] === 1) this.c2[cls]++;
  }

  count(cls: number): number {
    return this.counts[cls];
  }

  median(cls: number, col: number): number | null {
    const n = this.counts[cls];
    if (n === 0) return null;
    const h = this.hist[cls * N_SUMMARY + col];
    const lower = Math.floor((n - 1) / 2);
    const upper = Math.ceil((n - 1) / 2);
    let seen = 0;
    let a: number | null = null;
    for (let b = 0; b < h.length; b++) {
      seen += h[b];
      if (a === null && seen > lower) a = b + this.lo[col];
      if (seen > upper) {
        const bv = b + this.lo[col];
        return ((a ?? bv) + bv) / 2;
      }
    }
    return a;
  }

  summaries(): ClassSummary[] {
    const out: ClassSummary[] = [];
    for (let cls = 0; cls < this.k; cls++) {
      const medians: Record<string, number | null> = {};
      SUMMARY_COLUMNS.forEach((name, c) => (medians[name] = this.median(cls, c)));
      const n = this.counts[cls];
      out.push({ classId: cls + 1, count: n, medians, cycle2Fraction: n ? this.c2[cls] / n : null });
    }
    return out;
  }
}
