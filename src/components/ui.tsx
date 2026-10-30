/** Small shared primitives. Chrome stays neutral so the data carries the colour. */
import clsx from 'clsx';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/* ---------------------------------------------------------------- button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  active?: boolean;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-md',
  lg: 'h-11 px-5 text-[14px] gap-2.5 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,color] duration-150 ease-[var(--ease-calm)]',
        'disabled:opacity-45 disabled:pointer-events-none',
        sizeClasses[size],
        variant === 'primary' &&
          'bg-[var(--accent)] text-[var(--accent-contrast)] hover:brightness-110',
        variant === 'secondary' &&
          'border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:bg-[var(--bg-hover)]',
        variant === 'ghost' &&
          'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
        variant === 'danger' &&
          'border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10',
        active && variant !== 'primary' && 'bg-[var(--bg-hover)] text-[var(--text)]',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ card */

export function Card({
  title,
  subtitle,
  actions,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  return (
    <section className={clsx('card flex flex-col overflow-hidden', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
          <div className="min-w-0">
            {title && <h3 className="text-[13.5px] font-semibold truncate">{title}</h3>}
            {subtitle && (
              <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-4 pb-4', !title && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ chip */

export function Chip({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'muted';
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'chip',
        tone === 'accent' &&
          'border-[color-mix(in_oklab,var(--accent)_22%,transparent)] bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] text-[var(--accent)]',
        tone === 'warning' &&
          'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        tone === 'danger' && 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
        tone === 'muted' && 'opacity-60',
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="stat-tile rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{label}</div>
      <div className="mt-1 text-[17px] font-semibold tabular-nums leading-none">{value}</div>
      {hint && <div className="mt-1 text-[11.5px] text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- field */

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="flex items-baseline justify-between gap-2 text-[12px] font-medium text-[var(--text-muted)]"
      >
        <span>{label}</span>
        {hint && <span className="text-[11.5px] font-normal tabular-nums">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={clsx(
          'w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5',
          'text-[13.5px] text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5',
          'text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-faint)]',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-[var(--accent)] disabled:opacity-40"
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'flex w-full items-center justify-between gap-3 rounded-[10px] px-2 py-1.5 text-left',
        'transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-45 disabled:pointer-events-none',
      )}
    >
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="block text-[11.5px] text-[var(--text-muted)]">{hint}</span>}
      </span>
      <span
        className={clsx(
          'relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-150',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] h-4 w-4 rounded-full bg-white shadow transition-transform duration-150 ease-[var(--ease-calm)]',
            checked ? 'translate-x-[16px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={clsx(
        'inline-flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-0.5',
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[4px] font-medium transition-colors duration-150 ease-[var(--ease-calm)]',
            size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-3 text-[12.5px]',
            value === o.value
              ? 'bg-[var(--bg-elevated)] text-[var(--text)] shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- feedback */

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} />;
}

export function ProgressBar({
  fraction,
  label,
  valueText,
  live = false,
}: {
  fraction: number | null;
  label?: string;
  /** What a screen reader says for the value, e.g. "38%, about 2 min left". */
  valueText?: string;
  /** Long work: a slow sheen shows it is still going between updates. */
  live?: boolean;
}) {
  return (
    <div className="space-y-1">
      {label && <div className="text-[11.5px] text-[var(--text-muted)] truncate">{label}</div>}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
        aria-valuetext={valueText}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      >
        <div
          className={clsx(
            'h-full rounded-full bg-[var(--accent)]',
            fraction === null
              ? 'progress-indeterminate'
              : // Updates come a few times a second: glide between them, never step.
                'transition-[width] duration-500 ease-linear',
            fraction !== null && live && 'progress-live',
          )}
          style={fraction === null ? undefined : { width: `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%` }}
        />
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex h-full w-full flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-8' : 'gap-3 py-16',
      )}
    >
      {icon && <div className="text-[var(--text-faint)]">{icon}</div>}
      <h4 className={clsx('font-semibold', compact ? 'text-[13.5px]' : 'text-[15px]')}>{title}</h4>
      {body && (
        <p className="max-w-[46ch] text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-[var(--border)] bg-[var(--bg-sunken)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--text-muted)]">
      {children}
    </kbd>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={clsx('h-px w-full bg-[var(--border)]', className)} />;
}
