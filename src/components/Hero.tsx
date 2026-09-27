/**
 * Landing state: a quiet introduction and one focused local-data dropzone.
 * It is the whole app until a dataset exists.
 */
import { ArrowUpRight, Download, FolderOpen, Files, Moon, Sun, WifiOff, Waves } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useImportActions } from './DropTarget';
import { Button } from './ui';
import { ImportProgress } from './ImportProgress';
import { formatBytes } from '@/lib/format';
import { useDark } from '@/views/shared';

export function Hero() {
  const { openFolder, openFiles } = useImportActions();
  const ingest = useAppStore((s) => s.ingest);
  const online = useAppStore((s) => s.online);
  const dark = useDark();
  const setTheme = useAppStore((s) => s.setTheme);
  const setView = useAppStore((s) => s.setView);
  const setHeroDismissed = useAppStore((s) => s.setHeroDismissed);
  const catalogCount = useAppStore((s) => s.catalog.length);
  const samples = useAppStore((s) => s.samples);
  const installSamples = useAppStore((s) => s.installSamples);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[var(--bg)]">
      <header className="mx-auto flex w-full max-w-[1240px] shrink-0 items-center justify-between px-8 py-7">
        <div className="flex items-center gap-3">
          <Waves size={24} strokeWidth={1.6} className="text-[var(--accent)]" />
          <span className="text-[15px] font-semibold tracking-[-0.025em]">WetLSP <span className="font-normal text-[var(--text-muted)]">Explorer</span></span>
        </div>
        <button
          onClick={() => setTheme(dark ? 'light' : 'dark')}
          className="rounded-md p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <main className="mx-auto flex w-full max-w-[1104px] flex-1 items-center px-8 py-12">
        <div className="grid w-full items-center gap-14 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div>
            <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--accent)]">Wetland land surface phenology</p>
            <h1 className="max-w-[540px] text-[clamp(2.8rem,4.7vw,4.4rem)] font-normal leading-[1.04] tracking-[-0.05em]">Explore wetland phenology</h1>
            <p className="mt-6 max-w-[40ch] text-[16px] leading-[1.7] text-[var(--text-muted)]">
              See how wetland greenness rises and falls through the year, pixel by pixel.
              Open a site to explore its time series and phenometric maps.
            </p>
            {catalogCount > 0 && (
              <button
                onClick={() => { setHeroDismissed(true); setView('catalog'); }}
                className="mt-8 inline-flex items-center gap-2 border-b border-[var(--border-strong)] pb-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:border-[var(--accent)]"
              >
                Browse the {catalogCount}-site catalog without uploading <ArrowUpRight size={14} />
              </button>
            )}
          </div>
          <div className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-8">
            {ingest.active ? (
              <div className="py-7">
                <ImportProgress />
                {ingest.queue && ingest.queue.total > 1 && (
                  <p className="mt-4 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    The first site opens as soon as it is ready; the rest keep loading.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-md border border-[var(--border)] text-[var(--accent)]"><FolderOpen size={23} strokeWidth={1.4} /></div>
                {samples.length > 0 ? (
                  <>
                    <h2 className="text-[20px] font-medium tracking-[-0.025em]">Start with real data</h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
                      Download {samples.length} wetland sites with one click, or open your own site folder.
                    </p>
                    <div className="mt-7 flex flex-col gap-2.5">
                      <Button className="w-full" size="lg" variant="primary" icon={<Download size={16} />} onClick={() => void installSamples()}>
                        Download sample sites
                      </Button>
                      <p className="-mt-0.5 text-center text-[11.5px] text-[var(--text-muted)]">
                        {samples.map((s) => s.siteId).join(', ')} · {formatBytes(samples.reduce((n, s) => n + s.bytes, 0))} · needs internet once
                      </p>
                      <Button className="mt-2 w-full" size="lg" variant="secondary" icon={<FolderOpen size={16} />} onClick={openFolder}>
                        Upload your own folder
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="text-[20px] font-medium tracking-[-0.025em]">Start with a site folder</h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">Drag it onto this window, or choose it below. A folder of several sites, or Drive <code className="text-[12px]">.zip</code> downloads, work too.</p>
                    <div className="mt-7 flex flex-col gap-2.5">
                      <Button className="w-full" size="lg" variant="primary" icon={<FolderOpen size={16} />} onClick={openFolder}>Upload folder</Button>
                    </div>
                  </>
                )}
                <p className="mt-4 text-center text-[12px] text-[var(--text-muted)]">
                  <button onClick={openFiles} className="inline-flex items-center gap-1.5 hover:text-[var(--text)]"><Files size={12} />pick files or .zip archives</button>
                </p>
                <p className="mt-7 border-t border-[var(--border)] pt-5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">Your files stay on this device. Imported datasets are saved here for offline work.</p>
              </div>
            )}
          </div>
        </div>
      </main>
      <footer className="mx-auto flex w-full max-w-[1240px] shrink-0 items-center justify-between gap-4 px-8 py-7 text-[11px] text-[var(--text-muted)]">
        <span>Pixel time series, phenometric maps and a site catalog</span>
        {!online && <span className="inline-flex items-center gap-1.5"><WifiOff size={12} />You're offline. Imported sites still work.</span>}
      </footer>
    </div>
  );
}
