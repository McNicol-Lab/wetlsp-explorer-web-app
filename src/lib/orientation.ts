/**
 * Row order of WetLSP phenometric grids.
 *
 * The v001 WetLSP NetCDFs label their grid north-up (descending `y`, and a
 * GeoTransform with a negative y step), but the data rows are written
 * south-up: row 0 of every variable is the southern edge. Reading the rows as
 * the coordinates describe them draws every map upside down. The companion
 * Parquet confirms it: its `cell` index follows the north-up coordinates, and
 * its EVI matches the NetCDF's EVImax only once the rows are reversed, at
 * every site-year in the release.
 */

/** Global attributes of a NetCDF, as plain strings. */
export type GlobalAttrs = Record<string, string | undefined>;

/**
 * True when the file is a WetLSP v001 export, whose rows run south to north
 * despite its north-up coordinates. A corrected re-export should carry a new
 * `product_version`, which turns this off.
 */
export function rowsStoredSouthUp(attrs: GlobalAttrs): boolean {
  const isWetlsp = [attrs.software_repository, attrs.title].some((v) => v?.includes('WetLSP'));
  return isWetlsp && attrs.product_version?.trim() === 'v001';
}

/** Reverse the row order of a row-major grid, in place. */
export function flipRowsInPlace(values: Float32Array, width: number, height: number): void {
  const tmp = new Float32Array(width);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const a = top * width;
    const b = bottom * width;
    tmp.set(values.subarray(a, a + width));
    values.copyWithin(a, b, b + width);
    values.set(tmp, b);
  }
}
