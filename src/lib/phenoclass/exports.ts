/**
 * Export artefacts for a saved run: GeoTIFFs, CSVs, model and manifest JSON,
 * and the README that explains them. Pure functions of the run's manifest and
 * arrays, so the bundle is reproducible and testable without a browser.
 */
import { toCsv } from '@/lib/csv';
import { CODE, REFERENCE, STATUS, STATUS_LABELS, SUMMARY_COLUMNS } from './constants';
import { writeGeoTiff } from './geotiff';
import type { RunManifest } from './model';
import { classColor, geotiffPalette } from './palette';
import type { ZipEntry } from '@/lib/zipWrite';

export interface RunArrays {
  labels: Record<string, Uint8Array>;
  consensus: { cls: Uint8Array; validYears: Uint8Array; agreement: Float32Array } | null;
}

const slug = (s: string) => s.replace(/[^\w.-]+/g, '-');
export const runSlug = (m: RunManifest) => `${slug(m.siteId)}_k${m.model.kmeans.k}_${m.runId.split('-').slice(1).join('')}`;

function describe(m: RunManifest, what: string): string {
  return `WetLSP Explorer phenology classes: ${what}. Site ${m.siteId}; model ${m.model.modelId}; k=${m.model.kmeans.k}; years ${m.years.join(', ')}; run ${m.runId}. ${m.encoding.classIds}`;
}

export function annualGeoTiff(m: RunManifest, year: number, labels: Uint8Array): Uint8Array {
  return writeGeoTiff({
    grid: m.grid,
    data: labels,
    nodata: CODE.NODATA,
    palette: geotiffPalette(m.model.kmeans.k),
    description: describe(m, `annual classes ${year}`),
    software: 'WetLSP Explorer',
  });
}

export function consensusGeoTiffs(m: RunManifest, c: NonNullable<RunArrays['consensus']>): Array<{ name: string; bytes: Uint8Array }> {
  const label = m.consensus?.policy.label ?? 'consensus';
  return [
    {
      name: 'consensus_class.tif',
      bytes: writeGeoTiff({
        grid: m.grid,
        data: c.cls,
        nodata: CODE.NODATA,
        palette: geotiffPalette(m.model.kmeans.k),
        description: describe(m, `${label} class (${CODE.AMBIGUOUS} = ambiguous tie, ${CODE.INSUFFICIENT} = fewer than ${m.consensus?.policy.minValidYears} valid years)`),
        software: 'WetLSP Explorer',
      }),
    },
    {
      name: 'consensus_valid_years.tif',
      bytes: writeGeoTiff({
        grid: m.grid,
        data: c.validYears,
        nodata: CODE.OUTSIDE,
        description: describe(m, `number of valid annual classifications (${CODE.OUTSIDE} = outside the footprint in every year)`),
        software: 'WetLSP Explorer',
      }),
    },
    {
      name: 'consensus_agreement.tif',
      bytes: writeGeoTiff({
        grid: m.grid,
        data: c.agreement,
        nodata: 'nan',
        description: describe(m, 'agreement fraction = votes for the most frequent class / valid years'),
        software: 'WetLSP Explorer',
      }),
    },
  ];
}

const fmt = (v: number | null, digits = 4) => (v === null || !Number.isFinite(v) ? '' : Number(v.toFixed(digits)));

