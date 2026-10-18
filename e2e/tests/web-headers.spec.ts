import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// M-3: the static host must send the headers in deploy/web-security-headers.json. This test serves the REAL production build
// (web/dist) with exactly those headers and proves (1) the app still renders and boots under the policy, (2) no CSP violation
// occurs, (3) framing is refused, and (4) the nginx example carries every header value.
const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'web/dist');
const headers: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'deploy/web-security-headers.json'), 'utf8'));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (p.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"code":"NO_API"}}'); // the app only needs to boot
      return;
    }
    let file = path.join(dist, path.normalize(p));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', ...headers });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

test('built web app boots under the production security headers; framing is refused', async ({ page, context }) => {
  expect(fs.existsSync(path.join(dist, 'index.html')), 'run `npm run build` first').toBe(true);
  const host = await serve();
  try {
    await context.addInitScript(() => localStorage.setItem('lang', 'en'));
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (m: string) => violations.push(m));
    await page.addInitScript(() =>
      document.addEventListener(
        'securitypolicyviolation',
        (e) => void (window as unknown as { reportViolation: (m: string) => void }).reportViolation(`${e.violatedDirective} ${e.blockedURI}`),
      ),
    );
    const resp = await page.goto(host.url + '/');
    for (const [k, v] of Object.entries(headers)) expect(resp!.headers()[k.toLowerCase()], k).toBe(v);
    await expect(page.getByLabel(/School ID/), 'login form must render under the CSP').toBeVisible();
    expect(violations, 'no CSP violations while booting').toEqual([]);

    // Framing: another origin embedding the app must be refused by frame-ancestors 'none'.
    const framer = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<iframe id="f" src="${host.url}/"></iframe>`));
    await new Promise<void>((r) => framer.listen(0, '127.0.0.1', () => r()));
    try {
      const other = await context.newPage();
      await other.goto(`http://127.0.0.1:${(framer.address() as { port: number }).port}/`);
      await other.waitForTimeout(1500);
      const framed = other.frames().find((f) => f !== other.mainFrame());
      const rendered = framed
        ? await framed
            .locator('label', { hasText: /School ID/ })
            .count()
            .catch(() => 0)
        : 0;
      expect(rendered, 'the app must not render inside a foreign frame').toBe(0);
    } finally {
      await new Promise((r) => framer.close(r));
    }
  } finally {
    await host.close();
  }

  const nginx = fs.readFileSync(path.join(root, 'deploy/nginx-web.conf.example'), 'utf8');
  for (const [k, v] of Object.entries(headers)) expect(nginx, `nginx example must carry ${k}`).toContain(`add_header ${k} "${v}" always;`);
});
