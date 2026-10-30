**Faster in v1.3.4: large sites import about three times faster, with a clearer progress bar.**

- The one-time split of a large time series (any `pixels_timeseries` over
  768 MB) now writes several parts at once, on up to four processor cores.
  On a 10-core Mac, BR-Npw (12.7 GB) is split in about 2 minutes instead of
  about 6, and a 2.5 GB part of it imports in 38 s instead of 82 s.
- The time series is split straight from the files you drop, rather than
  copied into the app first. Importing BR-Npw needs room for its 3.7 GB of
  parts, not for the 12.7 GB file as well. Your original files are not
  changed.
- The parts take about a quarter less space than in v1.3.3 and are a little
  faster to read. Charts and statistics are unchanged.
- The progress bar moves smoothly instead of jumping a part at a time. It
  shows how much is done ("4.8 GB of 11.9 GB · 7 of 18 parts done · 4 in
  parallel"), about how long is left, and why the step happens. The
  percentage also shows in the browser tab and, in the desktop app, on the
  Dock or taskbar icon. The rest of the app stays usable meanwhile.
- Cancel stops an import at once, also part way through copying a file.
  Cancelling a new import of a site you already have leaves that site's time
  series as it was.

**Fixed in v1.3.3: large sites open and chart much faster.**

- Re-importing a large site (such as BR-Npw, 12.7 GB) could leave its time
  series unsplit, with the note "could not be split: … No OPFS access handle
  registered". Every chart then read the whole file in place and took many
  minutes. The split now works over parts left by an earlier import, and
  those leftover parts (gigabytes on large sites) are deleted. Sites left
  unsplit are split the next time they are opened.
- The first chart of a year no longer waits for the whole site to be read.
  The sampled pixels are read on their own, and the full year is still
  prepared in the background. On a 222,000-pixel part of BR-Npw the first
  chart took 1.5 s and *New random sample* 0.8 s; the numbers match the full
  year's exactly. A clicked pixel's trace on the Pixel Map is faster too.
- The time series is now read through the browser's fast file access. Years
  are prepared without first loading each part into memory, a time series
  that could not be split is read about 8 times faster, and the split and
  the site summary after it take less time (85 s to 71 s, and 15 s to 7 s,
  on the 2.5 GB test part).
- While a year is still being prepared, the footer says "250 pixels sampled"
  without the site's total; the total appears once the year is ready.
- A random sample is now drawn from the site's mapped pixels, skipping those
  without data that year. The same seed gives the same pixels however the data
  is read.

**Fixed in v1.3.2: sites without `pixels_meta` can be mapped.**

- WetLSP geometry files also carry the site's coordinate reference system in
  their own metadata. When `pixels_meta` is missing (or has no CRS), the app
  now reads it from there, so the pixels are placed on the map instead of
  "the coordinate reference system is unknown". Sites already imported pick
  it up the next time they are opened.
- The import message no longer warns about an unknown CRS when the geometry
  file supplies it, so a missing time series is what it reports. Time Series
  then names the missing file (e.g. `AU_Arc_pixels_timeseries.parquet`) and
  says to import the site again with it.

**Fixed in v1.3.1: sites whose time series is over 2 GB.**

- On sites such as AU-Arc (a 2.75 GB `pixels_timeseries`), Time Series and
  *New random sample* failed with "The requested file could not be read,
  typically due to permission problems…". The browser cannot load a file of
  2 GB or more in one piece, and the app loaded each time series file whole
  to prepare a year. The map was not affected.
- On import, a time series file over 768 MB is now stored as parts of about
  384 MB, split by pixel range, with EVI kept as 32-bit floats (the precision
  every chart and export already used). An AU-Arc-sized file becomes four
  parts, about half the size, in about a minute. Your original files are not
  changed.
- Sites imported with an earlier version are split once, the first time they
  are opened after updating. Cancel leaves the site as it was.
- If a file still cannot be split, charts read it in place instead of
  failing (slower), and the message says what to do.

**New in v1.3.0: compare regions, import shapefiles, overlay rasters.**

- *Regions.* On the Pixel Map, switch the toolbar to *Add region* and drag
  boxes or lassos: each becomes a named, coloured region.
- *Shapefiles.* The upload button (or *Open dataset*, or a drop onto the
  window) imports a shapefile, such as a National Wetlands Inventory
  download. Each polygon that holds pixels becomes a region, named from its
  attributes (e.g. `PEM1Cm`). Polygons can be pooled by an attribute. Any
  projection with a `.prj` works. If the layer is for another place, the app
  says where it is and offers to open a site it covers.
- *Compare.* One mean line and IQR band per region in Time Series, in the
  region's map colour, with green-up, peak and green-down per region. Export
  the daily mean and IQR or every observation per region as CSV, and the
  regions as GeoJSON.
- *Raster overlay.* Lay a GeoTIFF or NetCDF-4 grid under the pixels; pick the
  band or variable, colours and opacity, and hover to read values.
- The sample-data scripts can ship the per-acquisition (raw) EVI, for sample
  release v3. Download sample sites still uses v2 until v3 is published.

**Fixed in v1.2.7: phenometric maps are the right way up.** The WetLSP
phenometrics files store their rows south to north, and the maps were drawn
upside down in *Figure*, *Map* and *3D relief*. They now show north at the
top and line up with the basemap and the Pixel Map.

**New in v1.2.6: updated credits and documentation.** The app is credited to
Bhagyesh Sagole and Pawan Kumar, in the installer's copyright line and in the
citation. The README and setup guide are reworded for clarity.

**New in v1.2.5: plainer wording.** Labels, help text and messages across
the app are rewritten in plain sentences. Nothing else changes.

**Fixed in v1.2.4: the Pixel Map follows the site you pick.** Switching
sites now moves the map to the new site, in both *Pixels* and *Skyline*,
instead of staying where the previous site was.

**New in v1.2.3: a coloured pixel map.** The Pixel Map now opens with each
pixel coloured by its mean EVI for the selected year, with a legend. Switch it
off with *Mean EVI* in the map toolbar.

**New in v1.2.2: charts load in about a second.** Each year of a site is
prepared once in the background as soon as the site opens, and saved offline.
The first chart, switching years or sites, and drawing a new random sample
now take under a second instead of 15–20 seconds. The prepared data uses
about 20 MB per year per site of offline storage; removing a site deletes it.

**Fixed in v1.2.1: sites that "could not be opened".** Removing a site and
downloading or importing it again in the same session could fail with
"TProtocolException: Invalid data" (or "NotReadableError" when importing over
a site). Replaced sites now always open. If you saw this in v1.2.0, restarting
the app also clears it; your downloaded sites are fine.

**New in v1.2.0**

- **Random pixel samples you can redraw.** A rectangle or lasso around more
  pixels than the sample size now takes a true random sample from the whole
  shape, not a stripe along its top. *Redraw* picks different pixels. The Time
  Series has *New random sample* too. Clicking pixels is no longer blocked at 500.
- **3D relief for every panel.** Phenometrics draws one 3D view per selected
  site-year, side by side, and exports all of them.
- **Years 2021–2024.** Charts offer only the years with phenometrics files and
  open on the latest.
- **Load problems are shown, with a fix.** If a site's metadata cannot be read,
  the Overview says why, and *Reload metadata* reads it again. The app warns
  when a site's metadata names a different site than its files.
- **Sample sites moved** to the lab's release (McNicol-Lab/wetlsp-sample-data).
  They are now about 1 GB and hold only annual phenometrics and spline-smoothed
  daily EVI.
- Map zoom buttons moved to the bottom right, where toolbars no longer cover
  them. The chart toolbar no longer sits on the plot. Large sites export and
  inspect pixels faster.

**Fixed in v1.1.1: Copy.** The *Copy* button (and ⌘⇧C / Ctrl+Shift+C) failed
in the desktop app with "Write permission denied". Charts and maps now copy to
the clipboard as images.

**New in v1.1.0**

- **Download sample sites in one click.** The start screen's *Download sample
  sites* button fetches five wetland sites (CA-DSM, FR-LGt, BR-SM1, US-BZF,
  CZ-Wet; 1.3 GB) and opens the first, with nothing to find or unzip. After
  that, they work offline.
- **Upload folder works with any folder.** Pick a folder holding several sites,
  or the `.zip` files Google Drive downloads. Each site is found and imported in turn.
- **Time series line chart.** It shows the daily mean, the interquartile band
  and estimated green-up, peak and green-down dates, with a *Compare years*
  view. A toggle adds a line per pixel.
- **Copy and export figures.** *Copy* puts any chart or map on the clipboard.
  Exports are titled, and the menu adds SVG, slide-sized PNG and a figure caption.
- **Up to 50 GB of sites.** When storage is full, the app asks you to delete a site first.

Download the installer for your computer under **Assets**:

- **Mac with Apple silicon (M1/M2/M3/M4 or newer):** `mac-arm64.dmg`
- **Mac with an Intel processor:** `mac-x64.dmg`
- **Windows 10/11, Intel or AMD 64-bit:** `win-x64.exe`

On Mac, open the DMG and drag the WetLSP Explorer app inside it into
Applications (the app, not the DMG file). On Windows, open the EXE to install
for your account. The scientific readers are bundled, so the app works offline.

These lab builds are not signed with a paid Apple or Microsoft certificate, so
you approve them once. On macOS, double-click the app, click **Done** on the
"could not verify" warning, then go to **System Settings → Privacy & Security →
Open Anyway** and confirm **Open**; later launches open normally. Windows may show
SmartScreen → More info → Run anyway. Only approve installers you obtained from
this repository or your lab. Managed computers may require IT approval.

See [SETUP.md](https://github.com/McNicol-Lab/wetlsp-explorer-web-app/blob/main/SETUP.md)
for step-by-step installation and dataset instructions. You need access to
this repository to download from it, or the owner can send colleagues the
installer files directly.

Updates are manual: download and install the new version over the existing one.
Imported datasets are stored separately in the app's local profile.
