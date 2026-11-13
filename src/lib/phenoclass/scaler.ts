/**
 * StandardScaler, matching scikit-learn's definition: population variance
 * (ddof = 0), and a scale of exactly 1 for constant features.
 *
 * Statistics accumulate in exact integer arithmetic (features are integers),
 * so they can stream over every eligible pixel-year without holding them all.
 */

export interface ScalerParams {
  mean: number[];
  /** Standard deviation, or 1 where the feature is constant. */
  scale: number[];
  /** Population variance, as scikit-learn's `var_`. */
  variance: number[];
  nSamples: number;
}

const EPS = 2 ** -52;

/** scikit-learn's `_is_constant_feature`: variance within rounding of zero. */
export function isConstantFeature(variance: number, mean: number, n: number): boolean {
  const upper = n * EPS * variance + (n * mean * EPS) ** 2;
  return variance <= upper;
}

export class ScalerAccumulator {
  private n = 0;
  private readonly sum: bigint[];
  private readonly sumSq: bigint[];
  /** Number accumulators flushed into the BigInts before they can lose precision. */
  private readonly partSum: Float64Array;
  private readonly partSq: Float64Array;
  private partRows = 0;

  constructor(private readonly d: number) {
    this.sum = new Array(d).fill(0n);
    this.sumSq = new Array(d).fill(0n);
    this.partSum = new Float64Array(d);
    this.partSq = new Float64Array(d);
  }

  /** Add `rows` rows of a row-major integer matrix. */
  add(x: ArrayLike<number>, rows: number): void {
    const d = this.d;
    for (let r = 0; r < rows; r++) {
      const o = r * d;
      for (let c = 0; c < d; c++) {
        const v = x[o + c];
        this.partSum[c] += v;
        this.partSq[c] += v * v;
      }
      // |v| < 2^15, so v² < 2^30; 2^22 rows keep every partial sum below 2^53.
      if (++this.partRows >= 1 << 22) this.flush();
    }
    this.n += rows;
  }

  private flush(): void {
    for (let c = 0; c < this.d; c++) {
      this.sum[c] += BigInt(this.partSum[c]);
      this.sumSq[c] += BigInt(this.partSq[c]);
      this.partSum[c] = 0;
      this.partSq[c] = 0;
    }
    this.partRows = 0;
  }

  get count(): number {
    return this.n;
  }

  finish(): ScalerParams {
    this.flush();
    const n = this.n;
    if (n === 0) throw new Error('No eligible pixel-years to fit the scaler on.');
    const N = BigInt(n);
    const mean: number[] = [];
    const variance: number[] = [];
    const scale: number[] = [];
    for (let c = 0; c < this.d; c++) {
      const s = this.sum[c];
      // var = (n·Σx² − (Σx)²) / n², exact in integers until the final division.
      const numer = N * this.sumSq[c] - s * s;
      const m = Number(s) / n;
      const v = Number(numer) / (n * n);
      mean.push(m);
      variance.push(v);
      const sd = Math.sqrt(v);
      scale.push(isConstantFeature(v, m, n) || sd < 10 * EPS ? 1 : sd);
    }
    return { mean, scale, variance, nSamples: n };
  }
}

/** Fit directly on an in-memory integer matrix. */
export function fitScaler(x: ArrayLike<number>, rows: number, d: number): ScalerParams {
  const acc = new ScalerAccumulator(d);
  acc.add(x, rows);
  return acc.finish();
}

/** (x − mean) / scale, into a new float64 matrix. */
export function transform(x: ArrayLike<number>, rows: number, p: ScalerParams, out?: Float64Array): Float64Array {
  const d = p.mean.length;
  const res = out ?? new Float64Array(rows * d);
  for (let r = 0; r < rows; r++) {
    const o = r * d;
    for (let c = 0; c < d; c++) res[o + c] = (x[o + c] - p.mean[c]) / p.scale[c];
  }
  return res;
}
