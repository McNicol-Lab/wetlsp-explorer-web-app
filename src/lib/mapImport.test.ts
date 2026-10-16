import { describe, expect, it } from 'vitest';
import { isMapLayersOnly, mapLayerEntries } from './mapImport';

const e = (...paths: string[]) => paths.map((path) => ({ path }));

describe('map layers arriving through the site importer', () => {
  it('treats an NWI download folder as map layers, ignoring the .gdb and sidecar files', () => {
    const nwi = e(
      'HU8/HU8_Wetlands.shp', 'HU8/HU8_Wetlands.shx', 'HU8/HU8_Wetlands.dbf', 'HU8/HU8_Wetlands.prj',
      'HU8/HU8_Wetlands.sbn', 'HU8/HU8_Wetlands.shp.xml', 'HU8/HU8.gdb/a00000001.gdbtable',
    );
    expect(isMapLayersOnly(nwi)).toBe(true);
    expect(mapLayerEntries(nwi).map((x) => x.path.split('.').pop())).toEqual(['shp', 'shx', 'dbf', 'prj']);
  });

  it('treats a zipped shapefile (as expanded) and a lone GeoTIFF or generic NetCDF as map layers', () => {
    expect(isMapLayersOnly(e('wet.zip/wet.shp', 'wet.zip/wet.dbf'))).toBe(true);
    expect(isMapLayersOnly(e('flood.tif'))).toBe(true);
    expect(isMapLayersOnly(e('era5_flood_depth.nc'))).toBe(true);
  });

  it('keeps WetLSP site data a site, even a lone phenometric NetCDF', () => {
    expect(isMapLayersOnly(e('US-Myb-wetlsp-2024.nc'))).toBe(false);
    expect(isMapLayersOnly(e('CA-DB2/CA_DB2_pixels_geom.parquet', 'CA-DB2/CA-DB2-wetlsp-2021.nc'))).toBe(false);
  });

  it('separates map layers from a mixed drop of a site and a shapefile', () => {
    const mixed = e('US-Myb/pixels_geom_ds/geom_batch_001.parquet', 'US-Myb/US-Myb-wetlsp-2024.nc', 'NWI/wet.shp', 'NWI/wet.dbf');
    expect(isMapLayersOnly(mixed)).toBe(false);
    expect(mapLayerEntries(mixed).map((x) => x.path)).toEqual(['NWI/wet.shp', 'NWI/wet.dbf']);
  });

  it('ignores stray .prj or .dbf files without a shapefile or raster', () => {
    expect(mapLayerEntries(e('notes.prj', 'table.dbf'))).toEqual([]);
  });
});
