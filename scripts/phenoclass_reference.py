#!/usr/bin/env python3
"""
Development-time reference harness for the Phenology Classes feature.

It runs the *notebook's own* functions (Vishal Bobde, McNicol-Lab/wetlsp_companion,
Vishal_code.ipynb at commit 4689609) and scikit-learn, and writes fixtures the
TypeScript tests compare against. The notebook is fetched at a pinned commit and
executed from its cells; none of its code is copied into this repository (the
companion repository carries no licence).

Not a runtime dependency. Requires: numpy, scipy, pandas, xarray, h5netcdf,
scikit-learn.

    python scripts/phenoclass_reference.py fixtures
        -> src/lib/phenoclass/__fixtures__/reference-small.json

    python scripts/phenoclass_reference.py realdata <site-dir> <out-dir> [--site US-Myb]
        -> <out-dir>/reference.json and per-year label files (north-up uint8)
"""
import argparse
import json
import os
import sys
import urllib.request

import numpy as np
import pandas as pd
import xarray as xr
from scipy import stats
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

COMMIT = "468960957b41ed44cce1b7bb38cdff4c4c06f765"
NB_URL = f"https://raw.githubusercontent.com/McNicol-Lab/wetlsp_companion/{COMMIT}/Vishal_code.ipynb"
CSV_URL = f"https://raw.githubusercontent.com/McNicol-Lab/wetlsp_companion/{COMMIT}/class_phenometric_summary.csv"
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "src", "lib", "phenoclass", "__fixtures__")


def fetch(url, cache):
    if not os.path.exists(cache):
        urllib.request.urlretrieve(url, cache)
    return cache


def load_reference(cache_dir):
    """Execute the notebook's configuration, extractor and waveform functions."""
    nb = json.load(open(fetch(NB_URL, os.path.join(cache_dir, f"nb-{COMMIT[:7]}.ipynb"))))
    cells = ["".join(c["source"]) for c in nb["cells"]]
    ns = {"np": np, "pd": pd, "xr": xr, "stats": stats}
    for idx in (9, 10, 12):  # configuration, thresholds, extract_feature_matrix
        exec(compile(cells[idx], f"notebook-cell-{idx}", "exec"), ns)
    wave = cells[30].split("# --- Build waveforms for every class")[0]
    exec(compile(wave, "notebook-cell-30", "exec"), ns)
    assert "extract_feature_matrix" in ns and "build_class_waveform" in ns
    return ns


def dataset_from_arrays(arrs):
    """xarray Dataset that decodes 32767 to NaN, as the real files' _FillValue does."""
    data = {}
    for name, a in arrs.items():
        a = np.asarray(a, dtype=np.float64)
        a = np.where(a == 32767, np.nan, a)
        data[name] = (("y", "x"), a)
    return xr.Dataset(data)


VARS = ["NumCycles", "QA", "QA_2"] + [
    f"{v}{s}" for s in ("", "_2") for v in ["OGI", "50PCGI", "OGMx", "Peak", "OGD", "50PCGD", "OGMn", "EVImax", "EVIamp", "EVIarea"]
]


def synthetic_cases(rng):
    """A 6x8 grid of hand-made edge cases followed by random plausible pixels."""
    h, w = 6, 8
    n = h * w
    a = {v: np.full(n, 32767, dtype=np.int64) for v in VARS}

    def put(i, **kw):
        for k, v in kw.items():
            a[k][i] = v

    def plausible(i, two=False, onset=None):
        o = int(rng.integers(-60, 300)) if onset is None else onset
        put(i, NumCycles=2 if two else 1, QA=int(rng.integers(1, 4)), QA_2=int(rng.integers(1, 4)) if two else 32767,
            OGI=o, **{"50PCGI": o + 20, "OGMx": o + 45, "Peak": min(366, max(1, o + 70)), "OGD": o + 95, "50PCGD": o + 150, "OGMn": o + 190},
            EVImax=int(rng.integers(3000, 8000)), EVIamp=int(rng.integers(1000, 3000)), EVIarea=int(rng.integers(3000, 20000)))
        if two:
            o2 = o + 120
            put(i, OGI_2=o2, **{"50PCGI_2": o2 + 10, "OGMx_2": o2 + 25, "Peak_2": min(366, max(1, o2 + 35)), "OGD_2": o2 + 45, "50PCGD_2": o2 + 60, "OGMn_2": o2 + 80},
                EVImax_2=int(rng.integers(3000, 7000)), EVIamp_2=int(rng.integers(800, 2500)), EVIarea_2=int(rng.integers(2000, 9000)))

    for i in range(n):
        plausible(i, two=bool(rng.random() < 0.35))
    # Edge cases at fixed cells.
    put(0, QA=4)                                   # cycle-1 QA rejected
    put(1, QA=32767)                               # QA fill -> no product
    plausible(2, onset=330)                        # season wraps the year end
    put(3, EVImax=32767)                           # missing cycle-1 greenness
    plausible(4, two=True); put(4, QA_2=4)         # cycle 2 present but QA_2 = 4 -> zero-filled
    plausible(5, two=True); put(5, OGMx_2=32767)   # usable cycle 2 with a missing value -> excluded
    plausible(6, two=False); put(6, NumCycles=2, QA_2=32767)  # NumCycles 2 but QA_2 fill -> zero-filled
    plausible(7, onset=-40)                        # onset in the previous year (negative DOY)
    put(8, OGI=32767)                              # missing anchor
    plausible(9, two=True, onset=250)              # cycle 2 wraps into next year
    return h, w, {k: v.reshape(h, w) for k, v in a.items()}


