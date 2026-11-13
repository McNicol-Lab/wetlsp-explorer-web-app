/**
 * K-means following scikit-learn's `KMeans(init="k-means++", algorithm="lloyd")`:
 *  - greedy k-means++ seeding with 2 + ⌊ln k⌋ local trials per centre;
 *  - Lloyd iterations until labels stop changing ("strict convergence") or the
 *    total squared centre shift falls to tol × mean feature variance;
 *  - a final assignment step when stopped on tolerance, so labels match centres;
 *  - empty clusters re-seeded at the points farthest from their centres;
 *  - best of `nInit` restarts by inertia, all drawn from one seeded stream.
 *
 * The random stream differs from NumPy's, so the same seed gives a different
 * (equally valid) local optimum ordering than scikit-learn. Labels are 0-based
 * here; the app shows and exports them as 1…k.
 */
import { Rng } from './rng';

export interface KMeansOptions {
  k: number;
  nInit: number;
  seed: number;
  maxIter: number;
  tol: number;
  /** Called between iterations; throw from it to cancel. */
  onIteration?: (info: { restart: number; iteration: number; nInit: number }) => void | Promise<void>;
}

export interface KMeansResult {
  centers: Float64Array;
  labels: Int32Array;
  inertia: number;
  nIter: number;
  converged: boolean;
  restarts: Array<{ inertia: number; nIter: number; converged: boolean }>;
}

/** Distinct rows, capped: enough to know whether k clusters are possible. */
export function countDistinctRows(x: Float64Array, n: number, d: number, cap: number): number {
  const seen = new Set<string>();
  for (let i = 0; i < n && seen.size < cap; i++) {
    seen.add(Array.prototype.join.call(x.subarray(i * d, (i + 1) * d), ','));
  }
  return seen.size;
}

function sqDist(x: Float64Array, i: number, c: Float64Array, j: number, d: number): number {
  let s = 0;
  const a = i * d;
  const b = j * d;
  for (let f = 0; f < d; f++) {
    const t = x[a + f] - c[b + f];
    s += t * t;
  }
  return s;
}

/** Nearest centre for every row (ties go to the lowest index, like argmin). */
export function assign(
  x: Float64Array,
  n: number,
  d: number,
  centers: Float64Array,
  k: number,
  labels: Int32Array,
  dist?: Float64Array,
): number {
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const dd = sqDist(x, i, centers, j, d);
      if (dd < bestD) {
        bestD = dd;
        best = j;
      }
    }
    labels[i] = best;
    if (dist) dist[i] = bestD;
    inertia += bestD;
  }
  return inertia;
}

/** Greedy k-means++ (scikit-learn's `_kmeans_plusplus`). */
export function kmeansPlusPlus(x: Float64Array, n: number, d: number, k: number, rng: Rng): Float64Array {
  const centers = new Float64Array(k * d);
  const nLocal = 2 + Math.floor(Math.log(k));
  const first = rng.int(n);
  centers.set(x.subarray(first * d, (first + 1) * d), 0);

  const closest = new Float64Array(n);
  let pot = 0;
  for (let i = 0; i < n; i++) {
    closest[i] = sqDist(x, i, centers, 0, d);
    pot += closest[i];
  }

  const cand = new Float64Array(nLocal * n);
  const cum = new Float64Array(n);
  for (let c = 1; c < k; c++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += closest[i];
      cum[i] = acc;
    }
    const ids: number[] = [];
    for (let t = 0; t < nLocal; t++) {
      const r = rng.next() * pot;
      // searchsorted(cum, r), clipped to the last index.
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      ids.push(lo);
    }
    let bestT = 0;
    let bestPot = Infinity;
    for (let t = 0; t < nLocal; t++) {
      const id = ids[t];
      let p = 0;
      const o = t * n;
      for (let i = 0; i < n; i++) {
        const dd = Math.min(closest[i], sqDist(x, i, x, id, d));
        cand[o + i] = dd;
        p += dd;
      }
      if (p < bestPot) {
        bestPot = p;
        bestT = t;
      }
    }
    pot = bestPot;
    closest.set(cand.subarray(bestT * n, (bestT + 1) * n));
    const id = ids[bestT];
    centers.set(x.subarray(id * d, (id + 1) * d), c * d);
  }
  return centers;
}

/** Mean of the per-feature population variances: scikit-learn's tolerance base. */
export function meanVariance(x: Float64Array, n: number, d: number): number {
  let total = 0;
  for (let f = 0; f < d; f++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i * d + f];
    const m = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const t = x[i * d + f] - m;
      v += t * t;
    }
    total += v / n;
  }
  return total / d;
}

