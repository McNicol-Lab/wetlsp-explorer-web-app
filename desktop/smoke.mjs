import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
// Executed inside the real packaged Electron runtime by CI on both OSes.
export async function runSmoke(window) {
  const assets = await readdir(join(app.getAppPath(), 'dist/assets'));
  const netcdfWorker = assets.find(name => name.startsWith('netcdf.worker-') && name.endsWith('.js'));
  if (!netcdfWorker) throw new Error('NetCDF worker missing');
  const phenoclassWorker = assets.find(name => name.startsWith('phenoclass.worker-') && name.endsWith('.js'));
  if (!phenoclassWorker) throw new Error('Phenology classifier worker missing');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 20000;
    while (!document.querySelector('button')) {
      if (Date.now() > deadline) throw new Error('React did not render');
      await new Promise(r => setTimeout(r, 100));
    }
    if (typeof window.require !== 'undefined') throw new Error('Node exposed to renderer');
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('desktop-smoke.txt', {create: true});
    const previous = await (await file.getFile()).text();
    const writer = await file.createWritable(); await writer.write('persistent'); await writer.close();
    const catalog = await (await fetch('/catalog/wetlsp_site_catalog.csv')).text();
    if (catalog.trim().split('\\n').length < 96) throw new Error('Bundled catalog missing');
    const html = await (await fetch('/')).text();
    const scripts = [...html.matchAll(/(?:src|href)="([^" ]+\\.js)"/g)].map(m => m[1]);
    const duckdbUrl = scripts.find(s => s.includes('/duckdb-'));
    if (!duckdbUrl) throw new Error('DuckDB module missing from build');
    const module = await import(duckdbUrl);
    // Vite's minified exports are not a public API; discover the class by its
    // method shape rather than depending on a particular mangled export name.
    const DB = Object.values(module).find(v => typeof v === 'function' && v.prototype?.instantiate && v.prototype?.connect);
    if (!DB) throw new Error('DuckDB class missing');
    const worker = new Worker('/duckdb/duckdb-browser-eh.worker.js');
    const db = new DB({ log() {} }, worker);
    await db.instantiate('/duckdb/duckdb-eh.wasm');
    const conn = await db.connect();
    const rows = (await conn.query('SELECT 42 AS answer')).toArray();
    if (Number(rows[0].answer) !== 42) throw new Error('WASM query failed');
    await conn.close(); await db.terminate(); worker.terminate();
    const sites = await root.getDirectoryHandle('sites', {create: true});
    const site = await sites.getDirectoryHandle('smoke', {create: true});
    const nc = await site.getFileHandle('invalid.nc', {create: true});
    const out = await nc.createWritable(); await out.write('not-hdf5'); await out.close();
    const h5worker = new Worker('/assets/' + ${JSON.stringify(netcdfWorker)}, {type: 'module'});
    await new Promise((resolve, reject) => {
      h5worker.onerror = e => reject(new Error(e.message));
      h5worker.onmessage = ({data}) => {
        if ('progress' in data) return;
        // This error happens AFTER h5wasm.ready and OPFS reading, proving the
        // bundled HDF5 runtime can start offline without shipping a fixture.
        if (!data.ok && data.error.includes('not a NetCDF-4/HDF5 file')) resolve();
        else reject(new Error('Unexpected NetCDF result: ' + JSON.stringify(data)));
      };
      h5worker.postMessage({id: 1, method: 'info', args: ['smoke', 'invalid.nc', 2021]});
    });
    h5worker.terminate();
    const classWorker = new Worker('/assets/' + ${JSON.stringify(phenoclassWorker)}, {type: 'module'});
    await new Promise((resolve, reject) => {
      classWorker.onerror = e => reject(new Error(e.message));
      classWorker.onmessage = ({data}) => {
        if ('progress' in data) return;
        const year = data.result?.years?.[0];
        if (data.ok && year?.ok === false && year.problems.some(p => p.includes('Not a NetCDF-4 (HDF5) file'))) resolve();
        else reject(new Error('Unexpected classifier inspection: ' + JSON.stringify(data)));
      };
      classWorker.postMessage({id: 1, method: 'inspect', args: ['smoke', [{year: 2021, path: 'invalid.nc', size: 8, importedAt: 0}]]});
    });
    classWorker.terminate();
    return { netcdfRuntime: true, phenoclassRuntime: true, rendered: true, sandboxed: true, catalog: true, duckdb: true, opfsPrevious: previous };
  })()`);
  if (process.env.WETLSP_SMOKE_EXPECT_PERSISTED === '1' && result.opfsPrevious !== 'persistent') {
    throw new Error('OPFS did not persist across process relaunch');
  }
  console.log('DESKTOP_SMOKE ' + JSON.stringify(result));
}
