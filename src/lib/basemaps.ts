/**
 * OpenFreeMap styles for light/dark maps, Esri raster imagery for satellite.
 * The `none` style needs no network at all and is what the app falls
 * back to offline. Pixels stay correctly positioned and only lose the imagery.
 */
import type { StyleSpecification } from 'maplibre-gl';

export type BasemapId = 'light' | 'dark' | 'satellite' | 'none';

const ESRI_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';

function raster(
  tiles: string[],
  attribution: string,
  maxzoom = 19,
  background = '#10161d',
): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': background } },
      { id: 'base', type: 'raster', source: 'base' },
    ],
  };
}

/** No tiles at all: a plain grid, so pixels still read as a spatial layout. */
function blank(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: { 'background-color': dark ? '#0e131a' : '#eef0f4' },
      },
    ],
  };
}

export function basemapStyle(id: BasemapId, dark: boolean): StyleSpecification | string {
  switch (id) {
    case 'satellite':
      return raster(
        [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        ESRI_ATTRIBUTION,
        19,
        '#0b1016',
      );
    case 'dark':
      return 'https://tiles.openfreemap.org/styles/dark';
    case 'light':
      return 'https://tiles.openfreemap.org/styles/positron';
    case 'none':
    default:
      return blank(dark);
  }
}

export const BASEMAP_OPTIONS: Array<{ value: BasemapId; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'none', label: 'None' },
];

/** The style to use when the user has not chosen: follows theme, and offline. */
export function defaultBasemap(dark: boolean, online: boolean): BasemapId {
  if (!online) return 'none';
  return dark ? 'dark' : 'light';
}
