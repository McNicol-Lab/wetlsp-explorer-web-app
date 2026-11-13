/**
 * Class cover from full-resolution label arrays, never from display pixels.
 *
 * Two denominators, always named:
 *  - classified: cells that received a class (annual) or a consensus class;
 *  - footprint: cells where the product has a value (a valid QA code) in that
 *    year, or in any of the consensus years.
 * Areas are planar, in the grid's projected CRS, and only when it is metric.
 */
import { CODE, STATUS } from './constants';

export interface CoverRow {
  classId: number;
  count: number;
  /** Percent of classified cells. */
  pctClassified: number | null;
  /** Percent of footprint cells. */
  pctFootprint: number | null;
  /** Square metres, when the CRS allows it. */
  areaM2: number | null;
}

export interface AnnualCover {
  year: number;
  gridCells: number;
  footprintCells: number;
  classifiedCells: number;
  /** Cell counts per `STATUS` code. */
  statusCounts: number[];
  rows: CoverRow[];
  cellAreaM2: number | null;
}

export interface ConsensusCover {
  label: string;
  years: number[];
  gridCells: number;
  footprintCells: number;
  classifiedCells: number;
  ambiguousCells: number;
  insufficientCells: number;
  /** In the footprint, but no valid annual label in any year. */
  noValidYearCells: number;
  rows: CoverRow[];
  /** Cells by number of valid years, index = years. */
  validYearHistogram: number[];
  cellAreaM2: number | null;
}

const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : null);

function classRows(counts: number[], k: number, classified: number, footprint: number, area: number | null): CoverRow[] {
  const rows: CoverRow[] = [];
  for (let c = 1; c <= k; c++) {
    rows.push({
      classId: c,
      count: counts[c],
      pctClassified: pct(counts[c], classified),
      pctFootprint: pct(counts[c], footprint),
      areaM2: area === null ? null : counts[c] * area,
    });
  }
  return rows;
}

export function annualCover(year: number, labels: Uint8Array, status: Uint8Array, k: number, cellAreaM2: number | null): AnnualCover {
  if (labels.length !== status.length) throw new Error('Labels and status arrays differ in size.');
  const counts = new Array(k + 1).fill(0);
  const statusCounts = [0, 0, 0, 0, 0];
  for (let i = 0; i < labels.length; i++) {
    statusCounts[status[i]]++;
    const v = labels[i];
    if (v >= 1 && v <= k) counts[v]++;
  }
  const classified = counts.reduce((a, b) => a + b, 0);
  if (classified !== statusCounts[STATUS.ELIGIBLE]) {
    throw new Error(`${year}: ${classified} labelled cells but ${statusCounts[STATUS.ELIGIBLE]} eligible ones; the label array is inconsistent.`);
  }
  const footprint = labels.length - statusCounts[STATUS.NO_PRODUCT];
  return {
    year,
    gridCells: labels.length,
    footprintCells: footprint,
    classifiedCells: classified,
    statusCounts,
    rows: classRows(counts, k, classified, footprint, cellAreaM2),
    cellAreaM2,
  };
}

export function consensusCover(
  label: string,
  years: number[],
  cls: Uint8Array,
  validYears: Uint8Array,
  k: number,
  cellAreaM2: number | null,
): ConsensusCover {
  const counts = new Array(k + 1).fill(0);
  let ambiguous = 0;
  let insufficient = 0;
  let noValid = 0;
  let footprint = 0;
  const hist = new Array(years.length + 1).fill(0);
  for (let i = 0; i < cls.length; i++) {
    const vy = validYears[i];
    if (vy === CODE.OUTSIDE) continue;
    footprint++;
    hist[vy]++;
    const v = cls[i];
    if (v >= 1 && v <= k) counts[v]++;
    else if (v === CODE.AMBIGUOUS) ambiguous++;
    else if (v === CODE.INSUFFICIENT) insufficient++;
    else noValid++;
  }
  const classified = counts.reduce((a, b) => a + b, 0);
  return {
    label,
    years,
    gridCells: cls.length,
    footprintCells: footprint,
    classifiedCells: classified,
    ambiguousCells: ambiguous,
    insufficientCells: insufficient,
    noValidYearCells: noValid,
    rows: classRows(counts, k, classified, footprint, cellAreaM2),
    validYearHistogram: hist,
    cellAreaM2,
  };
}
