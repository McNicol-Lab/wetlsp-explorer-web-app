/**
 * A circular reading pinned beside the selected pixel. The ring is the
 * pixel's percentile among this site's pixels for the same metric and year:
 * a defined, bounded scale. EVI itself is never shown as a percentage.
 */
import { useEffect, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

export function MetricBubble({
  map,
  lon,
  lat,
  label,
  value,
  digits = 3,
  percentile,
  onClose,
}: {
  map: MapLibreMap | null;
  lon: number;
  lat: number;
  label: string;
  value: number;
  digits?: number;
  /** 0–100, the share of site pixels at or below this value. */
  percentile: number | null;
  onClose: () => void;
}) {
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const p = map.project([lon, lat]);
      setPt({ x: p.x, y: p.y });
    };
    update();
    map.on('move', update);
    map.on('resize', update);
    return () => {
      map.off('move', update);
      map.off('resize', update);
    };
  }, [map, lon, lat]);
  if (!pt) return null;

  const D = 132;
  const R = D / 2 - 5;
  const C = 2 * Math.PI * R;
  const frac = percentile === null ? 0 : Math.min(1, Math.max(0, percentile / 100));

  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{ left: pt.x, top: pt.y, transform: `translate(18px, calc(-100% - 18px))` }}
    >
      <svg className="absolute -bottom-[18px] -left-[18px]" width="24" height="20" aria-hidden>
        <line x1="2" y1="18" x2="22" y2="2" stroke="var(--accent-strong)" strokeWidth="1.2" strokeDasharray="2 2" />
        <circle cx="2" cy="18" r="2" fill="var(--accent-strong)" />
      </svg>
      <div
        className="selection-pop pointer-events-auto relative grid place-items-center rounded-full border border-white/70 bg-[color-mix(in_oklab,var(--bg-elevated)_82%,transparent)] shadow-[var(--shadow-pop)] backdrop-blur-md dark:border-white/10"
        style={{ width: D, height: D }}
      >
        <svg width={D} height={D} viewBox={`0 0 ${D} ${D}`} className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx={D / 2} cy={D / 2} r={R} fill="none" stroke="var(--season-off)" strokeWidth="3" />
          {percentile !== null && (
            <circle
              cx={D / 2} cy={D / 2} r={R} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${C * frac} ${C}`}
            />
          )}
        </svg>
        <div className="relative flex flex-col items-center text-center leading-none">
          <span className="max-w-[96px] text-[10.5px] font-medium leading-tight text-[var(--text-muted)]">{label}</span>
          <span className="mt-1.5 text-[26px] font-semibold tabular-nums tracking-[-0.03em] text-[var(--accent-strong)]">
            {value.toFixed(digits)}
          </span>
          {percentile !== null && (
            <span
              className="mt-1.5 rounded-full bg-[var(--pale)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--accent)]"
              title="Percentile among this site's pixels: share with a lower or equal value"
            >
              p{Math.round(percentile)} at site
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close reading"
          className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full text-[12px] leading-none text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