export function coverCsv(m: RunManifest): string {
  const header = [
    'site_id', 'run_id', 'period', 'years', 'class', 'cells', 'pct_of_classified', 'pct_of_footprint', 'area_m2',
    'classified_cells', 'footprint_cells', 'grid_cells', 'note',
  ];
  const rows: unknown[][] = [];
  for (const a of m.annual) {
    const c = a.cover;
    for (const r of c.rows) {
      rows.push([m.siteId, m.runId, String(a.year), String(a.year), r.classId, r.count, fmt(r.pctClassified), fmt(r.pctFootprint), fmt(r.areaM2, 1), c.classifiedCells, c.footprintCells, c.gridCells, '']);
    }
    for (const s of [STATUS.QA_REJECTED, STATUS.MISSING_CYCLE1, STATUS.MISSING_CYCLE2] as const) {
      rows.push([m.siteId, m.runId, String(a.year), String(a.year), `excluded:${s}`, c.statusCounts[s], '', fmt((100 * c.statusCounts[s]) / Math.max(1, c.footprintCells)), fmt(c.cellAreaM2 === null ? null : c.statusCounts[s] * c.cellAreaM2, 1), c.classifiedCells, c.footprintCells, c.gridCells, STATUS_LABELS[s]]);
    }
    rows.push([m.siteId, m.runId, String(a.year), String(a.year), 'outside_footprint', c.statusCounts[STATUS.NO_PRODUCT], '', '', '', c.classifiedCells, c.footprintCells, c.gridCells, STATUS_LABELS[STATUS.NO_PRODUCT]]);
  }
  if (m.consensus) {
    const c = m.consensus.cover;
    const period = c.label;
    const yrs = c.years.join(' ');
    for (const r of c.rows) {
      rows.push([m.siteId, m.runId, period, yrs, r.classId, r.count, fmt(r.pctClassified), fmt(r.pctFootprint), fmt(r.areaM2, 1), c.classifiedCells, c.footprintCells, c.gridCells, '']);
    }
    const extra: Array<[string, number, string]> = [
      ['ambiguous', c.ambiguousCells, 'Tied most-frequent classes'],
      ['insufficient', c.insufficientCells, `Fewer than ${m.consensus.policy.minValidYears} valid years`],
      ['no_valid_year', c.noValidYearCells, 'In the footprint but never classified'],
    ];
    for (const [cls, n, note] of extra) {
      rows.push([m.siteId, m.runId, period, yrs, cls, n, '', fmt((100 * n) / Math.max(1, c.footprintCells)), fmt(c.cellAreaM2 === null ? null : n * c.cellAreaM2, 1), c.classifiedCells, c.footprintCells, c.gridCells, note]);
    }
  }
  return toCsv(header, rows);
}

export function summaryCsv(m: RunManifest): string {
  const header = ['site_id', 'run_id', 'population', 'class', 'pixel_years', 'cycle2_fraction', ...SUMMARY_COLUMNS];
  const rows: unknown[][] = [];
  const add = (pop: string, list: RunManifest['summaries']['pooled']) =>
    list.forEach((s) => rows.push([m.siteId, m.runId, pop, s.classId, s.count, fmt(s.cycle2Fraction), ...SUMMARY_COLUMNS.map((c) => s.medians[c] ?? '')]));
  add('pooled', m.summaries.pooled);
  for (const [y, list] of Object.entries(m.summaries.annual)) add(y, list);
  return toCsv(header, rows);
}

export function waveformCsv(m: RunManifest, population: string = 'pooled'): string {
  const list = population === 'pooled' ? m.waveforms.pooled : m.waveforms.annual[population] ?? [];
  const header = ['site_id', 'run_id', 'population', 'class', 'status', 'bimodal', 'day_since_onset', 'synthetic_evi', 'method'];
  const rows: unknown[][] = [];
  for (const w of list) {
    if (w.evi.length === 0) {
      rows.push([m.siteId, m.runId, population, w.classId, w.status, w.bimodal, '', '', m.model.method.waveform]);
      continue;
    }
    w.day.forEach((d, i) => rows.push([m.siteId, m.runId, population, w.classId, w.status, w.bimodal, d, Number(w.evi[i].toFixed(6)), m.model.method.waveform]));
  }
  return toCsv(header, rows);
}

export function legendCsv(m: RunManifest): string {
  const k = m.model.kmeans.k;
  const rows: unknown[][] = [];
  for (let c = 1; c <= k; c++) rows.push([c, `Class ${c}`, classColor(c), 'Unsupervised phenological cluster; not a vegetation or land-cover label']);
  rows.push([CODE.NODATA, 'No data', '', 'Outside the footprint, excluded by QA, or a missing value (GDAL nodata)']);
  rows.push([CODE.INSUFFICIENT, 'Insufficient valid years', '#a8b0bc', 'Consensus raster only']);
  rows.push([CODE.AMBIGUOUS, 'Ambiguous (tie)', '#4b5563', 'Consensus raster only']);
  return toCsv(['code', 'label', 'color', 'meaning'], rows);
}

