/**
 * Phenology classification: fixed method parameters.
 *
 * The method follows Vishal Bobde's phenometric clustering notebook
 * (McNicol-Lab/wetlsp_companion, `Vishal_code.ipynb` at commit
 * 468960957b41ed44cce1b7bb38cdff4c4c06f765). The companion repository has no
 * licence file, so nothing here is copied from it: the method is
 * re-implemented from its description and checked against the notebook's own
 * functions by `scripts/phenoclass_reference.py`.
 *
 * Deliberate adaptations, each carried in the saved method versions:
 *  - one model per site (the notebook pools six sites);
 *  - a consensus that never lets missing years vote (the notebook's mode does);
 *  - optional, recorded sampling for the k-means fit on large sites.
 */

/** Bumped whenever a calculation changes what it produces for the same input. */
export const METHOD_VERSIONS = {
  features: 'phenoclass-features/1',
  scaler: 'standard-scaler-sklearn/1',
  kmeans: 'kmeans-lloyd-kmeans++/1',
  consensus: 'consensus-unique-majority-min3/1',
  waveform: 'asym-gauss-taper-smoothmax/1',
  cover: 'cover-full-resolution/1',
  geotiff: 'geotiff-uint8-palette/1',
} as const;

/** Schema of the files a run writes; bump on any incompatible change. */
export const RUN_SCHEMA_VERSION = 1;
export const MODEL_SCHEMA = 'wetlsp-phenoclass-model';
export const MODEL_SCHEMA_VERSION = 1;

export const REFERENCE = {
  repository: 'https://github.com/McNicol-Lab/wetlsp_companion',
  commit: '468960957b41ed44cce1b7bb38cdff4c4c06f765',
  notebook: 'Vishal_code.ipynb',
  author: 'Vishal Bobde',
  citation:
    'Method adapted from V. Bobde, phenometric cover-type classification notebook, McNicol Lab WetLSP companion repository (commit 4689609).',
} as const;

/** Days in the circular timing axis. Kept at 365 in leap years, as the reference does. */
export const DOY_PERIOD = 365;

/** QA classes run 1 (best) to 4 (worst). Cycles with QA above this are not used. */
export const QA_MAX_ACCEPTED = 3;
export const QA_CODES = [1, 2, 3, 4] as const;

const CYCLE_VARS = ['OGI', '50PCGI', 'OGMx', 'Peak', 'OGD', '50PCGD', 'OGMn', 'EVImax', 'EVIamp', 'EVIarea'];

/** The 23 NetCDF variables the method needs. */
export const REQUIRED_VARIABLES: readonly string[] = [
  'NumCycles',
  'QA',
  'QA_2',
  ...CYCLE_VARS,
  ...CYCLE_VARS.map((v) => `${v}_2`),
];

/** Clustering features, in the exact column order of the reference extractor. */
export const FEATURE_ORDER = [
  'NumCycles',
  'EVImax',
  'EVIamp',
  'EVIarea',
  '50PCGI',
  'OGMx',
  'Peak',
  'OGD',
  '50PCGD',
  'OGMn',
  'has_cycle2',
  'EVImax_2',
  'EVIamp_2',
  'EVIarea_2',
  'OGI_2',
  '50PCGI_2',
  'OGMx_2',
  'Peak_2',
  'OGD_2',
  '50PCGD_2',
  'OGMn_2',
] as const;
export type FeatureName = (typeof FEATURE_ORDER)[number];
export const N_FEATURES = FEATURE_ORDER.length;

/** Cycle-1 timing columns, re-expressed as days since the pixel's own OGI. */
export const CYCLE1_TIMING = ['50PCGI', 'OGMx', 'Peak', 'OGD', '50PCGD', 'OGMn'] as const;
/** Cycle-2 timing columns, shifted by the same cycle-1 OGI anchor. */
export const CYCLE2_TIMING = ['OGI_2', '50PCGI_2', 'OGMx_2', 'Peak_2', 'OGD_2', '50PCGD_2', 'OGMn_2'] as const;
export const TIMING_FEATURES = new Set<string>([...CYCLE1_TIMING, ...CYCLE2_TIMING]);
export const GREENNESS_FEATURES = new Set<string>(['EVImax', 'EVIamp', 'EVIarea', 'EVImax_2', 'EVIamp_2', 'EVIarea_2']);

/** Summary columns: the 21 features plus the raw (unshifted) cycle-1 OGI. */
export const SUMMARY_COLUMNS = [...FEATURE_ORDER, 'OGI_raw'] as const;
export const N_SUMMARY = SUMMARY_COLUMNS.length;

export const KMEANS_DEFAULTS = {
  k: 7,
  nInit: 20,
  seed: 42,
  maxIter: 300,
  tol: 1e-4,
} as const;
export const K_MIN = 2;
export const K_MAX = 9;

/** Training-sample choices offered in the UI; `0` means every eligible pixel-year. */
export const TRAINING_SAMPLE_CHOICES = [100_000, 200_000, 500_000, 0] as const;
export const DEFAULT_TRAINING_SAMPLE = 200_000;
/** Refuse an unsampled fit above this many rows: about 250 MB of float64 features. */
export const MAX_UNSAMPLED_ROWS = 1_500_000;

/** Diagnostics run on a bounded sample: elbow fits and pairwise silhouettes are quadratic-ish. */
export const DIAGNOSTIC_SAMPLE = 30_000;
export const SILHOUETTE_SAMPLE = 5_000;

/** Consensus policy v1. */
export const CONSENSUS_MIN_VALID_YEARS = 3;

/** Smooth-maximum sharpness of the reference, in stored EVI units (EVI × 10⁴). */
export const SMOOTH_MAX_K_STORED = 0.15;

/**
 * Raster encoding shared by the in-app label arrays and the GeoTIFFs.
 * Class ids are 1…k; 0 is always "no data".
 */
export const CODE = {
  NODATA: 0,
  INSUFFICIENT: 253,
  AMBIGUOUS: 254,
  /** Valid-year-count layer only: outside the site footprint in every year. */
  OUTSIDE: 255,
} as const;

/** Why a pixel-year has no class. Order matters: the first failing check wins. */
export const STATUS = {
  ELIGIBLE: 0,
  /** QA is fill, outside 1–4 or not an integer: the product has no value here. */
  NO_PRODUCT: 1,
  /** QA is 4: the reference excludes the whole pixel-year. */
  QA_REJECTED: 2,
  /** A required cycle-1 value is fill, out of its valid range or non-finite. */
  MISSING_CYCLE1: 3,
  /** A usable second cycle was declared, but one of its values is missing. */
  MISSING_CYCLE2: 4,
} as const;
export type StatusCode = (typeof STATUS)[keyof typeof STATUS];

export const STATUS_LABELS: Record<StatusCode, string> = {
  0: 'Usable',
  1: 'No data here',
  2: 'Low quality (QA 4)',
  3: 'Missing a cycle 1 value',
  4: 'Missing a cycle 2 value',
};
