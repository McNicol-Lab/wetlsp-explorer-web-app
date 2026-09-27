/** ⌘K. Every site, every view and every major toggle, one fuzzy search away. */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { CornerDownLeft, Search } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { VIEWS } from './TopBar';
import { useImportActions } from './DropTarget';
import { Kbd } from './ui';
import { runFigureAction } from '@/lib/figure';

interface Command {
  id: string;
  title: string;
  group: string;
  hint?: string;
  run: () => void;
}

/** Subsequence match with a small bonus for word-start hits. */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score -= found - ti;
    if (found === 0 || /[\s\-_/]/.test(t[found - 1] ?? '')) score += 4;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 12;
  return score;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const setView = useAppStore((s) => s.setView);
  const selectSite = useAppStore((s) => s.selectSite);
  const setCatalogFocus = useAppStore((s) => s.setCatalogFocus);
  const siteOrder = useAppStore((s) => s.siteOrder);
  const catalog = useAppStore((s) => s.catalog);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const ts = useAppStore((s) => s.timeseries);
  const updateTs = useAppStore((s) => s.updateTimeseries);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const toggleRail = useAppStore((s) => s.toggleRail);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const { openFolder, openFiles } = useImportActions();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];

    for (const [i, v] of VIEWS.entries()) {
      out.push({
        id: `view:${v.id}`,
        title: v.label,
        group: 'Views',
        hint: `⌘${i + 1}`,
        run: () => setView(v.id),
      });
    }

    for (const id of siteOrder) {
      out.push({
        id: `site:${id}`,
        title: id,
        group: 'Loaded sites',
        hint: 'open',
        run: () => void selectSite(id),
      });
    }

    const loadedNorm = new Set(siteOrder.map((s) => s.replace(/[-_]/g, '').toLowerCase()));
    for (const s of catalog) {
      if (loadedNorm.has(s.site_id.replace(/[-_]/g, '').toLowerCase())) continue;
      out.push({
        id: `catalog:${s.site_id}`,
        title: s.site_name ? `${s.site_id} — ${s.site_name}` : s.site_id,
        group: 'Catalog',
        hint: s.country,
        run: () => {
          setCatalogFocus(s.site_id);
          setView('overview');
        },
      });
    }

    out.push(
      {
        id: 'import:folder',
        title: 'Import a site folder',
        group: 'Data',
        run: () => void openFolder(),
      },
      { id: 'import:files', title: 'Import individual files', group: 'Data', run: openFiles },
      {
        id: 'toggle:selection-source',
        title: ts.useSelection ? 'Plot a random pixel sample' : 'Plot the map selection',
        group: 'Time series',
        run: () => updateTs({ useSelection: !ts.useSelection }),
      },
      {
        id: 'toggle:spline',
        title: ts.series.includes('spline') ? 'Hide the spline series' : 'Show the spline series',
        group: 'Time series',
        run: () =>
          updateTs({
            series: ts.series.includes('spline')
              ? ts.series.filter((s) => s !== 'spline')
              : ['spline', ...ts.series],
          }),
      },
      {
        id: 'toggle:raw',
        title: ts.series.includes('raw') ? 'Hide the raw series' : 'Show the raw series',
        group: 'Time series',
        run: () =>
          updateTs({
            series: ts.series.includes('raw')
              ? ts.series.filter((s) => s !== 'raw')
              : [...ts.series, 'raw'],
          }),
      },
      { id: 'chart:line', title: 'Time series: line chart', group: 'Time series', run: () => updateTs({ chart: 'line' }) },
      { id: 'chart:years', title: 'Time series: compare years', group: 'Time series', run: () => updateTs({ chart: 'years' }) },
      { id: 'chart:3d', title: 'Time series: 3D ribbon', group: 'Time series', run: () => updateTs({ chart: '3d' }) },
      {
        id: 'toggle:pixels',
        title: ts.showPixels ? 'Hide individual pixel lines' : 'Show individual pixel lines',
        group: 'Time series',
        run: () => updateTs({ showPixels: !ts.showPixels }),
      },
      {
        id: 'toggle:iqr',
        title: ts.showIqr ? 'Hide the IQR band' : 'Show the IQR band',
        group: 'Time series',
        run: () => updateTs({ showIqr: !ts.showIqr }),
      },
      { id: 'figure:save', title: 'Save the current figure as PNG', group: 'Export', hint: '⌘S', run: () => void runFigureAction('save') },
      { id: 'figure:copy', title: 'Copy the current figure to the clipboard', group: 'Export', hint: '⌘⇧C', run: () => void runFigureAction('copy') },
      { id: 'figure:caption', title: 'Copy a caption for the current figure', group: 'Export', run: () => void runFigureAction('caption') },
      ...(useAppStore.getState().samples.length
        ? [{ id: 'samples:download', title: 'Download the sample sites', group: 'Data', run: () => void useAppStore.getState().installSamples() }]
        : []),
      { id: 'settings:storage', title: 'Manage storage and sample sites', group: 'Data', run: () => useAppStore.getState().setSettingsOpen(true) },
      {
        id: 'site:reload',
        title: 'Reload metadata for the open site',
        group: 'Data',
        run: () => {
          const id = useAppStore.getState().activeSiteId;
          if (id) void useAppStore.getState().reloadSite(id);
        },
      },
      { id: 'selection:redraw', title: 'Redraw the random pixel sample', group: 'Pixel map', run: () => useAppStore.getState().redrawSample() },
      { id: 'selection:clear', title: 'Clear the pixel selection', group: 'Pixel map', run: clearSelection },
      {
        id: 'theme',
        title: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        group: 'Appearance',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'theme:system', title: 'Follow the system theme', group: 'Appearance', run: () => setTheme('system') },
      { id: 'panel:rail', title: 'Toggle the sidebar', group: 'Appearance', run: toggleRail },
      { id: 'panel:inspector', title: 'Toggle the inspector', group: 'Appearance', run: toggleInspector },
    );

    return out;
  }, [
    siteOrder, catalog, theme, ts, setView, selectSite, setCatalogFocus, openFolder, openFiles,
    updateTs, clearSelection, setTheme, toggleRail, toggleInspector,
  ]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: fuzzyScore(query, `${c.title} ${c.group}`) }))
      .filter((r): r is { c: Command; s: number } => r.s !== null);
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 60).map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const run = (cmd: Command) => {
    cmd.run();
    setOpen(false);
  };

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 p-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        className="card w-full max-w-[560px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
          <Search size={15} className="text-[var(--text-faint)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(results.length - 1, c + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === 'Enter' && results[cursor]) {
                e.preventDefault();
                run(results[cursor]);
              }
            }}
            placeholder="Jump to a site, a view, or an action…"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--text-faint)]"
          />
          <Kbd>esc</Kbd>
        </div>

        <ul ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-[var(--text-muted)]">
              Nothing matches “{query}”.
            </li>
          )}
          {results.map((cmd, i) => {
            const showGroup = cmd.group !== lastGroup;
            lastGroup = cmd.group;
            return (
              <li key={cmd.id}>
                {showGroup && (
                  <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                    {cmd.group}
                  </div>
                )}
                <button
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => run(cmd)}
                  className={clsx(
                    'flex w-full items-center justify-between gap-3 rounded-[9px] px-2.5 py-1.5 text-left text-[13px]',
                    i === cursor ? 'bg-[var(--bg-hover)]' : '',
                  )}
                >
                  <span className="truncate">{cmd.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
                    {cmd.hint}
                    {i === cursor && <CornerDownLeft size={11} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
