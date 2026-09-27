/// <reference lib="webworker" />
/**
 * Service worker.
 *
 * The app shell, including the Plotly bundle and the h5wasm NetCDF worker, is
 * precached, so every view works with the network off. The 34 MB DuckDB wasm is
 * deliberately left out of the precache (it would make installing unbearable);
 * it is runtime-cached the first time the engine boots, which is also what
 * "Prepare for offline" in Settings triggers.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import { clientsClaim } from 'workbox-core';
import { DUCKDB_CACHE } from './engine/offline';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Installed PWAs open at their start URL; serve the shell for any navigation.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

/** DuckDB-WASM: cached on first boot, then served locally forever. */
registerRoute(
  ({ url }) => url.pathname.includes('/duckdb/'),
  new CacheFirst({
    cacheName: DUCKDB_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 12 }),
    ],
  }),
);

/** Any other wasm payload the app pulls in lazily. */
registerRoute(
  ({ url }) => /\.wasm$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'wetlsp-engine-wasm',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 12 }),
    ],
  }),
);

/**
 * Basemap tiles, cached as the user browses. A site the scientist has already
 * looked at keeps its imagery offline; anything new falls back to the blank
 * basemap, which still places pixels correctly.
 */
registerRoute(
  ({ url }) =>
    /(^|\.)openfreemap\.org$/.test(url.hostname) ||
    /(^|\.)arcgisonline\.com$/.test(url.hostname) ||
    /(^|\.)openstreetmap\.org$/.test(url.hostname),
  new CacheFirst({
    cacheName: 'wetlsp-basemap-tiles',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);
