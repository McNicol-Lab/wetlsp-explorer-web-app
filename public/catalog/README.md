# Bundled site catalog

`wetlsp_site_catalog.csv` is the catalog the app loads at startup so the Overview
world map and the Catalog view work offline, before anything is uploaded.

This is the real `wetlsp_cyverse_site_catalog_final.csv` export, installed from
`wetlsp-data/` on 2026-09-18: 95 sites, all with latitude and longitude, with
availability columns for 2021–2024. Coordinates are copied from the source.

To update the bundled catalog:

```sh
npm run catalog:import -- /path/to/wetlsp_cyverse_site_catalog_final.csv
```

That checks the file, reports how many sites it has and how many have
coordinates, and copies it into place. Rebuild the app to see them on the world map.

Users can also load a catalog while the app runs. **Settings → Site catalog →
Load catalog file** accepts the same CSV (or a JSON array of the same fields),
and it replaces the bundled copy on that computer.

## Columns

| column | required | meaning |
| --- | --- | --- |
| `site_id` | yes | joins to uploaded site folders (`CA-DB2`, `US-Myb`, …) |
| `site_name` | no | display name |
| `country` | no | ISO name or code |
| `lat`, `lon` | no | WGS84 decimal degrees; a site without both is listed but not mapped |
| `base_network` | no | AmeriFlux, FLUXNET, … |
| `tower_height_m`, `canopy_height_m` | no | metres |
| `wetlsp_<year>` | no | availability flag; `1`/`true`/`yes` mean available |

Any other column is preserved and shown in the Catalog table.
