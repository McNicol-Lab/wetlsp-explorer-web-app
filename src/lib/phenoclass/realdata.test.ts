/**
 * Real-data acceptance checks, run only when the data is present:
 *
 *   WETLSP_SITE_DIR=…/US-Myb PHENOCLASS_REF_DIR=… [PHENOCLASS_OUT_DIR=…] npx vitest run realdata
 *
 * PHENOCLASS_REF_DIR holds `scripts/phenoclass_reference.py realdata` output
 * (the notebook's extractor + scikit-learn on the same files). With
 * PHENOCLASS_OUT_DIR set, the run's GeoTIFFs and raw arrays are written there
 * for `scripts/phenoclass_validate_geotiff.py` to check with GDAL.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_ORDER, METHOD_VERSIONS, MODEL_SCHEMA, N_FEATURES, REFERENCE } from './constants';
import { decodeYear, withH5File } from './h5source';
import { extractYear } from './features';
import { trainAndClassify, type LoadedYear, type YearSource } from './pipeline';
import type { PhenoclassModel, RunManifest } from './model';
import { annualGeoTiff, consensusGeoTiffs } from './exports';

const SITE_DIR = process.env.WETLSP_SITE_DIR;
const REF_DIR = process.env.PHENOCLASS_REF_DIR;
const OUT_DIR = process.env.PHENOCLASS_OUT_DIR;
const ready = Boolean(SITE_DIR && REF_DIR && existsSync(join(REF_DIR, 'reference.json')));
const SITE = process.env.WETLSP_SITE_ID ?? (SITE_DIR ? basename(resolve(SITE_DIR)) : 'US-Myb');
const YEARS = [2021, 2022, 2023, 2024];

interface Ref {
  perYear: Array<{ year: number; valid: number; colSum: number[]; colSumSq: number[] }>;
  scaler: { mean: number[]; var: number[]; scale: number[]; n: number };
  kmeans: { centers: number[][]; inertia: number; counts: number[] };
  medians: Record<string, Record<string, number>>;
}

function source(year: number): YearSource {
  return {
    year,
    load: async (): Promise<LoadedYear> => {
      const path = join(SITE_DIR!, `${SITE}-wetlsp-${year}.nc`);
      const bytes = new Uint8Array(readFileSync(path));
      const d = await withH5File(bytes, (f) => decodeYear(f, year));
      return { input: d.input, grid: d.grid, fingerprint: { year, path, size: statSync(path).size, sha256: 'test', importedAt: 0 } };
    },
  };
}

const ctx = { progress: () => undefined, checkpoint: async () => undefined };
const memorySink = () => {
  const files = new Map<string, Uint8Array | Float32Array | string>();
  return { files, sink: { write: async (n: string, d: Uint8Array | Float32Array | string) => void files.set(n, d) } };
};

describe.skipIf(!ready)(`real data: ${SITE} 2021–2024 against the notebook + scikit-learn`, () => {
  const ref = ready ? (JSON.parse(readFileSync(join(REF_DIR!, 'reference.json'), 'utf8')) as Ref) : null!;

  it('extracts the same eligible pixel-years and identical feature totals per year', async () => {
    for (const p of ref.perYear) {
      const loaded = await source(p.year).load();
      expect(loaded.grid.flipRows).toBe(true); // v001: rows south-first under north-up coordinates
      const f = extractYear(loaded.input);
      expect(f.index.length).toBe(p.valid);
      for (let c = 0; c < N_FEATURES; c++) {
        let s = 0;
        let s2 = 0;
        for (let r = 0; r < f.index.length; r++) {
          const v = f.features[r * N_FEATURES + c];
          s += v;
          s2 += v * v;
        }
        expect(s).toBe(p.colSum[c]);
        expect(s2).toBe(p.colSumSq[c]);
      }
    }
  }, 120_000);

  it('applies scikit-learn\'s fitted scaler and centroids and reproduces its labels cell for cell', async () => {
    const model = {
      schema: MODEL_SCHEMA,
      schemaVersion: 1,
      modelId: 'sklearn-reference',
      siteId: SITE,
      createdAt: '',
      method: METHOD_VERSIONS,
      reference: REFERENCE,
      featureOrder: [...FEATURE_ORDER],
      featureUnits: { storedScale: {}, units: [] },
      qaPolicy: { validQaCodes: [1, 2, 3, 4], cycle1MaxQa: 3, cycle2MaxQa: 3, doyPeriod: 365 },
      scaler: { mean: ref.scaler.mean, scale: ref.scaler.scale, variance: ref.scaler.var, nSamples: ref.scaler.n, population: 'sklearn' },
      kmeans: { k: 7, centers: ref.kmeans.centers, nInit: 20, seed: 42, maxIter: 300, tol: 1e-4, inertia: ref.kmeans.inertia, nIter: null, converged: true, implementation: 'scikit-learn' },
      training: null,
      classColors: [],
      inputs: [],
      grid: { width: 0, height: 0, geoTransform: [0, 1, 0, 0, 0, -1], epsg: null, crsWkt: null },
    } satisfies PhenoclassModel;
    const { files, sink } = memorySink();
    const run = await trainAndClassify(YEARS.map(source), { siteId: SITE, k: 7, sampleSize: 0, model }, ctx, sink);
    let differ = 0;
    let total = 0;
    for (const y of YEARS) {
      const ours = files.get(`labels-${y}.u8`) as Uint8Array;
      const theirs = new Uint8Array(readFileSync(join(REF_DIR!, `sklearn-labels-${y}.u8`)));
      expect(ours.length).toBe(theirs.length);
      for (let i = 0; i < ours.length; i++) {
        if (theirs[i] !== 0) total++;
        if (ours[i] !== theirs[i]) differ++;
      }
    }
    // Near-equidistant points may round differently between BLAS and plain loops; none expected.
    console.info(`fixed-model labels: ${differ} of ${total} pixel-years differ from scikit-learn`);
    expect(differ / total).toBeLessThan(1e-5);
    // Exact pooled medians match pandas' groupby().median() on the same labels.
    for (const s of run.summaries.pooled) {
      const pd = ref.medians[String(s.classId)];
      for (const name of FEATURE_ORDER) expect(s.medians[name]).toBe(pd[name]);
    }
  }, 300_000);

  it('trains its own model (sampled), classifies at full resolution and exports GeoTIFFs', async () => {
    const { files, sink } = memorySink();
    const t0 = performance.now();
    const run: RunManifest = await trainAndClassify(YEARS.map(source), { siteId: SITE, k: 7, sampleSize: 200_000 }, ctx, sink);
    const seconds = (performance.now() - t0) / 1000;
    expect(run.model.training?.sampled).toBe(true);
    expect(run.model.scaler.nSamples).toBe(ref.scaler.n);
    for (let c = 0; c < N_FEATURES; c++) {
      expect(Math.abs(run.model.scaler.mean[c] - ref.scaler.mean[c])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ref.scaler.mean[c])));
      expect(Math.abs(run.model.scaler.scale[c] - ref.scaler.scale[c])).toBeLessThanOrEqual(1e-9 * Math.max(1, ref.scaler.scale[c]));
    }
    // Every eligible pixel-year is classified, and cover totals add up.
    for (const a of run.annual) {
      const p = ref.perYear.find((q) => q.year === a.year)!;
      expect(a.cover.classifiedCells).toBe(p.valid);
      expect(a.cover.rows.reduce((n, r) => n + r.count, 0)).toBe(p.valid);
      expect(a.cover.gridCells).toBe(run.grid.width * run.grid.height);
    }
    const cons = run.consensus!;
    expect(cons.policy.isFourYear).toBe(true);
    const cc = cons.cover;
    expect(cc.classifiedCells + cc.ambiguousCells + cc.insufficientCells + cc.noValidYearCells).toBe(cc.footprintCells);

    // Inertia of our centroids over all 3.17M rows, against scikit-learn's full-data fit.
    const inertia = await fullInertia(run);
    console.info(
      `own fit: ${seconds.toFixed(1)} s total (${JSON.stringify(run.durationsMs)}); full-data inertia ${inertia.toFixed(0)} vs scikit-learn ${ref.kmeans.inertia.toFixed(0)} (${((inertia / ref.kmeans.inertia - 1) * 100).toFixed(3)} %)`,
    );
    expect(inertia / ref.kmeans.inertia).toBeLessThan(1.02);
    const agreement = await bestMatchAgreement(files);
    console.info(`label agreement with scikit-learn after optimal relabelling: ${(agreement * 100).toFixed(2)} %`);

    if (OUT_DIR) {
      mkdirSync(OUT_DIR, { recursive: true });
      for (const y of YEARS) {
        const labels = files.get(`labels-${y}.u8`) as Uint8Array;
        writeFileSync(join(OUT_DIR, `classes_${y}.tif`), annualGeoTiff(run, y, labels));
        writeFileSync(join(OUT_DIR, `expected-labels-${y}.u8`), labels);
      }
      const c = {
        cls: files.get(cons.files.cls) as Uint8Array,
        validYears: files.get(cons.files.validYears) as Uint8Array,
        agreement: files.get(cons.files.agreement) as Float32Array,
      };
      for (const t of consensusGeoTiffs(run, c)) writeFileSync(join(OUT_DIR, t.name), t.bytes);
      writeFileSync(join(OUT_DIR, 'expected-consensus-class.u8'), c.cls);
      writeFileSync(join(OUT_DIR, 'expected-consensus-valid-years.u8'), c.validYears);
      writeFileSync(join(OUT_DIR, 'expected-consensus-agreement.f32'), new Uint8Array(c.agreement.buffer));
      writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(run, null, 2));
    }
  }, 900_000);
});

async function fullInertia(run: RunManifest): Promise<number> {
  const k = run.model.kmeans.k;
  const centers = run.model.kmeans.centers.flat();
  const { mean, scale } = run.model.scaler;
  let total = 0;
  for (const y of YEARS) {
    const f = extractYear((await source(y).load()).input);
    for (let r = 0; r < f.index.length; r++) {
      let best = Infinity;
      for (let j = 0; j < k; j++) {
        let s = 0;
        for (let c = 0; c < N_FEATURES; c++) {
          const t = (f.features[r * N_FEATURES + c] - mean[c]) / scale[c] - centers[j * N_FEATURES + c];
          s += t * t;
        }
        if (s < best) best = s;
      }
      total += best;
    }
  }
  return total;
}

/** Fraction of pixel-years on which the two labelings agree under the best class matching. */
async function bestMatchAgreement(files: Map<string, Uint8Array | Float32Array | string>): Promise<number> {
  const k = 7;
  const conf = Array.from({ length: k }, () => new Array(k).fill(0));
  let total = 0;
  for (const y of YEARS) {
    const ours = files.get(`labels-${y}.u8`) as Uint8Array;
    const theirs = new Uint8Array(readFileSync(join(REF_DIR!, `sklearn-labels-${y}.u8`)));
    for (let i = 0; i < ours.length; i++) {
      if (ours[i] === 0 || theirs[i] === 0) continue;
      conf[ours[i] - 1][theirs[i] - 1]++;
      total++;
    }
  }
  let best = 0;
  const perm: number[] = [];
  const used = new Array(k).fill(false);
  const walk = (i: number, acc: number) => {
    if (i === k) {
      best = Math.max(best, acc);
      return;
    }
    for (let j = 0; j < k; j++) {
      if (used[j]) continue;
      used[j] = true;
      perm[i] = j;
      walk(i + 1, acc + conf[i][j]);
      used[j] = false;
    }
  };
  walk(0, 0);
  return best / total;
}
