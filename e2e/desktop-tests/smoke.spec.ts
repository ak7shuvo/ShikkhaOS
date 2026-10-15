import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

const school = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../.state/school.json'), 'utf8')) as {
  slug: string;
  email: string;
  password: string;
};
const repo = path.resolve(import.meta.dirname, '../..');
// Default: the development launch (electron + compiled main). DESKTOP_EXECUTABLE points at the packaged Linux binary instead.
const executable = process.env.DESKTOP_EXECUTABLE ?? path.join(repo, 'node_modules/electron/dist/electron');
const appArgs = process.env.DESKTOP_EXECUTABLE ? [] : [path.join(repo, 'desktop/dist/main.js')];
// Negative control: a logout that never reaches the API (the page's request is dropped).
const BROKEN_LOGOUT = process.env.E2E_SIMULATE_BROKEN_LOGOUT === '1';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

let child: ChildProcess | undefined;
let userData = '';
let stderrTail = '';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructured first parameter
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.error(`desktop app stderr tail:\n${stderrTail.slice(-1500)}`); // Electron diagnostics only; the app never prints credentials
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (userData) fs.rmSync(userData, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  const port = await freePort();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shikkha-desktop-'));
  // --no-sandbox only because CI/containers run as root or without user namespaces; this is the test harness, not the app config.
  child = spawn(executable, [...appArgs, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    cwd: path.join(repo, 'desktop'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  });
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += d;
    stderrTail = stderr.slice(-4000);
  });
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`desktop app exited early (code ${child.exitCode}); stderr tail: ${stderr.slice(-400)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('desktop app did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  for (let i = 0; i < 100; i++) {
    const page = context.pages().find((p) => p.url().startsWith('app://shikkha'));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no app:// window appeared');
}

const api = (page: Page, p: string, init?: { method?: string; body?: string }) =>
  page.evaluate(
    async ([url, i]) => {
      try {
        const r = await fetch(url as string, {
          method: (i as { method?: string })?.method ?? 'GET',
          headers: { 'content-type': 'application/json' },
          body: (i as { body?: string })?.body,
        });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: String(e) };
      }
    },
    [p, init ?? null] as const,
  );

test('desktop shell: branded launch → login → logout, with isolation checks', async () => {
  const page = await launch();
  // The UI defaults to Bengali; the test selects English the same way a user would (the persisted language preference).
  await page.evaluate(() => localStorage.setItem('lang', 'en'));
  await page.reload();

  // Branded build: the school is fixed (no school field) and the name is the school's, not hard-coded in the shared code.
  await expect(page.getByRole('heading', { name: new RegExp(`E2E School ${school.slug}`) })).toBeVisible();
  await expect(page.getByLabel(/School ID/)).toHaveCount(0);

  // Renderer isolation.
  const isolation = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    cookie: document.cookie,
    bridge: Object.keys((window as unknown as { shikkhaDesktop?: object }).shikkhaDesktop ?? {}),
  }));
  expect(isolation).toEqual({ require: 'undefined', process: 'undefined', cookie: '', bridge: ['info'] });
  const info = await page.evaluate(() => (window as unknown as { shikkhaDesktop: { info(): Promise<{ school_slug: string }> } }).shikkhaDesktop.info());
  expect(info.school_slug).toBe(school.slug);

  // The Petra platform API and foreign origins are unreachable from this client.
  expect((await api(page, '/api/platform/auth/me')).status).toBe(403);
  expect((await api(page, '/api/platform/auth/login', { method: 'POST', body: '{}' })).status).toBe(403);
  expect((await api(page, 'https://example.com/')).status).toBe(0); // blocked by the CSP (connect-src 'self')
  expect((await api(page, '/api/auth/me')).status).toBe(401); // not signed in yet

  // Login through the unchanged UI and the unchanged API contract.
  await page.getByLabel('Email').fill(school.email);
  await page.getByLabel('Password').fill(school.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect((await api(page, '/api/auth/me')).status).toBe(200);
  expect(await page.evaluate(() => document.cookie)).toBe(''); // the session never reaches the page

  // Logout.
  if (BROKEN_LOGOUT) {
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, init) => (String(input).includes('/auth/logout') ? Promise.reject(new Error('dropped')) : original(input, init));
    });
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }), 'login form must be shown after logout').toBeVisible();
  expect.soft((await api(page, '/api/auth/me')).status, 'session must be rejected after logout').toBe(401);
});