async function lloyd(
  x: Float64Array,
  n: number,
  d: number,
  k: number,
  init: Float64Array,
  maxIter: number,
  tolAbs: number,
  hook: (iteration: number) => void | Promise<void>,
): Promise<{ centers: Float64Array; labels: Int32Array; inertia: number; nIter: number; converged: boolean }> {
  let centers = Float64Array.from(init);
  let next = new Float64Array(k * d);
  const labels = new Int32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n);
  const counts = new Float64Array(k);
  let strict = false;
  let toleranceMet = false;
  let it = 0;

  for (; it < maxIter; it++) {
    assign(x, n, d, centers, k, labels, dist);
    next.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const j = labels[i];
      counts[j]++;
      const a = i * d;
      const b = j * d;
      for (let f = 0; f < d; f++) next[b + f] += x[a + f];
    }
    relocateEmpty(x, n, d, k, labels, dist, counts, next);
    for (let j = 0; j < k; j++) {
      if (counts[j] === 0) continue;
      for (let f = 0; f < d; f++) next[j * d + f] /= counts[j];
    }
    let shift = 0;
    for (let q = 0; q < k * d; q++) {
      const t = next[q] - centers[q];
      shift += t * t;
    }
    [centers, next] = [next, centers];

    let same = true;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== prev[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      strict = true;
      break;
    }
    if (shift <= tolAbs) {
      toleranceMet = true;
      break;
    }
    prev.set(labels);
    await hook(it);
  }
  // Stopped on tolerance or max_iter: reassign so labels match the final centres.
  const inertia = assign(x, n, d, centers, k, labels);
  return { centers, labels, inertia, nIter: it + 1, converged: strict || toleranceMet };
}

/**
 * scikit-learn's `_relocate_empty_clusters_dense`: each empty cluster takes one
 * of the points farthest from its current centre, and that point's
 * contribution moves from its old cluster's sum to the empty one.
 */
function relocateEmpty(
  x: Float64Array,
  n: number,
  d: number,
  k: number,
  labels: Int32Array,
  dist: Float64Array,
  counts: Float64Array,
  sums: Float64Array,
): void {
  const empty: number[] = [];
  for (let j = 0; j < k; j++) if (counts[j] === 0) empty.push(j);
  if (empty.length === 0) return;
  const far = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => dist[b] - dist[a])
    .slice(0, empty.length);
  empty.forEach((j, e) => {
    const i = far[e];
    const old = labels[i];
    for (let f = 0; f < d; f++) {
      sums[old * d + f] -= x[i * d + f];
      sums[j * d + f] = x[i * d + f];
    }
    counts[old]--;
    counts[j] = 1;
    labels[i] = j;
  });
}

export async function fitKMeans(x: Float64Array, n: number, d: number, opts: KMeansOptions): Promise<KMeansResult> {
  const { k, nInit, seed, maxIter, tol } = opts;
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, not ${k}.`);
  if (n < k) throw new Error(`Only ${n} training rows for ${k} classes; k-means needs at least one row per class.`);
  const distinct = countDistinctRows(x, n, d, k);
  if (distinct < k) {
    throw new Error(`The training rows contain only ${distinct} distinct feature vectors, fewer than the ${k} classes requested.`);
  }
  const tolAbs = tol * meanVariance(x, n, d);
  const rng = new Rng(seed);
  let best: KMeansResult | null = null;
  const restarts: KMeansResult['restarts'] = [];
  for (let r = 0; r < nInit; r++) {
    const init = kmeansPlusPlus(x, n, d, k, rng);
    await opts.onIteration?.({ restart: r, iteration: -1, nInit });
    const res = await lloyd(x, n, d, k, init, maxIter, tolAbs, (iteration) => opts.onIteration?.({ restart: r, iteration, nInit }));
    restarts.push({ inertia: res.inertia, nIter: res.nIter, converged: res.converged });
    if (!best || res.inertia < best.inertia) best = { ...res, restarts };
  }
  return { ...best!, restarts };
}

/** Predict with fixed centres: the only path used on annual maps. */
export function predict(x: Float64Array, n: number, d: number, centers: Float64Array, k: number): Int32Array {
  const labels = new Int32Array(n);
  assign(x, n, d, centers, k, labels);
  return labels;
}

/** Mean silhouette over a sample, with scikit-learn's convention that singletons score 0. */
export async function silhouette(
  x: Float64Array,
  n: number,
  d: number,
  labels: Int32Array,
  k: number,
  tick?: () => void | Promise<void>,
): Promise<number> {
  const sizes = new Float64Array(k);
  for (let i = 0; i < n; i++) sizes[labels[i]]++;
  const sums = new Float64Array(k);
  let total = 0;
  for (let i = 0; i < n; i++) {
    sums.fill(0);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      sums[labels[j]] += Math.sqrt(sqDist(x, i, x, j, d));
    }
    const own = labels[i];
    if (sizes[own] <= 1) continue;
    const a = sums[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || sizes[c] === 0) continue;
      b = Math.min(b, sums[c] / sizes[c]);
    }
    if (!Number.isFinite(b)) continue;
    const m = Math.max(a, b);
    total += m === 0 ? 0 : (b - a) / m;
    if (tick && i % 250 === 0) await tick();
  }
  return total / n;
}
