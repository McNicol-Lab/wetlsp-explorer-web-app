/**
 * One mark per year saying what this device actually holds for it. Shape, not
 * only colour, carries the state: filled = EVI and phenometrics imported,
 * half = only one of them, ring = listed in the catalog but not imported,
 * dash = nothing known. Hover names the files.
 */
import clsx from 'clsx';
import type { CatalogSite, SiteManifest } from '@/lib/types';
import { formatBytes } from '@/lib/format';

export type YearState = 'full' | 'partial' | 'catalog' | 'none';

export interface YearAvailability {
  year: number;
  state: YearState;
  detail: string;
}

export function yearAvailability(
  manifest: SiteManifest | null,
  eviYears: number[],
  record: CatalogSite | undefined,
): YearAvailability[] {
  const nc = new Map((manifest?.netcdf ?? []).map((n) => [n.year, n]));
  const catalog = Object.entries(record?.years ?? {}).filter(([, v]) => v).map(([y]) => Number(y));
  const years = [...new Set([...nc.keys(), ...eviYears, ...catalog])].sort((a, b) => a - b);
  return years.map((year) => {
    const file = nc.get(year);
    const evi = eviYears.includes(year);
    const lines = [
      `EVI time series: ${evi ? 'present' : manifest?.timeseries ? 'no rows for this year' : 'not imported'}`,
      `Phenometrics: ${file ? `${file.path} (${formatBytes(file.size)})` : 'no NetCDF imported'}`,
    ];
    if (!file && !evi && catalog.includes(year)) lines.push('Listed as available in the catalog');
    const state: YearState =
      file && evi ? 'full' : file || evi ? 'partial' : catalog.includes(year) ? 'catalog' : 'none';
    return { year, state, detail: lines.join('\n') };
  });
}

const LABEL: Record<YearState, string> = {
  full: 'EVI + phenometrics',
  partial: 'partial',
  catalog: 'catalog only',
  none: 'unavailable',
};

export function AvailabilityStrip({ items, compact }: { items: YearAvailability[]; compact?: boolean }) {
  if (items.length === 0) return <span className="text-[11px] text-[var(--text-faint)]">No years</span>;
  return (
    <ul className={clsx('flex items-center', compact ? 'gap-2' : 'gap-3')} aria-label="Data availability by year">
      {items.map((it) => (
        <li
          key={it.year}
          className="flex items-center gap-1 text-[11px] tabular-nums text-[var(--text-muted)]"
          title={`${it.year} · ${LABEL[it.state]}\n${it.detail}`}
          aria-label={`${it.year}: ${LABEL[it.state]}`}
        >
          <Mark state={it.state} />
          {it.year}
        </li>
      ))}
    </ul>
  );
}

function Mark({ state }: { state: YearState }) {
  const s = 9;
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden className="shrink-0">
      {state === 'full' && <circle cx="5" cy="5" r="4.2" fill="var(--accent)" />}
      {state === 'partial' && (
        <>
          <circle cx="5" cy="5" r="3.9" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
          <path d="M5 1.1 A3.9 3.9 0 0 1 5 8.9 Z" fill="var(--accent)" />
        </>
      )}
      {state === 'catalog' && <circle cx="5" cy="5" r="3.7" fill="none" stroke="var(--text-faint)" strokeWidth="1.3" />}
      {state === 'none' && <line x1="2" y1="5" x2="8" y2="5" stroke="var(--text-faint)" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}
