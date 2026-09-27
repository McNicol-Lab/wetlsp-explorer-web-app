/**
 * Pixel id -> row in `PixelGeometry`. Geometry is read `ORDER BY pixel_id`, so
 * a binary search finds any pixel of a 1.3-million-pixel site in about 20
 * steps with no extra memory. An unsorted array (never produced today) falls
 * back to a hash map built once and cached with the array.
 */
const layout = new WeakMap<Int32Array, 'sorted' | Map<number, number>>();

function layoutOf(ids: Int32Array): 'sorted' | Map<number, number> {
  let l = layout.get(ids);
  if (l) return l;
  let sorted = true;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] <= ids[i - 1]) {
      sorted = false;
      break;
    }
  }
  if (sorted) l = 'sorted';
  else {
    const m = new Map<number, number>();
    for (let i = 0; i < ids.length; i++) if (!m.has(ids[i])) m.set(ids[i], i);
    l = m;
  }
  layout.set(ids, l);
  return l;
}

/** Row of `id` in `ids`, or -1. */
export function pixelIndex(ids: Int32Array, id: number): number {
  const l = layoutOf(ids);
  if (l !== 'sorted') return l.get(id) ?? -1;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
