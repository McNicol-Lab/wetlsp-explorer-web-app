/** Live progress of the running phenology-class job, with Cancel. */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button, ProgressBar } from '@/components/ui';
import { usePhenoclassStore } from '@/store/usePhenoclassStore';

const KIND_LABEL = { inspect: 'Checking files', diagnose: 'Testing k', train: 'Training', apply: 'Applying model' } as const;

export function JobPanel({ compact }: { compact?: boolean }) {
  const job = usePhenoclassStore((s) => s.job);
  const cancel = usePhenoclassStore((s) => s.cancelJob);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job]);
  if (!job) return null;
  const p = job.progress;
  const elapsed = Math.max(0, Math.round((now - job.startedAt) / 1000));
  const label = `${KIND_LABEL[job.kind]} · ${job.siteId} · ${p?.phase ?? 'Starting'}${p?.detail ? ` · ${p.detail}` : ''}`;
  return (
    <div className={compact ? 'flex items-center gap-3' : 'space-y-2'}>
      <div className="min-w-0 flex-1">
        <ProgressBar fraction={p?.fraction ?? null} label={label} valueText={label} live />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
