/** Inline SVG sparkline. It is too small to be worth a charting library. */
export function Sparkline({
  x,
  y,
  color,
  width = 236,
  height = 46,
  label,
}: {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  width?: number;
  height?: number;
  label?: string;
}) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(y[i])) continue;
    if (x[i] < xMin) xMin = x[i];
    if (x[i] > xMax) xMax = x[i];
    if (y[i] < yMin) yMin = y[i];
    if (y[i] > yMax) yMax = y[i];
  }
  if (!Number.isFinite(xMin) || xMax === xMin) return null;
  const pad = 3;
  const ySpan = yMax - yMin || 1;
  const px = (v: number) => pad + ((v - xMin) / (xMax - xMin)) * (width - 2 * pad);
  const py = (v: number) => height - pad - ((v - yMin) / ySpan) * (height - 2 * pad);

  let d = '';
  let pen = false;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(y[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${px(x[i]).toFixed(1)} ${py(y[i]).toFixed(1)}`;
    pen = true;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={label ?? 'EVI sparkline'}
      className="overflow-visible"
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}
