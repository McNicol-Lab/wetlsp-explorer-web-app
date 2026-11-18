/**
 * Shown only while the app is actually starting (engine, settings, stored
 * sites). Nested contour rings breathe slowly; nothing spins.
 */
export function BootLoader({ label = 'Starting WetLSP Explorer' }: { label?: string }) {
  const rings = [44, 34, 25, 17, 10];
  return (
    <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
      <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden>
        {rings.map((r, i) => (
          <ellipse
            key={r}
            cx={52 + i * 1.6}
            cy={52 - i * 1.1}
            rx={r}
            ry={r * 0.82}
            fill="none"
            stroke={i === rings.length - 1 ? 'var(--lime)' : 'var(--accent)'}
            strokeWidth={i === rings.length - 1 ? 2.4 : 1.2}
            className="boot-contour"
            style={{ animationDelay: `${i * 160}ms`, opacity: 0.25 + i * 0.15 }}
          />
        ))}
        <circle cx={52 + 4 * 1.6} cy={52 - 4 * 1.1} r={3} fill="var(--accent-strong)" />
      </svg>
      <div className="text-[12px] text-[var(--text-muted)]">{label}…</div>
    </div>
  );
}
