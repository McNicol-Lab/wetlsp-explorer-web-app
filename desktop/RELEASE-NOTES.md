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
