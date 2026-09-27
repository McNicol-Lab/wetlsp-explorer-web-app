/** PNG and CSV export helpers shared by every view. */
import { toCsv } from './csv';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so Safari has finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadCsv(filename: string, header: string[], rows: Array<Array<unknown>>): void {
  downloadBlob(new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }), filename);
}

export async function downloadCanvasPng(
  canvas: HTMLCanvasElement,
  filename: string,
): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This view could not be rendered to a PNG.');
  downloadBlob(blob, filename);
}

/**
 * Composite one or more canvases (deck.gl over MapLibre, say) onto a white or
 * dark backdrop and save that. A bare WebGL canvas exports transparent.
 */
export async function downloadCompositePng(
  canvases: HTMLCanvasElement[],
  filename: string,
  background: string,
): Promise<void> {
  await downloadCanvasPng(compositeCanvas(canvases, background), filename);
}

/** Flatten stacked canvases onto a solid backdrop; shared by download and copy. */
export function compositeCanvas(canvases: HTMLCanvasElement[], background: string): HTMLCanvasElement {
  const visible = canvases.filter((c) => c.width > 0 && c.height > 0);
  if (visible.length === 0) throw new Error('There is nothing on screen to export yet.');
  const width = Math.max(...visible.map((c) => c.width));
  const height = Math.max(...visible.map((c) => c.height));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a 2D canvas to export with.');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  for (const c of visible) ctx.drawImage(c, 0, 0, width, height);
  return out;
}

export function timestampedName(parts: Array<string | number | null | undefined>, ext: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = parts
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .join('-')
    .replace(/[^\w.-]+/g, '-');
  return `${slug}-${stamp}.${ext}`;
}

/** Background colour to flatten exports onto, matching the current theme. */
export function exportBackground(): string {
  return document.documentElement.classList.contains('dark') ? '#0b0f14' : '#ffffff';
}

export interface FigureCardOptions {
  title: string;
  subtitle?: string;
  /** One label per panel, drawn in its top-left corner. */
  panelLabels?: string[];
  cols: number;
  background: string;
  legend?: { hex: (v: number) => string; domain: [number, number]; ticks: number[]; units?: string; format: (v: number) => string; discrete?: boolean };
}

/**
 * Tile panel canvases into one self-describing image: a title strip, a label
 * on each panel and a colour bar. A bare raster pasted into a slide loses what
 * it shows; this keeps the layer, site-years and scale with the picture.
 */
export function figureCard(canvases: HTMLCanvasElement[], opts: FigureCardOptions): HTMLCanvasElement {
  const visible = canvases.filter((c) => c.width > 0 && c.height > 0);
  if (visible.length === 0) throw new Error('There is nothing on screen to export yet.');
  const cols = Math.max(1, Math.min(opts.cols, visible.length));
  const rows = Math.ceil(visible.length / cols);
  const w = Math.max(...visible.map((c) => c.width));
  const h = Math.max(...visible.map((c) => c.height));
  // Type scales with the panels so text stays legible at devicePixelRatio 2.
  const u = Math.max(1, Math.round(Math.min(w * cols, 2400) / 900));
  const pad = 20 * u;
  const header = (opts.subtitle ? 62 : 44) * u;
  const footer = opts.legend ? 58 * u : 12 * u;

  const out = document.createElement('canvas');
  out.width = w * cols + pad * 2;
  out.height = header + h * rows + footer;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a 2D canvas to export with.');
  const dark = isDarkColor(opts.background);
  const ink = dark ? '#e8ecf2' : '#14181f';
  const muted = dark ? '#98a3b3' : '#5b6270';
  const font = 'Inter, system-ui, sans-serif';

  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = 'top';
  ctx.fillStyle = ink;
  ctx.font = `600 ${17 * u}px ${font}`;
  ctx.fillText(opts.title, pad, 14 * u);
  if (opts.subtitle) {
    ctx.fillStyle = muted;
    ctx.font = `${12 * u}px ${font}`;
    ctx.fillText(opts.subtitle, pad, 38 * u);
  }

  visible.forEach((c, i) => {
    const x = pad + (i % cols) * w;
    const y = header + Math.floor(i / cols) * h;
    ctx.drawImage(c, x, y, w, h);
    const label = opts.panelLabels?.[i];
    if (label) {
      ctx.font = `600 ${12 * u}px ${font}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = dark ? 'rgba(11,15,20,0.78)' : 'rgba(255,255,255,0.85)';
      ctx.fillRect(x + 8 * u, y + 8 * u, tw + 12 * u, 20 * u);
      ctx.fillStyle = ink;
      ctx.fillText(label, x + 14 * u, y + 12 * u);
    }
  });

  if (opts.legend) {
    const lg = opts.legend;
    const barW = Math.min(420 * u, out.width - pad * 2);
    const barH = 10 * u;
    const bx = pad;
    const by = header + h * rows + 14 * u;
    const [lo, hi] = lg.domain;
    for (let px = 0; px < barW; px++) {
      ctx.fillStyle = lg.hex(lo + ((hi - lo) * px) / Math.max(1, barW - 1));
      ctx.fillRect(bx + px, by, 1, barH);
    }
    ctx.fillStyle = muted;
    ctx.font = `${11 * u}px ${font}`;
    ctx.textAlign = 'center';
    for (const t of lg.ticks) {
      const tx = bx + ((t - lo) / (hi - lo || 1)) * barW;
      ctx.fillText(lg.format(t), Math.min(bx + barW, Math.max(bx, tx)), by + barH + 5 * u);
    }
    ctx.textAlign = 'left';
    if (lg.units) ctx.fillText(lg.units, bx + barW + 12 * u, by - 1 * u);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = muted;
  ctx.font = `${10 * u}px ${font}`;
  ctx.fillText(`WetLSP Explorer · ${new Date().toISOString().slice(0, 10)}`, out.width - pad, out.height - 18 * u);
  return out;
}

function isDarkColor(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
