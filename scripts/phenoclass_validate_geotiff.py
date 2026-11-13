#!/usr/bin/env python3
"""
GIS round-trip check for the Phenology Classes GeoTIFF exports, using GDAL
(through rasterio). Development-time only.

    python scripts/phenoclass_validate_geotiff.py <export-dir> <site-dir> [--site US-Myb] [--ref <reference-dir>]

<export-dir> is what `realdata.test.ts` writes with PHENOCLASS_OUT_DIR: the
GeoTIFFs plus the raw arrays they were made from. Checks, per file:
  - GDAL opens it; one band; expected dtype; size equals the NetCDF grid;
  - CRS EPSG and affine transform equal GDAL's own reading of the source NetCDF;
  - the centre of cell (row, col) is the NetCDF's (x[col], y[row]);
  - nodata value as documented; every pixel equals the exported array;
  - class rasters carry the colour table;
  - with --ref, the classified cells are exactly the notebook's eligible cells.
Exits non-zero on any failure.
"""
import argparse
import json
import os
import sys

import numpy as np
import rasterio
from rasterio.crs import CRS

FAILURES = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILURES.append(msg)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("export_dir")
    p.add_argument("site_dir")
    p.add_argument("--site", default="US-Myb")
    p.add_argument("--ref")
    a = p.parse_args()
    manifest = json.load(open(os.path.join(a.export_dir, "manifest.json")))
    years = manifest["years"]
    k = manifest["model"]["kmeans"]["k"]
    nc = os.path.join(a.site_dir, f"{a.site}-wetlsp-{years[0]}.nc")
    # GDAL's own view of the source grid.
    with rasterio.open(f'NETCDF:"{nc}":QA') as src:
        nc_transform, nc_crs, (H, W) = src.transform, src.crs, (src.height, src.width)
    import h5py
    with h5py.File(nc, "r") as f:
        xs, ys = f["x"][:], f["y"][:]
        wkt = f["transverse_mercator"].attrs["spatial_ref"]
        wkt = wkt.decode() if isinstance(wkt, bytes) else wkt
    epsg = CRS.from_wkt(wkt).to_epsg()
    print(f"source: {os.path.basename(nc)} {W}x{H} EPSG:{epsg} transform {tuple(nc_transform)[:6]}  (GDAL {rasterio.__gdal_version__})")

    def common(path, dtype, nodata):
        with rasterio.open(path) as t:
            name = os.path.basename(path)
            check(t.count == 1 and t.dtypes[0] == dtype, f"{name}: 1 band of {dtype} (got {t.count} × {t.dtypes[0]})")
            check((t.width, t.height) == (W, H), f"{name}: size {t.width}x{t.height} equals the NetCDF grid")
            check(t.crs is not None and t.crs.to_epsg() == epsg, f"{name}: CRS EPSG:{t.crs.to_epsg() if t.crs else None}")
            check(t.transform.almost_equals(nc_transform, precision=1e-6), f"{name}: transform equals GDAL's reading of the NetCDF")
            for (r, c) in [(0, 0), (H - 1, W - 1), (H // 3, W // 2)]:
                x, y = t.xy(r, c)
                check(abs(x - xs[c]) < 1e-6 and abs(y - ys[r]) < 1e-6, f"{name}: centre of cell ({r},{c}) = NetCDF ({xs[c]:.3f}, {ys[r]:.3f})")
            if isinstance(nodata, float) and np.isnan(nodata):
                check(t.nodata is not None and np.isnan(t.nodata), f"{name}: nodata NaN")
            else:
                check(t.nodata == nodata, f"{name}: nodata {t.nodata} == {nodata}")
            try:
                cmap = t.colormap(1)
            except ValueError:
                cmap = None  # no colour table (count and float rasters)
            return t.read(1), cmap

    for y in years:
        arr, cmap = common(os.path.join(a.export_dir, f"classes_{y}.tif"), "uint8", 0)
        exp = np.fromfile(os.path.join(a.export_dir, f"expected-labels-{y}.u8"), dtype=np.uint8).reshape(H, W)
        check(np.array_equal(arr, exp), f"classes_{y}.tif: every pixel equals the exported labels")
        check(set(np.unique(arr)) <= set(range(0, k + 1)), f"classes_{y}.tif: values within 0..{k}")
        check(cmap is not None and cmap.get(1) == (0x2a, 0x78, 0xd6, 255), f"classes_{y}.tif: colour table (class 1 = #2a78d6)")
        if a.ref:
            ref = np.fromfile(os.path.join(a.ref, f"sklearn-labels-{y}.u8"), dtype=np.uint8).reshape(H, W)
            check(np.array_equal(arr != 0, ref != 0), f"classes_{y}.tif: classified cells == the notebook's eligible pixels ({int((ref != 0).sum()):,})")

    arr, cmap = common(os.path.join(a.export_dir, "consensus_class.tif"), "uint8", 0)
    exp = np.fromfile(os.path.join(a.export_dir, "expected-consensus-class.u8"), dtype=np.uint8).reshape(H, W)
    check(np.array_equal(arr, exp), "consensus_class.tif: every pixel equals the consensus array")
    check(set(np.unique(arr)) <= set(range(0, k + 1)) | {253, 254}, "consensus_class.tif: only classes, 253, 254 and 0")
    arr, _ = common(os.path.join(a.export_dir, "consensus_valid_years.tif"), "uint8", 255)
    exp = np.fromfile(os.path.join(a.export_dir, "expected-consensus-valid-years.u8"), dtype=np.uint8).reshape(H, W)
    check(np.array_equal(arr, exp), "consensus_valid_years.tif: every pixel equals the array")
    arr, _ = common(os.path.join(a.export_dir, "consensus_agreement.tif"), "float32", float("nan"))
    exp = np.fromfile(os.path.join(a.export_dir, "expected-consensus-agreement.f32"), dtype="<f4").reshape(H, W)
    check(np.array_equal(arr, exp, equal_nan=True), "consensus_agreement.tif: every pixel equals the array (NaN where no valid year)")

    print(f"\n{'PASS' if not FAILURES else f'FAIL ({len(FAILURES)})'}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
