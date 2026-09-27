/**
 * Season key dates read off a daily mean EVI curve: the peak, and the dates the
 * curve crosses half its amplitude on the way up and down (a common,
 * transparent "50% amplitude" convention). This is a quick reading of the
 * plotted line. The NetCDF layers in the Phenometrics view are the reference
 * values.
 */
export interface KeyPoint {
  /** ISO date, interpolated between the two days either side of the crossing. */
  date: string;
  value: number;
}

export interface KeyDates {
  peak: KeyPoint;
  greenUp: KeyPoint | null;
  greenDown: KeyPoint | null;
  /** Peak minus the lower of the two seasonal minima. */
  amplitude: number;
  /** Days from green-up to green-down, when both exist. */
  seasonDays: number | null;
  fraction: number;
}

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(Math.round(t / DAY) * DAY).toISOString().slice(0, 10);

/** Rows must be sorted by date. Returns null when there is no clear season. */
export function keyDates(
  rows: ReadonlyArray<{ date: string; mean: number }>,
  fraction = 0.5,
  minAmplitude = 0.02,
): KeyDates | null {
  const pts = rows.filter((r) => Number.isFinite(r.mean));
  if (pts.length < 8) return null;

  let peakIdx = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].mean > pts[peakIdx].mean) peakIdx = i;
  const peak = pts[peakIdx];

  const minOf = (from: number, to: number) => {
    let m = Infinity;
    for (let i = from; i < to; i++) m = Math.min(m, pts[i].mean);
    return m;
  };
  const baseUp = peakIdx > 0 ? minOf(0, peakIdx) : Infinity;
  const baseDown = peakIdx < pts.length - 1 ? minOf(peakIdx + 1, pts.length) : Infinity;
  const amplitude = peak.mean - Math.min(baseUp, baseDown);
  if (!Number.isFinite(amplitude) || amplitude < minAmplitude) return null;

  const cross = (i: number, j: number, thr: number): KeyPoint => {
    const a = pts[i], b = pts[j];
    const f = b.mean === a.mean ? 0 : (thr - a.mean) / (b.mean - a.mean);
    const t = ms(a.date) + Math.min(1, Math.max(0, f)) * (ms(b.date) - ms(a.date));
    return { date: iso(t), value: thr };
  };

  // A side only counts when the curve really falls away: a slight dip after the
  // peak at the end of the date range is not the end of the season.
  const sideMin = Math.max(minAmplitude, amplitude / 2);

  let greenUp: KeyPoint | null = null;
  if (Number.isFinite(baseUp) && peak.mean - baseUp >= sideMin) {
    const thr = baseUp + fraction * (peak.mean - baseUp);
    for (let i = peakIdx - 1; i >= 0; i--) {
      if (pts[i].mean < thr) {
        greenUp = cross(i, i + 1, thr);
        break;
      }
    }
  }

  let greenDown: KeyPoint | null = null;
  if (Number.isFinite(baseDown) && peak.mean - baseDown >= sideMin) {
    const thr = baseDown + fraction * (peak.mean - baseDown);
    for (let j = peakIdx + 1; j < pts.length; j++) {
      if (pts[j].mean < thr) {
        greenDown = cross(j - 1, j, thr);
        break;
      }
    }
  }

  return {
    peak: { date: peak.date, value: peak.mean },
    greenUp,
    greenDown,
    amplitude,
    seasonDays:
      greenUp && greenDown ? Math.round((ms(greenDown.date) - ms(greenUp.date)) / DAY) : null,
    fraction,
  };
}
