# WetLSP Explorer

Explore wetland vegetation through the seasons. Open a WetLSP site folder to
view EVI time series, select pixels on a map, and compare annual phenology.

A desktop app for **Mac** and **Windows**. Your data stays on your computer.

| I want to… | Go to |
| --- | --- |
| Install the app | [Download](#download) below |
| Follow step-by-step instructions | **[SETUP.md](SETUP.md)** |
| Fix a problem | [Troubleshooting](SETUP.md#if-something-goes-wrong) |
| See what the app does | [The five views](#the-five-views) · [Video walkthrough](#video-walkthrough) |
| Cite the app or its data | [References and how to cite](#references-and-how-to-cite) · [Data sources](#data-sources-and-attribution) |

---

## Download

**[→ Get the latest release](https://github.com/bhagyeshsagole/wetlsp-explorer/releases/latest)**

Open **Assets** on that page and pick the file for your computer:

| Your computer | File ending in |
| --- | --- |
| Mac, Apple silicon (M1/M2/M3/M4 or newer) | `mac-arm64.dmg` |
| Mac, Intel processor | `mac-x64.dmg` |
| Windows 10 or 11 | `win-x64.exe` |

Not sure which Mac you have? **Apple menu → About This Mac**.

Skip the **Source code** archives — those are for developers, not installation.

<details>
<summary><strong>The download page shows 404</strong></summary>

The repository is private. Sign in with a GitHub account the lab has invited,
or ask the lab to send you the installer file directly. You do not need a
GitHub account to use a file someone shares with you.
</details>

<details>
<summary><strong>My computer warns me not to open it</strong></summary>

Expected — these lab builds are not signed with a paid Apple or Microsoft
certificate. You confirm once, then it never asks again.

**Mac:** double-click the app, click **Done** on the warning, then go to
**System Settings → Privacy & Security → Open Anyway** and confirm **Open**.
**Windows:** **More info → Run anyway**.

If a Mac instead says the app is **damaged**, you have a release older than
v1.0.3 — download the latest one.

Only do this for installers from this repository or your lab.
[Full details in SETUP.md](SETUP.md).
</details>

---

## Open your first site

To try the app straight away, click **Download sample sites** on the start
screen. It fetches five wetland sites (CA-DSM, FR-LGt, BR-SM1, US-BZF, CZ-Wet;
about 1 GB) from the lab's [public data release](https://github.com/McNicol-Lab/wetlsp-sample-data/releases/tag/v2)
and opens the first one. After that download, the sites work offline. To add
your own data:

1. Click **Upload folder**.
2. Choose a site folder such as **CA-DB2**, a folder holding several sites, or
   a folder of the `.zip` files Google Drive downloads. Each site is found and
   imported separately.
3. Wait for the import to finish, then pick a view.

You can also drag folders or `.zip` files onto the window, or pick individual
files. Both single-file and batched `_ds` datasets work.

---

## The five views

| View | Use it to |
| --- | --- |
| **Overview** | Locate a site; check its dates, pixel coverage, years, and metadata. |
| **Time Series** | Line chart of daily mean EVI with its interquartile band and estimated green-up, peak and green-down dates; overlay years; show every pixel; export results. |
| **Pixel Map** | Select pixels or draw a region, then inspect that selection's time series. |
| **Phenometrics** | Examine timing, greenness, and quality layers; compare up to four site-years. |
| **Catalog** | Search the bundled 95-site catalog and export site information. |

---

## Your data

Everything is processed and stored on your own computer. Nothing is uploaded.

The installer bundles the app, the site catalog, and the scientific readers, so
you can import and analyze local files **without internet** — including on first
launch. Only basemap imagery needs a connection.

Keep your original dataset folders as your permanent copy. Imported sites and
preferences are stored separately from the app, so they survive updates.

Imported data can use up to **50 GB**, or less if your disk has less free
space. When an import would go over, the app asks you to delete a site first.
Manage sites in **Settings → Storage**. Deleted sample sites can be downloaded
again from **Settings → Sample sites**.

### Figures

Every chart and map has **PNG** and **Copy** buttons. Copy puts the image on
the clipboard for slides or chat. Shortcuts: **⌘S** / **Ctrl+S** saves, and
**⌘⇧C** / **Ctrl+Shift+C** copies. Exports carry a title with the site, year
and sample size. The **⋯** menu adds a vector SVG, a 1920×1080 slide PNG, CSVs,
and a ready-to-paste figure caption that describes exactly what is plotted.

---

## Updates

Manual for now: close the app, download the new installer from
[Releases](https://github.com/bhagyeshsagole/wetlsp-explorer/releases/latest),
and install it over your existing copy. [Details](SETUP.md#updates-and-saved-data).

---

## Video walkthrough

See WetLSP Explorer in action: **Gavin's WetLSP** (YouTube).

<a href="https://youtu.be/ggAGSodHSn0">
  <img src="https://img.youtube.com/vi/ggAGSodHSn0/maxresdefault.jpg" alt="Gavin's WetLSP: video walkthrough of WetLSP Explorer (click to play on YouTube)" width="720">
</a>

[▶ Watch on YouTube](https://youtu.be/ggAGSodHSn0)

---

## Data sources and attribution

WetLSP Explorer is a viewer. It does not include or process satellite imagery.

- **WetLSP products.** The site folders the app opens (annual
  `*-wetlsp-<year>.nc` phenometric NetCDFs and the `pixels_*` Parquet tables
  of daily EVI) are Wetland Land Surface Phenology (WetLSP) products made by
  the Ecosystem and Planetary Health Integration Lab (ecoϕlab) at the
  University of Illinois Chicago with the
  [WetLSP pipeline](https://github.com/McNicol-Lab/WetLSP). That pipeline is a
  fork of the [PLSP](https://github.com/BU-LCSC/PLSP) algorithms from Boston
  University's Land Cover & Surface Climate Group (Moon et al., 2022), updated
  for FLUXNET-CH4 wetland sites. PlanetScope surface reflectance scenes
  (2021–2024) are filtered and converted to EVI, then gap-filled and smoothed
  with a spline to give daily per-pixel EVI. Annual phenometrics (green-up,
  peak, green-down, EVI amplitude, quality flags, and so on) are then computed
  using the definitions in Moon et al. (2022). Published WetLSP data are the
  annual phenometrics and the spline-smoothed daily EVI. Per-acquisition
  (unsmoothed) EVI values are an internal processing step and are not
  distributed.
- **PlanetScope imagery.** The PlanetScope imagery (2021–2024) was obtained
  through the [NASA Commercial Satellite Data Acquisition (CSDA) Program](https://science.nasa.gov/earth-science/csda/vendor-planet/).
  Includes copyrighted material of Planet Labs PBC. All rights reserved.
  Published WetLSP data are limited to annual phenometrics and gap-filled,
  spline-smoothed daily EVI. They are shared as Derived Products under the
  [CSDA Program EULA for Planet Data](https://www.earthdata.nasa.gov/s3fs-public/2022-02/Planet_Expanded_EULA_06-21.pdf).
  Raw PlanetScope scenes, surface reflectance bands, per-acquisition
  (unsmoothed) index values, and Planet quality masks are **not** distributed
  with this app, its installers, or the sample data. If you publish figures or
  results made with the app, credit Planet and CSDA as described in
  [References and how to cite](#references-and-how-to-cite).
- **Sample sites and catalog.** The sample sites come from the lab's
  [wetlsp-sample-data](https://github.com/McNicol-Lab/wetlsp-sample-data/releases/tag/v2)
  release, which holds each site's annual phenometrics and spline-smoothed
  daily EVI only. The bundled 95-site catalog ([details](public/catalog/README.md)) is
  the WetLSP site catalog. Site IDs (for example `US-BZF`) follow FLUXNET
  naming and refer to eddy-covariance flux tower sites. The catalog's
  `base_network` column lists AmeriFlux and European flux network
  affiliations. The app contains no flux-tower measurements.
- **Basemaps.** Map backgrounds are loaded at runtime from OpenFreeMap
  (OpenStreetMap data) and Esri World Imagery, with attribution shown on the
  map. They are not PlanetScope imagery.

---

## References and how to cite

If you use WetLSP Explorer or WetLSP data in a publication, please cite the
method, the data, and the imagery provider, and acknowledge the ecoϕlab.

**Method and original phenology dataset**

- Moon, M., Richardson, A. D., Milliman, T., & Friedl, M. A. (2022). A high
  spatial resolution land surface phenology dataset for AmeriFlux and NEON
  sites. *Scientific Data*, 9, 448.
  <https://doi.org/10.1038/s41597-022-01570-5>
- Moon, M., Richardson, A. D., Milliman, T., & Friedl, M. A. (2023). *Land
  Surface Phenology, Eddy Covariance Tower Sites, North America, 2017-2021*
  (Version 1). ORNL DAAC. <https://doi.org/10.3334/ORNLDAAC/2033>

**Code**

- PLSP, the original algorithms (Boston University Land Cover & Surface
  Climate Group): <https://github.com/BU-LCSC/PLSP>
- WetLSP, the ecoϕlab fork used to generate WetLSP products:
  <https://github.com/McNicol-Lab/WetLSP>

**WetLSP data**

- WetLSP site-level products (v001). Ecosystem and Planetary Health
  Integration Lab (ecoϕlab), University of Illinois Chicago.
  **Dataset DOI: TODO, not yet assigned.** Until a DOI exists, cite Moon et
  al. (2022) and the WetLSP repository, and include this acknowledgment:
  "WetLSP processing and site-level products generated by the Ecosystem and
  Planetary Health Integration Lab (UIC)."

**PlanetScope imagery (NASA CSDA)**

- Planet Team (2026). Planet Application Program Interface: In Space for Life
  on Earth. San Francisco, CA. <https://api.planet.com>
- Include this acknowledgment, which CSDA requires: "This work utilized data
  made available through the NASA Commercial Satellite Data Acquisition (CSDA)
  Program."
- Label figures and products made from the imagery with CSDA's derived-product
  copyright marking: "Includes copyrighted material of Planet Labs PBC. All
  rights reserved."
- CSDA asks authorized users to send it a courtesy copy of any publication that
  includes CSDA-distributed data
  ([CSDA Planet vendor page](https://science.nasa.gov/earth-science/csda/vendor-planet/)).

**This app**

- Sagole, B., & McNicol, G. (2026). *WetLSP Explorer* (Version 1.2.1)
  [Computer software]. <https://github.com/bhagyeshsagole/wetlsp-explorer>

---

## Acknowledgments

WetLSP data and scientific guidance come from the Ecosystem and Planetary
Health Integration Lab (ecoϕlab, the McNicol Lab) in the Department of Earth
and Environmental Sciences at the University of Illinois Chicago. The WetLSP
data contributors are Gavin McNicol, Aarin Bothra, Youmi Oh, Lichen Liu,
Sparkle Malone, and Qing Zhu. The phenology algorithms were developed by
Minkyu Moon, Andrew D. Richardson, Thomas Milliman, and Mark A. Friedl. WetLSP
data were developed for wetland methane research in the ecoϕlab, the ESIIL AI
for Natural Methane Working Group, and the USGS Powell Synthesis for Wetlands.
We thank the flux tower site teams and networks (AmeriFlux, FLUXNET /
FLUXNET-CH4, and European flux networks) whose sites anchor the WetLSP
catalog, and Planet Labs PBC and the NASA CSDA Program for the PlanetScope
imagery.

---

## License

The app's source code is released under the [MIT License](LICENSE).

The MIT License applies only to the app's source code. It does not cover:

- **Published WetLSP data** (annual phenometrics and spline-smoothed daily
  EVI), which have their own terms. The WetLSP NetCDF files list
  `license = CC-BY-4.0` in their metadata.
- **PlanetScope imagery**, including raw scenes, reflectance bands,
  per-acquisition index values, and quality masks. These are copyrighted by
  Planet Labs PBC, governed by the CSDA Program EULA for Planet Data, and not
  redistributed here.
- **Basemap tiles**, which are covered by their providers' terms.

The WetLSP and PLSP code repositories linked above do not have license files
either. Ask their authors before reusing that code.
