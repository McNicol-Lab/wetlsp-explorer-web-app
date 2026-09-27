/** Shared data model for ingested WetLSP site datasets. */

export type ViewId = 'overview' | 'timeseries' | 'pixelmap' | 'phenometrics' | 'catalog';

export type TableRole = 'geom' | 'meta' | 'timeseries';

export type DatasetLayout = 'single-file' | 'batched' | 'mixed' | 'unknown';

/** One physical file inside a site dataset, addressed by its OPFS-relative path. */
export interface StoredFile {
  /** Path relative to the site root, e.g. `CA_DB2_pixels_geom.parquet`. */
  path: string;
  size: number;
}

/**
 * A logical table. `single-file` layouts have exactly one part; `_ds` layouts
 * have many parquet parts that are queried as one union.
 */
export interface StoredTable {
  role: TableRole;
  kind: 'file' | 'directory';
  /** Directory name for `_ds` layouts, used to build the glob. */
  directory?: string;
  parts: StoredFile[];
  totalBytes: number;
}

export interface NetcdfFile extends StoredFile {
  year: number;
}

export interface SiteManifest {
  siteId: string;
  /** Best-known display name; filled from the catalog when available. */
  siteName?: string;
  layout: DatasetLayout;
  geom: StoredTable | null;
  meta: StoredTable | null;
  timeseries: StoredTable | null;
  netcdf: NetcdfFile[];
  readme: StoredFile[];
  /** Everything we could not classify, kept so nothing silently vanishes. */
  unrecognised: StoredFile[];
  warnings: string[];
  totalBytes: number;
  importedAt: number;
  /** `sample` for the sites bundled with the app; absent for the user's own imports. */
  origin?: 'sample' | 'user';
}

/** Key/value pairs read from `pixels_meta`. */
export interface SiteMeta {
  crs_wkt?: string;
  site_id?: string;
  radius_m?: string;
  pixel_id_source?: string;
  [key: string]: string | undefined;
}

export interface PixelGeometry {
  pixelId: Int32Array;
  cell: Int32Array;
  x: Float64Array;
  y: Float64Array;
  lon: Float64Array;
  lat: Float64Array;
  /** Where the CRS definition came from, for the inspector. */
  crsSource: string;
  crsName: string | null;
  epsg: number | null;
}

export interface SiteFacts {
  years: number[];
  series: string[];
  pixelCount: number;
  /** Exact row count of `pixels_timeseries` (one cheap aggregate). */
  timeseriesRows: number;
  dateMin: string | null;
  dateMax: string | null;
}

export interface DailySummaryRow {
  date: string;
  series: string;
  mean: number;
  q25: number;
  q75: number;
  n: number;
}

export interface PixelTrace {
  pixelId: number;
  series: string;
  dates: string[];
  evi: Float64Array;
}

export interface CatalogSite {
  site_id: string;
  site_name?: string;
  country?: string;
  lat?: number;
  lon?: number;
  base_network?: string;
  tower_height_m?: number;
  canopy_height_m?: number;
  /** year -> availability flag from the catalog. */
  years: Record<number, boolean>;
  /** Everything else in the CSV, kept for the catalog table. */
  extra: Record<string, string>;
}

/** One NetCDF variable, described from its own attributes + the dictionary. */
export interface NetcdfVariable {
  name: string;
  longName: string;
  units: string;
  scale: number;
  offset: number;
  fillValue: number;
  validMin: number | null;
  validMax: number | null;
  shape: number[];
}

export interface NetcdfInfo {
  siteId: string;
  year: number;
  variables: NetcdfVariable[];
  width: number;
  height: number;
  /** GDAL-style 6-element GeoTransform, when present. */
  geoTransform: number[] | null;
  spatialRef: string | null;
  xRange: [number, number] | null;
  yRange: [number, number] | null;
}

export interface RasterSlice {
  layer: string;
  width: number;
  height: number;
  values: Float32Array;
  /** min/max over the finite (non-fill) values after scale+offset. */
  min: number;
  max: number;
  finiteCount: number;
  /** Bounding box in projected metres: [xmin, ymin, xmax, ymax]. */
  bboxProjected: [number, number, number, number] | null;
  /** Same box in lon/lat, when the CRS could be resolved. */
  bboxWgs84: [number, number, number, number] | null;
  /** Mean-pooling factor applied to fit the cell budget (1 = full resolution). */
  downsample: number;
}

export interface ProgressEvent {
  phase: string;
  /** 0..1, or null when the total is unknown. */
  fraction: number | null;
  detail?: string;
}
