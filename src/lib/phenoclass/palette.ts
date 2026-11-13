/**
 * Class colours: one fixed categorical palette, identical across maps, charts,
 * PNGs and GeoTIFF colour tables, so class 3 is the same colour everywhere a
 * model's results appear. Grey is reserved for the non-class statuses.
 */
import { CODE } from './constants';

/**
 * Categorical slots in a fixed order (never cycled), validated with the dataviz
 * palette checker against the app's panel surfaces: lightness band, chroma
 * floor, adjacent-pair colour-vision-deficiency separation (ΔE ≥ 8.4) and the
 * normal-vision floor (ΔE ≥ 19.3) all pass in both themes. Slots 1–8 are the
 * reference palette; slot 9 was chosen to pass beside slot 8.
 * No 7–9 colour palette separates *every* pair on a map, so maps also offer
 * per-class isolate/hide and a hover readout; colour is never the only cue.
 */
export const CLASS_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#8a3fb0'];
export const CLASS_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#b065d9'];

export const STATUS_COLORS = {
  /** In-app no-data, per theme. */
  nodataLight: '#cfd5dc',
  nodataDark: '#273040',
  ambiguous: '#4b5563',
  insufficient: '#a8b0bc',
};

/** Class colour; the dark-theme step of the same hue on dark surfaces. Exports use the light set. */
export function classColor(classId: number, dark = false): string {
  const set = dark ? CLASS_COLORS_DARK : CLASS_COLORS;
  return set[(classId - 1) % set.length];
}

export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function classLabel(classId: number): string {
  if (classId === CODE.AMBIGUOUS) return 'Tie';
  if (classId === CODE.INSUFFICIENT) return 'Too few years';
  if (classId === CODE.NODATA) return 'No data';
  return `Class ${classId}`;
}

/** 256-entry palette for GeoTIFF ColorMap tags. */
export function geotiffPalette(k: number): Array<[number, number, number]> {
  const pal: Array<[number, number, number]> = Array.from({ length: 256 }, () => [255, 255, 255]);
  for (let c = 1; c <= k; c++) pal[c] = hexRgb(classColor(c));
  pal[CODE.AMBIGUOUS] = hexRgb(STATUS_COLORS.ambiguous);
  pal[CODE.INSUFFICIENT] = hexRgb(STATUS_COLORS.insufficient);
  return pal;
}