export function modelJson(m: RunManifest): string {
  return JSON.stringify(m.model, null, 2);
}

/** Self-contained class-cover object for analysis outside the Explorer. */
export function coverJson(m: RunManifest): string {
  return JSON.stringify({
    schema: 'wetlsp-class-cover',
    schemaVersion: 1,
    siteId: m.siteId,
    runId: m.runId,
    modelId: m.model.modelId,
    createdAt: m.createdAt,
    years: m.years,
    k: m.model.kmeans.k,
    grid: m.grid,
    definitions: {
      pctClassified: 'Percent of cells that received a class in this period.',
      pctFootprint: 'Percent of cells with a valid QA code (consensus: in any selected year).',
      areaM2: 'Planar square metres in a metric projected CRS; null otherwise.',
      statusCodes: STATUS_LABELS,
      classIds: 'Classes are 1 through k and refer only to this model; they are not vegetation types.',
    },
    annual: m.annual.map(({ cover }) => cover),
    consensus: m.consensus ? { policy: m.consensus.policy, ...m.consensus.cover } : null,
    consensusUnavailable: m.consensusUnavailable,
  }, null, 2);
}

export function readme(m: RunManifest): string {
  const t = m.model.training;
  const k = m.model.kmeans.k;
  return `# Phenology classes: ${m.siteId}

Exported by WetLSP Explorer on ${new Date().toISOString().slice(0, 10)}.
Run \`${m.runId}\` (${m.kind === 'trained' ? 'model trained in this run' : 'saved model applied'}), model \`${m.model.modelId}\`, created ${m.createdAt}.

## What these are

Unsupervised **phenological clusters** (k-means, k = ${k}) of WetLSP annual phenometrics for one site.
They group pixels by the shape and timing of their seasonal greenness cycle. They are **not** vegetation
species or land-cover labels; class numbers have no meaning outside this model, and identically
numbered classes from different sites' models are unrelated.

Method adapted from ${REFERENCE.author}'s notebook (${REFERENCE.repository}, commit ${REFERENCE.commit.slice(0, 7)}),
re-implemented in TypeScript. Differences from the notebook, by design:
- one model per site, trained on that site's selected years (the notebook pooled six sites);
- the consensus never lets missing years vote, needs ≥ ${m.consensus?.policy.minValidYears ?? 3} valid years, and reports ties as ambiguous
  (the notebook's mode counted no-data as a vote and broke ties by the smaller class number);
- QA must be an integer class 1–4 and values outside a variable's declared valid range are treated as missing.

## Training

- Years: ${m.years.join(', ')}
- Features: 21, in this order: ${m.model.featureOrder.join(', ')}
- Timing features are days since the pixel's own cycle-1 onset (OGI), modulo 365 (also in leap years).
- Quality: cycle-1 QA ≤ 3 required; a second cycle is used when NumCycles ≥ 2 and QA_2 ≤ 3, otherwise its features are 0.
- Scaler fitted on ${m.model.scaler.nSamples.toLocaleString('en-US')} eligible pixel-years (${m.model.scaler.population.toLowerCase()}).
${t ? `- K-means: ${t.sampled ? `**sampled fit**, ${t.sampleSize.toLocaleString('en-US')} of ${t.eligibleRows.toLocaleString('en-US')} eligible pixel-years (${t.sampleMethod.toLowerCase()}, seed ${t.sampleSeed})` : `all ${t.eligibleRows.toLocaleString('en-US')} eligible pixel-years`}; k-means++ init, ${m.model.kmeans.nInit} restarts, seed ${m.model.kmeans.seed}, inertia ${m.model.kmeans.inertia?.toFixed(1) ?? 'n/a'}.` : '- Model imported from a saved model file.'}
- Every eligible pixel-year of every year was classified with the same fitted scaler and centroids.

## Files

| File | Contents |
| --- | --- |
| \`geotiff/classes_<year>.tif\` | Annual classes. UInt8: 1–${k} = class, **0 = no data** (GDAL nodata). Colour table embedded. |
| \`geotiff/consensus_class.tif\` | ${m.consensus?.policy.label ?? 'Consensus'}: 1–${k} = class, ${CODE.AMBIGUOUS} = ambiguous tie, ${CODE.INSUFFICIENT} = too few valid years, 0 = no data. |
| \`geotiff/consensus_valid_years.tif\` | Number of years with a valid class (0–${m.years.length}); ${CODE.OUTSIDE} = outside the footprint every year (nodata). |
| \`geotiff/consensus_agreement.tif\` | Float32: votes for the winning class / valid years (temporal consistency, not a probability). NaN = no valid year. |
| \`class_cover.csv\` | Cell counts, % of classified cells, % of the footprint, planar area (m²) per class, per year and for the consensus, with exclusions. |
| \`class_cover.json\` | The same annual and consensus cover as a structured object, with denominator definitions, grid and model identity. |
| \`class_summary.csv\` | Exact class medians of every feature (stored units) and raw OGI, pooled and per year. |
| \`waveforms_<population>.csv\` | Synthetic class waveforms, EVI by day since onset. |
| \`legend.csv\` | Class codes and colours. |
| \`model.json\` | Scaler statistics, centroids, feature order and units, QA policy, seeds, inputs. Reusable: import it to apply the model again. |
| \`manifest.json\` | Everything about this run, including cover and summaries. |
| \`figures/*.png\` | Figures as shown in the app, when included. |

## Units and definitions

- Grid: ${m.grid.width} × ${m.grid.height} cells, EPSG:${m.grid.epsg ?? 'unknown'}${m.grid.crsName ? ` (${m.grid.crsName})` : ''}, GeoTransform ${m.grid.geoTransform.join(', ')}. Rows run north to south.
- Footprint: cells where the product has a valid QA code in that year (consensus: in any selected year).
- Areas are planar areas in the projected CRS${m.grid.cellAreaM2 ? ` (${m.grid.cellAreaM2} m² per cell)` : '; this CRS is not metric, so areas are not given'}.
- Class summaries are medians over pixel-years in stored units: EVImax/EVIamp × 10⁴, EVIarea × 10², timing in days since onset.
- ${m.waveforms.note}

## Warnings

${m.warnings.length ? m.warnings.map((w) => `- ${w}`).join('\n') : '- None.'}
`;
}

