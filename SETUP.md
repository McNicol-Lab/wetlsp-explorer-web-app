# Install WetLSP Explorer

Download the **Mac DMG** or **Windows EXE**, install the app, and open your data.

## Download the installer

Open **[Download WetLSP Explorer](https://github.com/bhagyeshsagole/wetlsp-explorer/releases/latest)**
and expand **Assets**. Choose the file for your computer:

| Your computer | Download ending in |
| --- | --- |
| Mac with Apple M1, M2, M3, M4 or newer chip | `mac-arm64.dmg` |
| Mac with Intel processor | `mac-x64.dmg` |
| Windows 10 or 11, Intel/AMD 64-bit | `win-x64.exe` |

On Mac, **Apple menu → About This Mac** tells you which chip you have.

This is a private lab repository. Sign into GitHub with an account the owner
has invited. If the page says **404**, ask the owner for access or for the
installer file directly. You do not need a GitHub account when someone gives
you the installer file. Do not download **Source code**: that is for developers.

## Install on Mac

1. Double-click the downloaded **.dmg** file.
2. Drag the **WetLSP Explorer app icon** onto the **Applications** folder in that window.
   Move the app inside the DMG, not the DMG file itself.
3. Open **Applications**, then double-click **WetLSP Explorer**.
4. Eject the installer disk when you are done. You can delete the downloaded DMG.
5. To keep the app handy, right-click its Dock icon → **Options → Keep in Dock**.

**The first launch shows a warning.** That is expected: these lab builds are
signed, but not with a paid Apple Developer certificate, so macOS asks you to
confirm the first time only.

1. Double-click the app. macOS says **"Apple could not verify WetLSP Explorer is
   free of malware."** Click **Done**. Do not click Move to Trash.
2. Open **System Settings → Privacy & Security** and scroll down to the message
   about WetLSP Explorer.
3. Click **Open Anyway**, then confirm **Open**.

The app opens, and every launch after that is a normal double-click. Right-click
→ Open no longer works on recent macOS versions; use the steps above. Only do
this for the installer provided by your lab. If **Open Anyway** is missing on a
managed computer, contact your IT team; do not disable system security.

## Install on Windows

1. Double-click the downloaded **.exe** installer.
2. The app installs for your account and opens automatically.
3. Next time, open **WetLSP Explorer** from the Start menu or desktop shortcut.

These lab builds are unsigned, so the first launch may show a warning. If Windows
shows **Windows protected your PC**, select **More info**, check that this is the
WetLSP installer you downloaded, then select **Run anyway**. Your institution
may require IT approval. An administrator password is normally not needed.

## Open your data

1. Select **Upload folder** in WetLSP Explorer.
2. Choose a WetLSP site folder such as **CA-DB2**, a folder holding several
   sites, or the `.zip` files downloaded from Google Drive. You can also drag
   them into the app.
3. Wait until it appears in **Loaded sites**.
4. Explore **Overview**, **Time Series**, **Pixel Map**, **Phenometrics**, and
   **Catalog** using the tabs.

Each site is detected and imported separately, one after another. Keep each
site's parquet files, any batch subfolders, and annual `.nc` files together.
The app stores up to 50 GB of sites. If an import needs more room, it asks you
to delete a site before continuing.
The first import may take a while for large datasets. Keep the app open until
it finishes. Imported data stays on your computer.

## Working offline

The installer includes the app, site catalog, and scientific readers. You can
start it and import local datasets without internet, including the first launch.

Basemap imagery needs an internet connection unless those tiles were previously
cached. Without imagery, your pixel positions, charts, and saved datasets remain
available.

## Updates and saved data

Updates are currently manual. Close the app, download the latest installer from
the same link, and install it over the old version. On Mac choose **Replace**
when copying into Applications. On Windows run the new installer.

Imported datasets are kept separately from the application:

- Mac: `~/Library/Application Support/WetLSP Explorer`
- Windows: `%APPDATA%\WetLSP Explorer`

Do not delete this folder if you want to keep imported sites and preferences.
Always keep the original dataset folders as your permanent copy.

## If something goes wrong

- **Download page says 404:** ask the owner for repository access or the installer file.
- **App is blocked:** follow the first-launch note for your OS, or contact institutional IT.
- **Mac says the app is damaged:** you are on a release before v1.0.3, which shipped
  with a broken signature. Download the latest release and use that installer. Do not
  remove security checks.
- **A folder does not load:** choose a single complete site folder containing parquet
  and/or NetCDF data, and wait for the import to finish.
- **Local port 47831 is in use:** close another copy of WetLSP Explorer. If the message
  remains, restart the computer or ask IT which program is using that port.
- **Plain map while offline:** expected; imagery is online content, while the analysis is local.

## Updating the sample sites (maintainers)

The app's **Download sample sites** button fetches five sites from the lab's
public release at [McNicol-Lab/wetlsp-sample-data v2](https://github.com/McNicol-Lab/wetlsp-sample-data/releases/tag/v2).
The installer itself does not contain them. The release holds only what the lab
may redistribute under the NASA CSDA terms: the annual phenometric NetCDFs and
the spline-smoothed daily EVI. `npm run samples` removes the per-acquisition
`raw` EVI rows, and `npm run samples:publish` refuses to upload a file that
still has them. Both need DuckDB (`brew install duckdb` or `pip install duckdb`).
To publish a new set:

```sh
npm run samples                        # extract ../Actual Data/*.zip into samples/ (git-ignored), spline only
npm run samples:publish -- --dry-run   # check the files and update src/lib/sample-index.json
npm run samples:publish -- --stage DIR # or lay the release out in DIR to upload by hand
npm run samples:publish                # upload them to the release
```

A new repository or tag also means updating `SAMPLE_RELEASE` in
`desktop/server.mjs`, the one address the app downloads samples from. Then
commit `src/lib/sample-index.json` and build a new installer. The app learns
about files from that index, so the index and the release must match.
