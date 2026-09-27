/** Formatting helpers shared by the views. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatValue(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1000 || abs < 0.001) return v.toExponential(2);
  return Number(v.toFixed(digits)).toString();
}

/**
 * Day-of-year to a calendar date. WetLSP timing layers run from −181 to 548, so
 * a value can land in the year before or after the target year.
 */
export function doyToDate(doy: number, year: number): Date | null {
  if (!Number.isFinite(doy)) return null;
  const d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + Math.round(doy) - 1);
  return d;
}

export function doyToDateLabel(doy: number, year: number): string {
  const d = doyToDate(doy, year);
  if (!d) return '—';
  const label = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const y = d.getUTCFullYear();
  return y === year ? label : `${label} ${y}`;
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function msFromIso(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "3 minutes ago", for the left rail's import timestamps. */
export function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
