/** Hooks and small pieces the five views share. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { defaultBasemap, type BasemapId } from '@/lib/basemaps';
import { CancelledError } from '@/lib/rpc';
import type { ProgressEvent } from '@/lib/types';
import { ProgressBar, Skeleton } from '@/components/ui';

export function useDark(): boolean {
  const theme = useAppStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

export function useBasemap(): BasemapId {
  const choice = useAppStore((s) => s.basemap);
  const online = useAppStore((s) => s.online);
  const dark = useDark();
  if (choice === 'auto') return defaultBasemap(dark, online);
  // A tiled basemap with no network is just a grey rectangle; be honest instead.
  if (!online && choice !== 'none') return 'none';
  return choice;
}

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  progress: ProgressEvent | null;
  reload: () => void;
  cancel: () => void;
}

/**
 * Runs an async loader whenever `deps` change, cancelling the previous run.
 * Every heavy view uses this so nothing is ever left half-loaded on screen.
 */
export function useAsyncData<T>(
  loader: (ctx: { signal: AbortSignal; onProgress: (p: ProgressEvent) => void }) => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean; keepPrevious?: boolean } = {},
): AsyncState<T> {
  const { enabled = true, keepPrevious = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    let live = true;

    setLoading(true);
    setError(null);
    setProgress(null);
    if (!keepPrevious) setData(null);

    loaderRef
      .current({
        signal: controller.signal,
        onProgress: (p) => live && setProgress(p),
      })
      .then((result) => {
        if (!live || controller.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (!live || controller.signal.aborted) return;
        if (err instanceof CancelledError) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live && !controller.signal.aborted) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    setLoading(false);
  }, []);

  return { data, loading, error, progress, reload, cancel };
}

/** Loading skeleton with live progress and a cancel affordance. */
export function LoadingPanel({
  progress,
  onCancel,
  label,
}: {
  progress: ProgressEvent | null;
  onCancel?: () => void;
  label?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col gap-4 p-6">
      <div className="space-y-2">
        <ProgressBar
          fraction={progress?.fraction ?? null}
          label={`${progress?.phase ?? label ?? 'Loading'}${
            progress?.detail ? ` · ${progress.detail}` : ''
          }`}
        />
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="grid flex-1 grid-rows-4 gap-3">
        <Skeleton className="row-span-3" />
        <Skeleton />
      </div>
    </div>
  );
}

export function ErrorPanel({
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h4 className="text-[14px] font-semibold">That did not work</h4>
      <p className="max-w-[52ch] text-[13px] leading-relaxed text-[var(--text-muted)]">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-[12.5px] text-[var(--accent)] underline underline-offset-2"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Series colours, consistent across every chart in the app. */
export function seriesColor(series: string, dark: boolean): string {
  if (series === 'spline') return dark ? '#2dd4bf' : '#0f766e';
  if (series === 'raw') return dark ? '#fb923c' : '#ea580c';
  // Anything unexpected gets a neutral so it never masquerades as a known series.
  return dark ? '#94a3b8' : '#64748b';
}

export function seriesRgb(series: string, dark: boolean): [number, number, number] {
  const hex = seriesColor(series, dark).replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