def cmd_fixtures(args):
    cache = args.cache
    ref = load_reference(cache)
    rng = np.random.default_rng(7)
    out = {"commit": COMMIT, "cases": []}
    for case in range(2):
        h, w, arrs = synthetic_cases(rng)
        if case == 1:
            # No usable second cycle anywhere: cycle-2 columns are constant zero.
            arrs["NumCycles"] = np.where(arrs["NumCycles"] == 32767, 32767, 1)
        ds = dataset_from_arrays(arrs)
        X, ogi_raw, mask, shape, names = ref["extract_feature_matrix"](ds)
        valid = ~np.isnan(X).any(axis=1)
        Xc = X[valid]
        sc = StandardScaler().fit(Xc)
        Xs = sc.transform(Xc)
        km = KMeans(n_clusters=3, init="k-means++", n_init=20, random_state=42).fit(Xs)
        out["cases"].append({
            "height": h, "width": w,
            "inputs": {k: v.ravel().astype(int).tolist() for k, v in arrs.items()},
            "featureNames": list(names),
            "validCells": np.where(valid)[0].tolist(),
            "features": Xc.tolist(),
            "ogiRaw": ogi_raw[valid].tolist(),
            "scaler": {"mean": sc.mean_.tolist(), "var": sc.var_.tolist(), "scale": sc.scale_.tolist(), "n": int(sc.n_samples_seen_)},
            "kmeans": {"k": 3, "centers": km.cluster_centers_.tolist(), "inertia": float(km.inertia_),
                        "predict": km.predict(Xs).tolist()},
        })

    # Waveforms: the notebook's own reconstruction on its published class medians.
    summary = pd.read_csv(fetch(CSV_URL, os.path.join(cache, f"summary-{COMMIT[:7]}.csv")), index_col="class")
    axis = np.arange(0, 365)
    waves = []
    for cls, row in summary.iterrows():
        _, curve = ref["build_class_waveform"](row, axis)
        waves.append({"class": int(cls), "medians": {k: float(v) for k, v in row.items()}, "curveStored": [float(x) for x in curve]})
    out["waveforms"] = waves
    sm = ref["smooth_max"]
    out["smoothMax"] = [{"a": a, "b": b, "k": 0.15, "value": float(sm(np.array([a]), np.array([b]))[0])} for a, b in [(1000, 1000), (1000, 5000), (6000, 5990)]]

    os.makedirs(FIXTURES, exist_ok=True)
    path = os.path.join(FIXTURES, "reference-small.json")
    json.dump(out, open(path, "w"))
    print("wrote", os.path.relpath(path))


def cmd_realdata(args):
    ref = load_reference(args.cache)
    site = args.site
    years = [2021, 2022, 2023, 2024]
    per_year = []
    Xs_all, meta = [], []
    for y in years:
        ds = xr.open_dataset(os.path.join(args.site_dir, f"{site}-wetlsp-{y}.nc"))
        X, ogi_raw, mask, shape, names = ref["extract_feature_matrix"](ds)
        valid = ~np.isnan(X).any(axis=1)
        H, W = shape
        # The v001 rows are stored south-first: report cells in north-up order.
        rows, cols = np.divmod(np.where(valid)[0], W)
        nu = (H - 1 - rows) * W + cols
        order = np.argsort(nu)
        Xv = X[valid][order]
        per_year.append({"year": y, "valid": int(valid.sum()), "colSum": Xv.sum(axis=0).tolist(),
                         "colSumSq": (Xv ** 2).sum(axis=0).tolist(), "ogiRawSum": float(ogi_raw[valid].sum())})
        Xs_all.append(Xv)
        meta.append((y, nu[order], H, W))
    X = np.vstack(Xs_all)
    sc = StandardScaler().fit(X)
    Xs = sc.transform(X)
    print(f"{site}: {X.shape[0]:,} eligible pixel-years; fitting sklearn KMeans k=7 n_init=20 ...", flush=True)
    km = KMeans(n_clusters=7, init="k-means++", n_init=20, random_state=42).fit(Xs)
    labels = km.labels_
    os.makedirs(args.out_dir, exist_ok=True)
    off = 0
    for (y, nu, H, W) in meta:
        lab = np.zeros(H * W, dtype=np.uint8)
        lab[nu] = labels[off:off + len(nu)] + 1
        off += len(nu)
        lab.tofile(os.path.join(args.out_dir, f"sklearn-labels-{y}.u8"))
    # The notebook's class summary (medians over pooled pixel-years).
    df = pd.DataFrame(X, columns=names)
    df["class"] = labels + 1
    med = df.groupby("class").median()
    json.dump({
        "site": site, "years": years, "perYear": per_year,
        "scaler": {"mean": sc.mean_.tolist(), "var": sc.var_.tolist(), "scale": sc.scale_.tolist(), "n": int(sc.n_samples_seen_)},
        "kmeans": {"centers": km.cluster_centers_.tolist(), "inertia": float(km.inertia_), "nIter": int(km.n_iter_),
                    "counts": np.bincount(labels, minlength=7).tolist()},
        "medians": {int(c): {k: float(v) for k, v in r.items()} for c, r in med.iterrows()},
        "sklearn": __import__("sklearn").__version__,
    }, open(os.path.join(args.out_dir, "reference.json"), "w"))
    print("wrote", args.out_dir)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cache", default=os.environ.get("TMPDIR", "/tmp"))
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fixtures")
    r = sub.add_parser("realdata")
    r.add_argument("site_dir")
    r.add_argument("out_dir")
    r.add_argument("--site", default="US-Myb")
    args = p.parse_args()
    {"fixtures": cmd_fixtures, "realdata": cmd_realdata}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
