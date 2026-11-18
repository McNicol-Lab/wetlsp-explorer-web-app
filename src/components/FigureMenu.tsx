/**
 * The export cluster on every figure toolbar: PNG, Copy, and a menu of extras
 * (vector SVG, slide-sized PNG, caption, CSVs). Registers the view's figure so
 * ⌘S and ⌘⇧C work wherever the user is.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ClipboardCopy, Download, MoreHorizontal } from 'lucide-react';
import { registerFigure, runFigureAction, type FigureActions } from '@/lib/figure';
import { Button } from './ui';

export interface FigureMenuItem {
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void | Promise<void>;
  disabled?: boolean;
}

export function FigureMenu({
  actions,
  items = [],
  disabled,
}: {
  actions: FigureActions;
  items?: FigureMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks without re-registering on every render.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (disabled) return;
    return registerFigure({
      save: () => actionsRef.current.save(),
      copy: () => actionsRef.current.copy(),
      caption: () => actionsRef.current.caption?.() ?? null,
    });
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const allItems: FigureMenuItem[] = [
    ...items,
    ...(actions.caption
      ? [{ label: 'Copy figure caption', hint: 'text', run: () => runFigureAction('caption', actions) }]
      : []),
  ];

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      <Button
        size="sm"
        icon={<Download size={13} />}
        onClick={() => void runFigureAction('save', actions)}
        disabled={disabled}
        title="Save as PNG (⌘S)"
        aria-label="PNG"
      >
        <span className="hidden min-[1440px]:inline">PNG</span>
      </Button>
      <Button
        size="sm"
        icon={<ClipboardCopy size={13} />}
        onClick={() => void runFigureAction('copy', actions)}
        disabled={disabled}
        title="Copy the image to the clipboard (⌘⇧C)"
        aria-label="Copy"
      >
        <span className="hidden min-[1440px]:inline">Copy</span>
      </Button>
      {allItems.length > 0 && (
        <Button
          size="sm"
          className="px-1.5"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-label="More export options"
          aria-expanded={open}
          title="More export options"
        >
          <MoreHorizontal size={14} />
        </Button>
      )}
      {open && (
        <div
          className="card absolute right-0 top-full z-30 mt-1.5 w-[240px] overflow-hidden p-1 shadow-lg"
          role="menu"
        >
          {allItems.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                void item.run();
              }}
              className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-[11px] text-[var(--text-faint)]">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
