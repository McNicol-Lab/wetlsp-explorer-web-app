import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import { startServer, ORIGIN } from './server.mjs';

app.setName('WetLSP Explorer');
// Stable across versions and architectures. Keep desktop data separate from
// browser installs, and smoke tests separate from real users' data.
app.setPath('userData', join(app.getPath('appData'), 'WetLSP Explorer'));
const smoke = process.argv.includes('--smoke-test');
if (smoke) app.setPath('userData', process.env.WETLSP_SMOKE_PROFILE);
const locked = app.requestSingleInstanceLock();
let window;
let server;
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show(); window?.focus();
  });
  app.whenReady().then(async () => {
    server = await startServer(join(app.getAppPath(), 'dist'));
    // Scientific analysis needs no camera, microphone, location or notifications.
    // Figures may be written to the clipboard (Copy button); reading it is not allowed.
    const allowed = ['persistent-storage', 'fileSystem', 'clipboard-sanitized-write'];
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(Boolean(contents?.getURL().startsWith(ORIGIN + '/') && allowed.includes(permission)));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) =>
      Boolean(contents?.getURL().startsWith(ORIGIN + '/') && allowed.includes(permission)));
    if (smoke) {
      // Prove the packaged app starts with no external network, including a
      // fresh profile with no cached shell or WASM.
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(ORIGIN + '/') });
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      { label: 'Help', submenu: [{ label: 'Downloads and setup', click: () => shell.openExternal('https://github.com/McNicol-Lab/wetlsp-explorer-web-app/releases/latest') }] },
    ]));
    await createWindow();
    if (smoke) {
      const { runSmoke } = await import('./smoke.mjs');
      await runSmoke(window);
      app.exit(0);
    }
  }).catch((error) => {
    console.error(error);
    if (!smoke) dialog.showErrorBox('WetLSP Explorer could not start',
      error.code === 'EADDRINUSE'
        ? 'Another program is using local port 47831. Close that program and reopen WetLSP Explorer. Your saved data is unchanged.'
        : error.message);
    app.exit(1);
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 950, minWidth: 1000, minHeight: 650,
    title: 'WetLSP Explorer', backgroundColor: '#f7f8fa',
    show: !smoke, icon: join(app.getAppPath(), 'dist/icons/icon-512.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // External content never replaces the trusted, local application.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/')) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => { window = undefined; });
  await window.loadURL(ORIGIN);
}
app.on('activate', () => { if (!window && server) void createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => server?.close());
