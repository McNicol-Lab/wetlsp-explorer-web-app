/**
 * Parity with the reference: fixtures produced by `scripts/phenoclass_reference.py`,
 * which runs the notebook's own `extract_feature_matrix` and waveform functions
 * and scikit-learn 1.9 (StandardScaler, KMeans).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_ORDER, N_FEATURES, REQUIRED_VARIABLES, STATUS } from './constants';
import { extractYear, mod365, type VariableData } from './features';
import { fitScaler, transform } from './scaler';
import { fitKMeans, predict } from './kmeans';
import { reconstructWaveform, smoothMax } from './waveform';

interface Case {
  height: number;
  width: number;
  inputs: Record<string, number[]>;
  featureNames: string[];
  validCells: number[];
  features: number[][];
  ogiRaw: number[];
  scaler: { mean: number[]; var: number[]; scale: number[]; n: number };
  kmeans: { k: number; centers: number[][]; inertia: number; predict: number[] };
}
const ref = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'reference-small.json'), 'utf8')) as {
  cases: Case[];
  waveforms: Array<{ class: number; medians: Record<string, number>; curveStored: number[] }>;
  smoothMax: Array<{ a: number; b: number; k: number; value: number }>;
};

const VALID: Record<string, [number, number]> = {
  NumCycles: [0, 6],
  QA: [1, 4],
  QA_2: [1, 4],
};
function varsOf(c: Case): Record<string, VariableData> {
  const out: Record<string, VariableData> = {};
  for (const name of REQUIRED_VARIABLES) {
    const base = name.replace(/_2$/, '');
    const [lo, hi] =
      VALID[name] ?? (base === 'Peak' ? [1, 366] : base.startsWith('EVI') ? [0, base === 'EVIarea' ? 32766 : 10000] : [-181, 548]);
    out[name] = {
      values: Int16Array.from(c.inputs[name]),
      fill: 32767,
      validMin: lo,
      validMax: hi,
      scale: base === 'EVIarea' ? 0.01 : base.startsWith('EVI') ? 0.0001 : 1,
      offset: 0,
    };
  }
  return out;
}

const relClose = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

describe('feature extraction matches the notebook extractor', () => {
  ref.cases.forEach((c, ci) => {
    it(`case ${ci}: same eligible cells, same 21 features in the same order`, () => {
      expect(c.featureNames).toEqual([...FEATURE_ORDER]);
      const f = extractYear({ year: 2024, width: c.width, height: c.height, vars: varsOf(c) });
      expect(Array.from(f.index)).toEqual(c.validCells);
      for (let r = 0; r < c.validCells.length; r++) {
        expect(Array.from(f.features.subarray(r * N_FEATURES, (r + 1) * N_FEATURES))).toEqual(c.features[r]);
      }
      expect(Array.from(f.ogiRaw)).toEqual(c.ogiRaw);
    });
  });

  it('records why each hand-made edge case was excluded', () => {
    const c = ref.cases[0];
    const f = extractYear({ year: 2024, width: c.width, height: c.height, vars: varsOf(c) });
    expect(f.status[0]).toBe(STATUS.QA_REJECTED);
    expect(f.status[1]).toBe(STATUS.NO_PRODUCT);
    expect(f.status[3]).toBe(STATUS.MISSING_CYCLE1);
    expect(f.status[5]).toBe(STATUS.MISSING_CYCLE2);
    expect(f.status[8]).toBe(STATUS.MISSING_CYCLE1);
    // QA_2 = 4 and QA_2 fill both zero-fill cycle 2 instead of excluding the pixel.
    for (const cell of [4, 6]) {
      expect(f.status[cell]).toBe(STATUS.ELIGIBLE);
      const r = Array.from(f.index).indexOf(cell);
      const row = Array.from(f.features.subarray(r * N_FEATURES, (r + 1) * N_FEATURES));
      expect(row.slice(10)).toEqual(new Array(11).fill(0));
    }
    expect(f.statusCounts.reduce((a, b) => a + b, 0)).toBe(c.width * c.height);
  });

  it('wraps onset-relative timing with Python modulo semantics', () => {
    expect(mod365(-40)).toBe(325);
    expect(mod365(365)).toBe(0);
    expect(mod365(400)).toBe(35);
    expect(mod365(-365)).toBe(0);
  });

  it('rejects negative fill sentinels and non-integer QA codes', () => {
    const c = ref.cases[0];
    const vars = varsOf(c);
    const qa = Int16Array.from(c.inputs.QA);
    qa[2] = -9999; // undeclared sentinel: not a QA class
    vars.QA = { ...vars.QA, values: qa, validMin: null, validMax: null };
    const f = extractYear({ year: 2024, width: c.width, height: c.height, vars });
    expect(f.status[2]).toBe(STATUS.NO_PRODUCT);
    const fq = Float32Array.from(c.inputs.QA);
    fq[2] = 2.5;
    vars.QA = { ...vars.QA, values: fq };
    expect(extractYear({ year: 2024, width: c.width, height: c.height, vars }).status[2]).toBe(STATUS.NO_PRODUCT);
  });

  it('treats infinities and NaN as missing, not as values', () => {
    const c = ref.cases[0];
    const vars = varsOf(c);
    const e = Float32Array.from(c.inputs.EVImax);
    e[2] = Infinity;
    e[7] = Number.NaN;
    vars.EVImax = { ...vars.EVImax, values: e, validMin: null, validMax: null };
    const f = extractYear({ year: 2024, width: c.width, height: c.height, vars });
    expect(f.status[2]).toBe(STATUS.MISSING_CYCLE1);
    expect(f.status[7]).toBe(STATUS.MISSING_CYCLE1);
  });

  it('refuses a file with a missing required variable, naming it', () => {
    const c = ref.cases[0];
    const vars = varsOf(c);
    delete vars.OGMn_2;
    expect(() => extractYear({ year: 2023, width: c.width, height: c.height, vars })).toThrow(/OGMn_2/);
  });
});

describe('StandardScaler and k-means against scikit-learn', () => {
  ref.cases.forEach((c, ci) => {
    const x = Float64Array.from(c.features.flat());
    const n = c.features.length;

    it(`case ${ci}: scaler mean, variance and scale (incl. constant features)`, () => {
      const p = fitScaler(x, n, N_FEATURES);
      expect(p.nSamples).toBe(c.scaler.n);
      for (let f = 0; f < N_FEATURES; f++) {
        expect(relClose(p.mean[f], c.scaler.mean[f], 1e-12)).toBe(true);
        expect(relClose(p.variance[f], c.scaler.var[f], 1e-9)).toBe(true);
        expect(relClose(p.scale[f], c.scaler.scale[f], 1e-9)).toBe(true);
      }
    });

    it(`case ${ci}: fixed-centroid predictions equal scikit-learn's predict`, () => {
      const p = fitScaler(x, n, N_FEATURES);
      const xs = transform(x, n, p);
      const centers = Float64Array.from(c.kmeans.centers.flat());
      expect(Array.from(predict(xs, n, N_FEATURES, centers, c.kmeans.k))).toEqual(c.kmeans.predict);
    });

    it(`case ${ci}: a fresh fit reaches scikit-learn's inertia and partition (up to relabelling)`, async () => {
      const p = fitScaler(x, n, N_FEATURES);
      const xs = transform(x, n, p);
      const res = await fitKMeans(xs, n, N_FEATURES, { k: 3, nInit: 20, seed: 42, maxIter: 300, tol: 1e-4 });
      expect(res.inertia).toBeLessThanOrEqual(c.kmeans.inertia * (1 + 1e-9));
      // Same partition: every one of our clusters maps to exactly one sklearn cluster.
      const pairs = new Map<number, Set<number>>();
      res.labels.forEach((l, i) => {
        if (!pairs.has(l)) pairs.set(l, new Set());
        pairs.get(l)!.add(c.kmeans.predict[i]);
      });
      if (Math.abs(res.inertia - c.kmeans.inertia) <= 1e-9 * c.kmeans.inertia) {
        for (const s of pairs.values()) expect(s.size).toBe(1);
      }
    });
  });

  it('is deterministic for a seed', async () => {
    const c = ref.cases[0];
    const x = transform(Float64Array.from(c.features.flat()), c.features.length, fitScaler(c.features.flat(), c.features.length, N_FEATURES));
    const a = await fitKMeans(x, c.features.length, N_FEATURES, { k: 4, nInit: 5, seed: 42, maxIter: 300, tol: 1e-4 });
    const b = await fitKMeans(x, c.features.length, N_FEATURES, { k: 4, nInit: 5, seed: 42, maxIter: 300, tol: 1e-4 });
    expect(Array.from(a.centers)).toEqual(Array.from(b.centers));
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
  });

  it('refuses k larger than the rows or the distinct points', async () => {
    const x = Float64Array.from([0, 0, 0, 0, 1, 1]);
    await expect(fitKMeans(x, 3, 2, { k: 4, nInit: 1, seed: 1, maxIter: 10, tol: 1e-4 })).rejects.toThrow(/at least one row per class/);
    await expect(fitKMeans(x, 3, 2, { k: 3, nInit: 1, seed: 1, maxIter: 10, tol: 1e-4 })).rejects.toThrow(/2 distinct/);
  });
});

describe('synthetic waveforms match the notebook reconstruction', () => {
  it('smooth maximum, including the ln(2)/k lift at equal inputs', () => {
    for (const s of ref.smoothMax) expect(smoothMax(s.a, s.b, s.k)).toBeCloseTo(s.value, 9);
    expect(smoothMax(1000, 1000, 0.15) - 1000).toBeCloseTo(Math.log(2) / 0.15, 9);
  });

  it.each(ref.waveforms.map((w) => [w.class, w] as const))('class %i, from the published class medians', (_cls, w) => {
    const scale = 0.0001;
    const out = reconstructWaveform(w.class + 1, w.medians, scale);
    expect(out.status).not.toBe('invalid');
    expect(out.evi).toHaveLength(365);
    let maxErr = 0;
    out.evi.forEach((v, i) => (maxErr = Math.max(maxErr, Math.abs(v / scale - w.curveStored[i]))));
    expect(maxErr).toBeLessThan(1e-6);
    expect(out.bimodal).toBe(w.medians.has_cycle2 >= 0.5);
  });

  it('flags the reference class whose cycle-2 medians are out of seasonal order', () => {
    const c5 = ref.waveforms.find((w) => w.class === 5)!;
    const out = reconstructWaveform(6, c5.medians, 0.0001);
    expect(out.status).toBe('inconsistent');
    expect(out.warnings.join(' ')).toMatch(/Cycle 2/);
    const c0 = ref.waveforms.find((w) => w.class === 0)!;
    expect(reconstructWaveform(1, c0.medians, 0.0001).status).toBe('ok');
  });

  it('is periodic: the curve closes smoothly across day 364 → 0', () => {
    for (const w of ref.waveforms) {
      const out = reconstructWaveform(w.class + 1, w.medians, 0.0001);
      const jump = Math.abs(out.evi[364] - out.evi[0]);
      const step = Math.max(...out.evi.slice(1).map((v, i) => Math.abs(v - out.evi[i])));
      expect(jump).toBeLessThanOrEqual(step + 1e-12);
    }
  });

  it('applies the EVI scale once, after reconstruction (k = 0.15 stored ≡ 1500 physical)', () => {
    const w = ref.waveforms[0];
    const physical = Object.fromEntries(
      Object.entries(w.medians).map(([k, v]) => [k, /^EVI(max|amp)/.test(k) ? v * 0.0001 : v]),
    );
    const viaStored = reconstructWaveform(1, w.medians, 0.0001).evi;
    const viaPhysical = reconstructWaveform(1, physical, 1, 1500).evi;
    viaStored.forEach((v, i) => expect(v).toBeCloseTo(viaPhysical[i], 9));
    const bimodal = ref.waveforms.find((x) => x.medians.has_cycle2 >= 0.5)!;
    const physB = Object.fromEntries(Object.entries(bimodal.medians).map(([k, v]) => [k, /^EVI(max|amp)/.test(k) ? v * 0.0001 : v]));
    const a = reconstructWaveform(2, bimodal.medians, 0.0001).evi;
    const b = reconstructWaveform(2, physB, 1, 1500).evi;
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
    // Applying 0.15 to physical units instead is a different, wrong curve.
    const wrong = reconstructWaveform(2, physB, 1, 0.15).evi;
    expect(Math.max(...wrong.map((v, i) => Math.abs(v - a[i])))).toBeGreaterThan(1);
  });

  it('refuses to draw when a median is missing or a width degenerates', () => {
    const w = { ...ref.waveforms[0].medians, Peak: null as unknown as number };
    expect(reconstructWaveform(1, w, 0.0001).status).toBe('invalid');
    const flat = { ...ref.waveforms[0].medians, '50PCGI': 75, OGMx: 75, Peak: 0 };
    const out = reconstructWaveform(1, { ...flat, Peak: 0 }, 0.0001);
    // OGI = Peak = 0 makes the rising width ill-defined; the reconstruction says so.
    expect(out.status).not.toBe('ok');
  });
});
