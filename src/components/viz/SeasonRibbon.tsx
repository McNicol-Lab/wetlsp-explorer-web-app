/**
 * A horizontal ribbon under the EVI chart that turns the key dates read off
 * the daily mean (green-up, peak, green-down at 50% amplitude) into segments
 * on the same date axis. Only boundaries the curve actually crosses are drawn:
 * a missing green-down leaves the decline open-ended rather than inventing one.
 */
import { useState } from 'react';
import clsx from 'clsx';
import type { KeyDates } from '@/views/keyDates';

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const fmt = (iso: string) =>
  new Date(ms(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const doy = (iso: string) => {
  const t = ms(iso);
  return Math.floor((t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY) + 1;
};

interface Boundary {
  key: string;
  label: string;
  date: string;
  value: number;
}

export function SeasonRibbon({
  kd,
  domain,
  series,
  inset = { left: 60, right: 22 },
}: {
  kd: KeyDates;
  /** First and last dates on the chart's x axis. */
  domain: [string, string];
  series: string;
  /** Matches the plot's own margins so segments sit under the dates they mark. */
  inset?: { left: number; right: number };
}) {
  const [hover, setHover] = useState<string | null>(null);
  const t0 = ms(domain[0]);
  const t1 = ms(domain[1]);
  if (!(t1 > t0)) return null;
  const pos = (iso: string) => Math.min(1, Math.max(0, (ms(iso) - t0) / (t1 - t0))) * 100;

  const bounds: Boundary[] = [
    kd.greenUp && { key: 'up', label: 'Green-up', date: kd.greenUp.date, value: kd.greenUp.value },
    { key: 'peak', label: 'Peak', date: kd.peak.date, value: kd.peak.value },
    kd.greenDown && { key: 'down', label: 'Green-down', date: kd.greenDown.date, value: kd.greenDown.value },
  ].filter(Boolean) as Boundary[];

  const up = kd.greenUp ? pos(kd.greenUp.date) : null;
  const peak = pos(kd.peak.date);
  const down = kd.greenDown ? pos(kd.greenDown.date) : null;

  // Segments only between boundaries the data supports.
  const segments: Array<{ key: string; from: number; to: number; label: string; tone: string }> = [];
  if (up !== null) segments.push({ key: 'before', from: 0, to: up, label: 'Before green-up', tone: 'repeating-linear-gradient(135deg, var(--season-off) 0 3px, transparent 3px 6px)' });
  segments.push({ key: 'rise', from: up ?? 0, to: peak, label: up === null ? 'Rising (start not reached)' : 'Rising', tone: 'var(--season-rise)' });
  segments.push({ key: 'decline', from: peak, to: down ?? 100, label: down === null ? 'Declining (end not reached)' : 'Declining', tone: 'var(--accent-strong)' });
  if (down !== null) segments.push({ key: 'after', from: down, to: 100, label: 'After green-down', tone: 'repeating-linear-gradient(135deg, var(--season-off) 0 3px, transparent 3px 6px)' });

  const length = kd.seasonDays;

  return (
    <div className="shrink-0 border-t border-[var(--border)] pb-2 pt-2" style={{ paddingLeft: inset.left, paddingRight: inset.right }}>
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-[var(--text-muted)]">
        <span>
          Season <span className="text-[var(--text-faint)]">· {series} mean, 50% amplitude</span>
        </span>
        <span className="tabular-nums">
          {length !== null ? <><b className="font-medium text-[var(--text)]">{length} d</b> green-up → green-down · </> : null}
          amplitude <b className="font-medium text-[var(--text)]">{kd.amplitude.toFixed(3)}</b>
        </span>
      </div>
      <div className="relative h-[18px]" role="img" aria-label={`Season ribbon: ${bounds.map((b) => `${b.label} ${b.date}`).join(', ')}`}>
        {segments.map((s) => (
          <div
            key={s.key}
            title={s.label}
            className={clsx(
              'absolute inset-y-[5px] transition-opacity duration-150',
              hover && !hover.startsWith(s.key) && 'opacity-60',
            )}
            style={{ left: `${s.from}%`, width: `${Math.max(0, s.to - s.from)}%`, background: s.tone }}
          />
        ))}
        {bounds.map((b) => {
          const x = pos(b.date);
          const active = hover === b.key;
          return (
            <button
              key={b.key}
              type="button"
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(b.key)}
              onBlur={() => setHover(null)}
              aria-label={`${b.label}: ${b.date}, EVI ${b.value.toFixed(3)}`}
              className="group absolute top-0 -translate-x-1/2"
              style={{ left: `${x}%` }}
            >
              <span
                className={clsx(
                  'block h-[18px] w-[18px] rounded-full border-2 bg-[var(--bg-elevated)] transition-transform duration-150',
                  b.key === 'peak' ? 'border-[var(--accent-strong)]' : 'border-[var(--accent)]',
                  active && 'scale-110',
                )}
              >
                {b.key === 'peak' && <span className="m-[3px] block h-2 w-2 rounded-full bg-[var(--lime)]" />}
              </span>
              <span
                className={clsx(
                  'pointer-events-none absolute bottom-[24px] left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-left text-[11px] shadow-[var(--shadow-pop)]',
                  'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
              >
                <b className="font-medium">{b.label}</b>
                <span className="block tabular-nums text-[var(--text-muted)]">
                  {fmt(b.date)} · DOY {doy(b.date)} · EVI {b.value.toFixed(3)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-[var(--text-faint)]">
        {bounds.map((b) => (
          <span key={b.key} className="truncate">
            {b.label} {fmt(b.date)}
          </span>
        ))}
      </div>
    </div>
  );
}