/** The bundle as zip entries; PNGs are passed in because they need a browser canvas. */
export function bundleEntries(m: RunManifest, arrays: RunArrays, pngs: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }> = []): ZipEntry[] {
  const root = runSlug(m);
  const entries: ZipEntry[] = [
    { path: `${root}/README.md`, data: readme(m) },
    { path: `${root}/manifest.json`, data: JSON.stringify(m, null, 2) },
    { path: `${root}/model.json`, data: modelJson(m) },
    { path: `${root}/class_cover.csv`, data: coverCsv(m) },
    { path: `${root}/class_cover.json`, data: coverJson(m) },
    { path: `${root}/class_summary.csv`, data: summaryCsv(m) },
    { path: `${root}/legend.csv`, data: legendCsv(m) },
    { path: `${root}/waveforms_pooled.csv`, data: waveformCsv(m, 'pooled') },
    ...m.years.map((y) => ({ path: `${root}/waveforms_${y}.csv`, data: waveformCsv(m, String(y)) })),
  ];
  for (const y of m.years) {
    const l = arrays.labels[String(y)];
    if (l) entries.push({ path: `${root}/geotiff/classes_${y}.tif`, data: annualGeoTiff(m, y, l) as Uint8Array<ArrayBuffer> });
  }
  if (arrays.consensus) {
    for (const t of consensusGeoTiffs(m, arrays.consensus)) entries.push({ path: `${root}/geotiff/${t.name}`, data: t.bytes as Uint8Array<ArrayBuffer> });
  }
  for (const p of pngs) entries.push({ path: `${root}/figures/${p.name}`, data: p.bytes });
  return entries;
}
