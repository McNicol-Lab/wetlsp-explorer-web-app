/**
 * WetLSP phenometric layer dictionary and colour-scale families.
 *
 * Ported from the Shiny app's `phenometric_scale_type()` and layer dictionary.
 * The Shiny numeric output is the correctness reference: palettes, break points
 * and valid ranges are reproduced verbatim.
 */

export type ScaleFamily = 'timing' | 'greenness' | 'qa' | 'count';

export interface LayerInfo {
  /** Variable name exactly as it appears in the NetCDF (`50PCGI` starts with a digit). */
  layer: string;
  description: string;
  units: string;
  /** Multiplier applied to the stored int16 value. */
  scale: number;
  validMin: number;
  validMax: number;
  family: ScaleFamily;
  /** Second-cycle variants carry the same semantics as their base layer. */
  cycle: 1 | 2;
}

/** The ten per-cycle layers that also exist as `_2` (second detected cycle). */
const PER_CYCLE: Array<Omit<LayerInfo, 'family' | 'cycle'> & { family: ScaleFamily }> = [
  {
    layer: 'OGI',
    description: 'Onset Greenness Increase; date of 15% greenness increase',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: '50PCGI',
    description: '50% Greenness Increase',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: 'OGMx',
    description: 'Onset Greenness Maximum; date of 90% greenness increase',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: 'Peak',
    description: 'Date of cycle peak',
    units: 'day of year',
    scale: 1,
    validMin: 1,
    validMax: 366,
    family: 'timing',
  },
  {
    layer: 'OGD',
    description: 'Onset Greenness Decrease; date of 10% greenness decrease',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: '50PCGD',
    description: '50% Greenness Decrease',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: 'OGMn',
    description: 'Onset Greenness Minimum; date of 85% greenness decrease',
    units: 'day of year',
    scale: 1,
    validMin: -181,
    validMax: 548,
    family: 'timing',
  },
  {
    layer: 'EVImax',
    description: 'Maximum EVI2 during vegetation cycle',
    units: 'unitless',
    scale: 0.0001,
    validMin: 0,
    validMax: 10000,
    family: 'greenness',
  },
  {
    layer: 'EVIamp',
    description: 'EVI2 amplitude during vegetation cycle',
    units: 'unitless',
    scale: 0.0001,
    validMin: 0,
    validMax: 10000,
    family: 'greenness',
  },
  {
    layer: 'EVIarea',
    description: 'Integrated EVI2 during vegetation cycle',
    units: 'unitless',
    scale: 0.0001,
    validMin: 0,
    validMax: 32766,
    family: 'greenness',
  },
];

function buildDictionary(): Record<string, LayerInfo> {
  const dict: Record<string, LayerInfo> = {
    NumCycles: {
      layer: 'NumCycles',
      description: 'Number of phenological cycles detected in target year',
      units: 'cycles',
      scale: 1,
      validMin: 0,
      validMax: 6,
      family: 'count',
      cycle: 1,
    },
    numObs: {
      layer: 'numObs',
      description: 'Days with clear observations in calendar year',
      units: 'days',
      scale: 1,
      validMin: 0,
      validMax: 366,
      family: 'count',
      cycle: 1,
    },
    QA: {
      layer: 'QA',
      description: 'Quality assurance class per cycle',
      units: 'class',
      scale: 1,
      validMin: 1,
      validMax: 4,
      family: 'qa',
      cycle: 1,
    },
    QA_2: {
      layer: 'QA_2',
      description: 'Quality assurance class, second detected cycle',
      units: 'class',
      scale: 1,
      validMin: 1,
      validMax: 4,
      family: 'qa',
      cycle: 2,
    },
  };

  for (const base of PER_CYCLE) {
    dict[base.layer] = { ...base, cycle: 1 };
    dict[`${base.layer}_2`] = {
      ...base,
      layer: `${base.layer}_2`,
      description: `${base.description} (second detected cycle)`,
      cycle: 2,
    };
  }
  return dict;
}

export const LAYER_DICTIONARY: Record<string, LayerInfo> = buildDictionary();

/** Stable display order: cycle-1 layers, then cycle-2, then the whole-year counts. */
export const LAYER_ORDER: string[] = [
  'NumCycles',
  ...PER_CYCLE.map((l) => l.layer),
  'QA',
  ...PER_CYCLE.map((l) => `${l.layer}_2`),
  'QA_2',
  'numObs',
];

const TIMING_LAYERS = new Set(['OGI', '50PCGI', 'OGMx', 'Peak', 'OGD', '50PCGD', 'OGMn']);
const GREENNESS_LAYERS = new Set(['EVImax', 'EVIamp', 'EVIarea']);
const COUNT_LAYERS = new Set(['NumCycles', 'numObs']);

/** Strip a trailing `_2` so second-cycle variants resolve to their base layer. */
export function baseLayerName(layer: string): string {
  return layer.replace(/_2$/, '');
}

/**
 * Port of `phenometric_scale_type()`. Unknown layers fall back to the
 * sequential count family instead of throwing: a site may ship extra
 * variables, and the app should keep working instead of crashing.
 */
export function phenometricScaleType(layer: string): ScaleFamily {
  const base = baseLayerName(layer);
  if (TIMING_LAYERS.has(base)) return 'timing';
  if (GREENNESS_LAYERS.has(base)) return 'greenness';
  if (base === 'QA') return 'qa';
  if (COUNT_LAYERS.has(base)) return 'count';
  return 'count';
}

/** Dictionary entry for a layer, synthesised for unknown variables. */
export function layerInfo(layer: string): LayerInfo {
  const known = LAYER_DICTIONARY[layer];
  if (known) return known;
  return {
    layer,
    description: 'Not in the WetLSP layer dictionary; its metadata comes from the file.',
    units: '',
    scale: 1,
    validMin: Number.NaN,
    validMax: Number.NaN,
    family: phenometricScaleType(layer),
    cycle: /_2$/.test(layer) ? 2 : 1,
  };
}

export function layerLabel(layer: string): string {
  const info = LAYER_DICTIONARY[layer];
  if (!info) return layer;
  const suffix = info.cycle === 2 ? ' (cycle 2)' : '';
  return `${baseLayerName(layer)}${suffix}`;
}

/** True when the layer's values are day-of-year and should also render as a date. */
export function isTimingLayer(layer: string): boolean {
  return phenometricScaleType(layer) === 'timing';
}
