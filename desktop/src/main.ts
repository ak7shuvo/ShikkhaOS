import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppConfig } from './app-config.js';
import { SessionJar, createApiHandler, type FetchLike } from './api-proxy.js';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, CONTENT_SECURITY_POLICY, isAppUrl, isTrustedSender, webPreferences } from './security.js';
import { mimeFor, resolveStaticPath } from './static-files.js';

/**
 * Main process: the only code with Node.js/Electron privileges. It serves the unchanged web build from app://shikkha, forwards
 * /api/* to the configured API through a cookie jar the renderer cannot read, and exposes one read-only IPC call.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const webRoot = path.join(appRoot, 'build', 'web');
const config = parseAppConfig(JSON.parse(readFileSync(path.join(appRoot, 'build', 'app-config.json'), 'utf8')));

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

const baseHeaders = { 'x-content-type-options': 'nosniff', 'content-security-policy': CONTENT_SECURITY_POLICY };
const notFound = () => new Response('Not found', { status: 404, headers: { ...baseHeaders, 'content-type': 'text/plain' } });

async function serveStatic(pathname: string): Promise<Response> {
  const r = resolveStaticPath(webRoot, pathname);
  if (!r) return notFound();
  try {
    const body = await fs.readFile(r.file);
    return new Response(body, { status: 200, headers: { ...baseHeaders, 'content-type': mimeFor(r.file), 'cache-control': 'no-cache' } });
  } catch {
    return notFound();
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: config.display_name,
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(path.join(appRoot, 'preload.cjs'), app.isPackaged),
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(`${APP_ORIGIN}/`);
  return win;
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault(); // the window never leaves the bundled UI
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

void app.whenReady().then(() => {
  const jar = new SessionJar();
  const api = createApiHandler({
    apiOrigin: config.api_base_url,
    jar,
    userAgent: `ShikkhaOS-Desktop/${app.getVersion()}`,
    fetchImpl: ((url, init) => net.fetch(url, init as RequestInit)) as FetchLike,
  });

  protocol.handle(APP_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.host !== APP_HOST) return notFound();
    if (u.pathname === '/api' || u.pathname.startsWith('/api/')) return api(req);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return serveStatic(u.pathname);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  ipcMain.handle('desktop:info', (event) => {
    if (!isTrustedSender(event.senderFrame?.url)) throw new Error('untrusted sender');
    return { version: app.getVersion(), platform: process.platform, school_slug: config.slug, display_name: config.display_name };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});
app.on('window-all-closed', () => app.quit());
