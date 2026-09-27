/**
 * Colour ramps for the phenometric layers, matching the Shiny app's palettes.
 * Fill values / NaN are always fully transparent (alpha 0).
 */
import { phenometricScaleType, type ScaleFamily } from './layers';

export type RGBA = [number, number, number, number];

/** High-contrast rainbow used for all timing (day-of-year) layers. */
export const TIMING_RAMP = [
  '#2c00ff',
  '#004cff',
  '#00b7ff',
  '#00e5a8',
  '#7dff00',
  '#ffff00',
  '#ff9e00',
  '#ff0000',
  '#9e0000',
];

/** Sequential greens for EVI-derived greenness layers. */
export const GREENNESS_RAMP = [
  '#f7fcf5',
  '#e5f5e0',
  '#c7e9c0',
  '#a1d99b',
  '#74c476',
  '#41ab5d',
  '#238b45',
  '#006d2c',
  '#00441b',
];

/** Four discrete grey steps at QA classes 1–4. */
export const QA_STEPS = ['#f7f7f7', '#cccccc', '#969696', '#525252'];

/** Viridis control points (sequential, perceptually uniform) for count layers. */
export const VIRIDIS_RAMP = [
  '#440154',
  '#482878',
  '#3e4989',
  '#31688e',
  '#26828e',
  '#1f9e89',
  '#35b779',
  '#6ece58',
  '#b5de2b',
  '#fde725',
];

const TRANSPARENT: RGBA = [0, 0, 0, 0];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear interpolation through a list of hex stops. `t` is clamped to 0..1. */
export function sampleRamp(ramp: string[], t: number): [number, number, number] {
  if (!Number.isFinite(t)) return [0, 0, 0];
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export interface ColorScale {
  family: ScaleFamily;
  /** Continuous ramp stops, or the discrete QA steps. */
  stops: string[];
  discrete: boolean;
  domain: [number, number];
  /** Value -> RGBA. NaN / out-of-domain fill values map to fully transparent. */
  color(value: number): RGBA;
  /** Value -> css hex, for legends and SVG. */
  hex(value: number): string;
  /** Evenly spaced legend ticks across the domain. */
  ticks(count?: number): number[];
}

export function makeColorScale(layer: string, domain: [number, number]): ColorScale {
  const family = phenometricScaleType(layer);
  const [lo, hi] = domain;
  const span = hi - lo;

  if (family === 'qa') {
    // Discrete classes 1..4 use the nearest class; there is no interpolation.
    const stops = QA_STEPS;
    const color = (v: number): RGBA => {
      if (!Number.isFinite(v)) return TRANSPARENT;
      const idx = Math.round(v) - 1;
      if (idx < 0 || idx >= stops.length) return TRANSPARENT;
      const [r, g, b] = hexToRgb(stops[idx]);
      return [r, g, b, 255];
    };
    return {
      family,
      stops,
      discrete: true,
      domain: [1, 4],
      color,
      hex: (v) => {
        const idx = Math.round(v) - 1;
        return idx >= 0 && idx < stops.length ? stops[idx] : 'transparent';
      },
      ticks: () => [1, 2, 3, 4],
    };
  }

  const stops =
    family === 'timing' ? TIMING_RAMP : family === 'greenness' ? GREENNESS_RAMP : VIRIDIS_RAMP;

  const color = (v: number): RGBA => {
    if (!Number.isFinite(v)) return TRANSPARENT;
    const t = span === 0 ? 0.5 : (v - lo) / span;
    const [r, g, b] = sampleRamp(stops, t);
    return [Math.round(r), Math.round(g), Math.round(b), 255];
  };

  return {
    family,
    stops,
    discrete: false,
    domain,
    color,
    hex: (v) => {
      const c = color(v);
      return c[3] === 0 ? 'transparent' : rgbToHex([c[0], c[1], c[2]]);
    },
    ticks: (count = 5) => {
      if (span === 0) return [lo];
      return Array.from({ length: count }, (_, i) => lo + (span * i) / (count - 1));
    },
  };
}

/** CSS `linear-gradient` string for a legend bar. */
export function rampToCssGradient(stops: string[], discrete = false): string {
  if (discrete) {
    const n = stops.length;
    const segs = stops.map(
      (c, i) => `${c} ${((i / n) * 100).toFixed(2)}% ${(((i + 1) / n) * 100).toFixed(2)}%`,
    );
    return `linear-gradient(to right, ${segs.join(', ')})`;
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
