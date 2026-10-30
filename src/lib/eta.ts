/**
 * Time left for a long task, from how its progress has moved lately.
 *
 * The rate is taken over the last half minute, not since the start, so an
 * estimate recovers when a task speeds up or slows down part way (a copy of
 * small files, then a split). Nothing is shown for the first few seconds,
 * when one early jump would promise a time that is not kept, and the figure
 * is smoothed so it counts down rather than jitters.
 */

/** Recent progress the rate is taken over. */
const WINDOW_MS = 30_000;
/** No estimate before this much of a phase has been seen. */
const SETTLE_MS = 4_000;

export class RemainingTime {
  private key = '';
  private samples: Array<{ t: number; f: number }> = [];
  private smoothed: number | null = null;

  /**
   * Seconds left, or null while there is not enough to go on. `key` names
   * the phase: a new one starts over. The same fraction again changes
   * nothing, so it can be called on every render.
   */
  update(key: string, fraction: number | null, now: number): number | null {
    if (key !== this.key) {
      this.key = key;
      this.samples = [];
      this.smoothed = null;
    }
    if (fraction === null) return null;
    const last = this.samples[this.samples.length - 1];
    if (last && fraction === last.f) return fraction >= 1 ? 0 : this.smoothed;
    this.samples.push({ t: now, f: fraction });
    while (this.samples.length > 2 && now - this.samples[1].t > WINDOW_MS) this.samples.shift();

    const first = this.samples[0];
    const elapsed = now - first.t;
    const moved = fraction - first.f;
    if (elapsed < SETTLE_MS || moved <= 0 || fraction >= 1) return fraction >= 1 ? 0 : null;
    const raw = ((1 - fraction) * elapsed) / moved / 1000;
    this.smoothed = this.smoothed === null ? raw : this.smoothed + 0.3 * (raw - this.smoothed);
    return this.smoothed;
  }
}

/** "about 3 min left": rounded the way a person would say it. */
export function formatRemaining(seconds: number): string {
  if (seconds < 10) return 'a few seconds left';
  if (seconds < 50) return 'less than a minute left';
  if (seconds < 90) return 'about a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  return rest > 0 && rest < 60 ? `about ${hours} h ${rest} min left` : `about ${rest === 60 ? hours + 1 : hours} h left`;
}
