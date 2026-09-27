import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export const PORT = 47831;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.csv': 'text/csv', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

/**
 * The one place sample-site downloads may come from: the lab's public release
 * (spline-only daily EVI and annual phenometrics). The dev server imports
 * this too, and scripts/publish-samples.mjs refuses to publish anywhere else.
 */
export const SAMPLE_RELEASE = 'https://github.com/McNicol-Lab/wetlsp-sample-data/releases/download/v2/';
const SAMPLE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * GitHub release files carry no CORS headers, so the page cannot fetch them
 * itself. This streams one named asset of the fixed sample release through
 * to the page, which writes it straight into offline storage. Nothing is
 * stored here, and no other host or path can be reached.
 */
async function proxySample(asset, req, res, releaseBase) {
  if (!SAMPLE_ASSET.test(asset)) { res.writeHead(403).end(); return; }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(releaseBase + asset, { redirect: 'follow', signal: abort.signal });
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('offline'); return;
  }
  if (!upstream.ok || !upstream.body) {
    res.writeHead(upstream.status === 404 ? 404 : 502).end(); return;
  }
  const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); abort.abort(); return; }
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

// Only the bundled web files are exposed, on loopback, plus read-only
// downloads of the fixed sample release under /remote-samples/. No filesystem
// API or writable endpoint. A fixed origin preserves IndexedDB / OPFS across
// releases.
export async function startServer(root, port = PORT, { releaseBase = SAMPLE_RELEASE } = {}) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(403).end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
      if (pathname.startsWith('/remote-samples/')) {
        await proxySample(pathname.slice('/remote-samples/'.length), req, res, releaseBase);
        return;
      }
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const info = await stat(path);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "frame-ancestors 'none'",
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(path).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
