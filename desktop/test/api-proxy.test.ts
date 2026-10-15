import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionJar, createApiHandler, normaliseApiPath, type FetchLike } from '../src/api-proxy.js';

describe('normaliseApiPath', () => {
  it('forwards only /api/... paths', () => {
    expect(normaliseApiPath('/api/auth/login')).toBe('/api/auth/login');
    expect(normaliseApiPath('/api/classes/123')).toBe('/api/classes/123');
    for (const p of ['/', '/index.html', '/assets/x.js', '/apis/x', '/api', '/foo/api/x']) expect(normaliseApiPath(p), p).toBeNull();
  });

  it('never forwards the Petra platform-administration API, in any spelling', () => {
    for (const p of [
      '/api/platform',
      '/api/platform/auth/login',
      '/api/platform/schools',
      '/api/PLATFORM/schools',
      '/api/%70latform/schools',
      '/api/Platform/',
    ]) {
      expect(normaliseApiPath(p), p).toBeNull();
    }
  });

  it('rejects traversal, encoded separators, backslashes and control characters', () => {
    for (const p of [
      '/api/../x',
      '/api/%2e%2e/platform/schools',
      '/api/a/../../platform/x',
      '/api//platform/x',
      '/api/a%2F..%2Fplatform',
      '/api/a\\b',
      '/api/a%5Cb',
      '/api/a%00b',
      '/api/%zz',
      '/api/./x',
    ]) {
      expect(normaliseApiPath(p), p).toBeNull();
    }
  });
});

describe('SessionJar', () => {
  it('keeps only the school session cookie, supports expiry/clearing, never other cookies', () => {
    const j = new SessionJar();
    expect(j.header()).toBeUndefined();
    j.store(['other=1; Path=/', 'psid=zzz; Path=/api/platform']);
    expect(j.active).toBe(false);
    j.store(['sid=abc.def; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200']);
    expect(j.header()).toBe('sid=abc.def');
    j.store(['sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(j.active).toBe(false);
    j.store(['sid=again; Path=/']);
    expect(j.header()).toBe('sid=again');
    j.store(['sid=gone; Max-Age=0']);
    expect(j.header()).toBeUndefined();
    j.store(['sid=x; Path=/']);
    j.clear();
    expect(j.header()).toBeUndefined();
  });
});

describe('API handler against a local stand-in server (no real API, no database)', () => {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let server: http.Server;
  let origin = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/api/auth/login') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': ['sid=SESSION.TOKEN; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600'],
            'x-secret-header': 'leak',
          });
          res.end('{"ok":true}');
        } else if (req.url === '/api/auth/logout') {
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'] });
          res.end('{"ok":true}');
        } else if (req.url === '/api/redirect') {
          res.writeHead(302, { location: 'https://evil.example/' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'x-subscription-warning': 'RENEWAL_OVERDUE' });
          res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const fetchImpl: FetchLike = (url, init) => fetch(url, init as unknown as RequestInit);
  const make = () => {
    const jar = new SessionJar();
    return { jar, call: createApiHandler({ apiOrigin: origin, fetchImpl, jar, userAgent: 'ShikkhaOS-Desktop/test' }) };
  };
  const req = (path: string, init: RequestInit = {}) =>
    new Request(`app://shikkha${path}`, { headers: { origin: 'app://shikkha', cookie: 'sid=FORGED-BY-RENDERER', ...(init.headers as object) }, ...init });

  it('logs in, keeps the cookie only in the jar, and sends it on later requests', async () => {
    const { jar, call } = make();
    seen.length = 0;
    const login = await call(
      req('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"school":"s","email":"a@b.c","password":"x"}' }),
    );
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toBeNull(); // the renderer never receives the cookie
    expect(login.headers.get('x-secret-header')).toBeNull(); // only allow-listed response headers
    expect(jar.header()).toBe('sid=SESSION.TOKEN');
    expect(seen[0]!.headers.cookie).toBeUndefined(); // the renderer-supplied cookie header is dropped
    expect(seen[0]!.headers.origin).toBeUndefined(); // and so is its Origin
    expect(seen[0]!.headers['user-agent']).toBe('ShikkhaOS-Desktop/test');
    expect(seen[0]!.body).toContain('"school":"s"');

    const me = await call(req('/api/auth/me'));
    expect(await me.json()).toEqual({ cookie: 'sid=SESSION.TOKEN' });
    expect(me.headers.get('x-subscription-warning')).toBe('RENEWAL_OVERDUE');
    expect(me.headers.get('cache-control')).toBe('no-store');
  });

  it('logout clears the jar and later requests carry no session', async () => {
    const { jar, call } = make();
    await call(req('/api/auth/login', { method: 'POST', body: '{}' }));
    expect(jar.active).toBe(true);
    await call(req('/api/auth/logout', { method: 'POST', body: '{}' }));
    expect(jar.active).toBe(false);
    expect(await (await call(req('/api/auth/me'))).json()).toEqual({ cookie: null });
  });

  it('blocks platform administration and non-API paths without contacting the server', async () => {
    const { call } = make();
    seen.length = 0;
    for (const p of ['/api/platform/auth/login', '/api/platform/schools', '/api/%70latform/schools', '/api/../x']) {
      const r = await call(req(p, { method: p.includes('login') ? 'POST' : 'GET', body: p.includes('login') ? '{}' : undefined }));
      expect(r.status, p).toBe(403);
      expect((await r.json()).error.code).toBe('DESKTOP_PATH_BLOCKED');
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses unsupported methods, oversized bodies, redirects and unreachable upstreams', async () => {
    const { call } = make();
    expect((await call(req('/api/auth/me', { method: 'DELETE' }))).status).toBe(405);
    expect((await call(req('/api/x', { method: 'POST', body: new Uint8Array(1_000_001) }))).status).toBe(413);
    expect((await call(req('/api/redirect'))).status).toBe(502); // a redirect can never send the session to another origin
    const dead = createApiHandler({ apiOrigin: 'http://127.0.0.1:1', fetchImpl, jar: new SessionJar(), userAgent: 'x', timeoutMs: 2000 });
    const r = await dead(req('/api/auth/me'));
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain('127.0.0.1'); // no connection details back to the page
  });

  it('can only ever reach the configured origin, whatever URL the page builds', async () => {
    const { call } = make();
    seen.length = 0;
    await call(new Request('app://shikkha/api/auth/me?next=https://evil.example/'));
    expect(seen[0]!.url).toBe('/api/auth/me?next=https://evil.example/');
  });
});
