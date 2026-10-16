import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useAppStore } from '@/store/useAppStore';

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'card pointer-events-auto flex gap-2.5 p-3 panel-transition',
              t.kind === 'error' && 'border-red-500/40',
              t.kind === 'warning' && 'border-amber-500/40',
            )}
          >
            <Icon
              size={16}
              className={clsx(
                'mt-0.5 shrink-0',
                t.kind === 'success' && 'text-[var(--accent)]',
                t.kind === 'warning' && 'text-amber-500',
                t.kind === 'error' && 'text-red-500',
                t.kind === 'info' && 'text-[var(--text-muted)]',
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t.title}</div>
              {t.detail && (
                <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-muted)]">
                  {t.detail}
                </div>
              )}
              {t.action && (
                <button
                  onClick={() => {
                    dismiss(t.id);
                    t.action!.run();
                  }}
                  className="mt-1.5 text-[12.5px] font-medium text-[var(--accent)] underline underline-offset-2"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="h-5 w-5 shrink-0 rounded text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
