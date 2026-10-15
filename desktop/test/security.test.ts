import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, IPC_CHANNELS, isAppUrl, isTrustedSender, webPreferences } from '../src/security.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('renderer hardening', () => {
  it('isolates the renderer from Node.js and enables the sandbox', () => {
    for (const packaged of [true, false]) {
      const p = webPreferences('/x/preload.cjs', packaged);
      expect(p).toMatchObject({
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      });
    }
    expect(webPreferences('/x', true).devTools).toBe(false);
    expect(webPreferences('/x', false).devTools).toBe(true);
  });

  it('uses a restrictive Content-Security-Policy', () => {
    const csp = CONTENT_SECURITY_POLICY;
    for (const d of [
      "default-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(csp).toContain(d);
    expect(csp).not.toMatch(/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*)/);
    expect(csp).not.toMatch(/connect-src[^;]*(https?:|\*)/);
  });

  it('trusts only the app origin for navigation and IPC', () => {
    expect(isAppUrl(`${APP_ORIGIN}/students`)).toBe(true);
    for (const u of [
      'https://evil.example/',
      'http://shikkha/',
      'app://other/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      'app://shikkha.evil.example/',
    ])
      expect(isAppUrl(u), u).toBe(false);
    expect(isTrustedSender(`${APP_ORIGIN}/`)).toBe(true);
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender('https://evil.example/')).toBe(false);
  });
});

describe('IPC surface (static checks of the shipped sources)', () => {
  it('exposes exactly one allow-listed read-only channel in the preload script', () => {
    expect(IPC_CHANNELS).toEqual(['desktop:info']);
    const preload = read('preload.cjs');
    expect(preload).toMatch(/ALLOWED_CHANNELS = new Set\(\['desktop:info'\]\)/);
    expect(preload.match(/ipcRenderer\.\w+/g)).toEqual(['ipcRenderer.invoke']); // no send/on/sendSync, no raw ipcRenderer exposed
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld\('shikkhaDesktop', Object\.freeze\(\{ info: /);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\)/);
  });

  it('registers one IPC handler and verifies the sender frame; no shell/remote/openExternal, no eval, no file:// loading', () => {
    const main = read('src/main.ts');
    expect(main.match(/ipcMain\.handle\(/g)).toHaveLength(1);
    expect(main).toContain('isTrustedSender(event.senderFrame?.url)');
    expect(main).not.toMatch(
      /openExternal|shell\.|enableRemoteModule|@electron\/remote|nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|\beval\(|new Function\(/,
    );
    expect(main).not.toMatch(/loadFile\(|loadURL\(`file:|loadURL\('file:/);
    expect(main).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(main).toContain('event.preventDefault(); // the window never leaves the bundled UI');
    expect(main).toContain('setPermissionRequestHandler((_wc, _permission, callback) => callback(false))');
  });

  it('contains no credentials or privileged settings anywhere in the desktop sources', () => {
    const all = ['src/main.ts', 'src/api-proxy.ts', 'src/app-config.ts', 'src/security.ts', 'src/static-files.ts', 'preload.cjs', 'scripts/build.mjs']
      .map(read)
      .join('\n');
    expect(all).not.toMatch(/PETRA_MASTER_KEY|PROVISIONER_DATABASE_URL|CONTROL_DATABASE_URL|SHARED_DATABASE_URL|MIGRATION_DATABASE_URL|postgres(ql)?:\/\//i);
    expect(all).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
