/**
 * Import progress, shared by the hero and the workspace: what is happening,
 * how far it is (bytes, parts), about how long is left, and Cancel. The page
 * title carries the percentage too, so it shows in the browser tab and, in
 * the desktop app, on the Dock or taskbar icon.
 */
import { Fragment, useEffect } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { SPLIT_PHASE } from '@/engine/splitTimeseries';
import { formatRemaining, RemainingTime } from '@/lib/eta';
import { formatBytes } from '@/lib/format';
import { ProgressBar } from './ui';

/** One for the app: the hero and the workspace strip take turns showing it. */
const remaining = new RemainingTime();

const SPLIT_WHY =
  'Once per site: the time series is rewritten as smaller parts the browser can load quickly. Every chart of this site is faster afterwards.';

export function ImportProgress({ inline = false }: { inline?: boolean }) {
  const ingest = useAppStore((s) => s.ingest);
  const cancel = useAppStore((s) => s.cancelImport);

  const { progress, queue } = ingest;
  // Overall fraction across the queue, so five sites read as one bar.
  const fraction =
    progress?.fraction == null
      ? null
      : queue
        ? (queue.index + progress.fraction) / queue.total
        : progress.fraction;
  // Never 100% before it is done.
  const percent = fraction === null ? null : Math.min(99, Math.floor(fraction * 100));
  const phase = progress?.phase ?? 'Importing';
  const left = ingest.active
    ? remaining.update(`${queue?.index ?? 0}|${phase}`, progress?.fraction ?? null, performance.now())
    : null;

  useEffect(() => {
    if (!ingest.active || percent === null) return;
    const before = document.title;
    document.title = `${percent}% · ${phase.replace(/ \(.*\)$/, '')} · ${before}`;
    return () => {
      document.title = before;
    };
  }, [ingest.active, percent, phase]);

  if (!ingest.active) return null;

  const file = progress?.detail?.split('/').pop();
  const facts = [
    queue ? `Site ${queue.index + 1} of ${queue.total} · ${queue.label}` : null,
    progress?.bytes && progress.bytes.total > 0
      ? `${formatBytes(progress.bytes.done)} of ${formatBytes(progress.bytes.total)}`
      : null,
    progress?.note ?? null,
  ].filter((f): f is string => Boolean(f));
  const eta = left !== null && left > 0 ? formatRemaining(left) + (queue ? ' on this site' : '') : null;
  const splitting = phase === SPLIT_PHASE;

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 items-baseline gap-2 text-[12px] leading-snug">
          <span className={clsx('font-medium text-[var(--text)]', inline && 'shrink-0')} title={splitting ? SPLIT_WHY : undefined}>
            {phase}
          </span>
          {inline && file && <span className="min-w-0 truncate text-[var(--text-faint)]">{file}</span>}
          {inline && (facts.length > 0 || eta) && (
            <span className="ml-auto shrink-0 tabular-nums text-[var(--text-muted)]">
              {[...facts, eta].filter(Boolean).join(' · ')}
            </span>
          )}
          {percent !== null && (
            <span
              className={clsx(
                'w-9 shrink-0 text-right font-medium tabular-nums text-[var(--text)]',
                !(inline && (facts.length > 0 || eta)) && 'ml-auto',
              )}
            >
              {percent}%
            </span>
          )}
        </div>
        <ProgressBar
          fraction={fraction}
          live
          valueText={percent === null ? phase : `${percent}%${eta ? `, ${eta}` : ''}`}
        />
        {!inline && (facts.length > 0 || eta || file) && (
          <div className="flex items-baseline gap-3 text-[11.5px] tabular-nums text-[var(--text-muted)]">
            <span className="min-w-0">
              {/* Lines break between the facts, never inside one ("1.7 GB of 2.3 GB"). */}
              {[file, ...facts].filter(Boolean).map((f, i) => (
                <Fragment key={i}>
                  {i > 0 && ' · '}
                  <span className="whitespace-nowrap">{f}</span>
                </Fragment>
              ))}
            </span>
            {eta && <span className="ml-auto shrink-0 text-[var(--text)]">{eta}</span>}
          </div>
        )}
        {!inline && splitting && (
          <p className="pt-1 text-[11.5px] leading-relaxed text-[var(--text-faint)]">{SPLIT_WHY}</p>
        )}
      </div>
      <button
        onClick={cancel}
        className={
          inline
            ? 'shrink-0 rounded p-1 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
            : 'shrink-0 self-start text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]'
        }
        title="Cancel the import"
        aria-label="Cancel the import"
      >
        {inline ? <X size={14} /> : 'Cancel'}
      </button>
    </div>
  );
}
