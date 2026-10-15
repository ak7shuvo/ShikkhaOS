/**
 * The only path from the renderer to the ShikkhaOS API.
 *
 * The packaged web UI is served from app://shikkha and calls the unchanged relative `/api/...` contract. The main process forwards
 * those calls to the configured API origin and keeps the session cookie in memory: the renderer never sees the cookie or the
 * token, a different origin cannot be addressed, and Petra platform-administration routes are not reachable from this client.
 */
export const API_PREFIX = '/api/';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'accept-language'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'x-subscription-warning'];
const MAX_BODY_BYTES = 1_000_000;
const SESSION_COOKIE = 'sid';

const hasUnsafeChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20 || s[i] === '\\') return true; // control characters and backslashes
  return false;
};

/** Normalised API path, or null when the path must not be forwarded. Blocks traversal tricks and platform administration. */
export function normaliseApiPath(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) return null;
  if (hasUnsafeChar(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (hasUnsafeChar(decoded)) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;
  if (decoded.includes('//')) return null;
  const lower = decoded.toLowerCase();
  if (lower === '/api/platform' || lower.startsWith('/api/platform/')) return null; // Petra staff API: never from the school client
  return pathname;
}

/** Holds the school session cookie in memory (never persisted, never exposed to the renderer). */
export class SessionJar {
  private value: string | null = null;

  /** Applies Set-Cookie headers from an API response; only the school session cookie is ever kept. */
  store(setCookies: string[]): void {
    for (const line of setCookies) {
      const parts = line.split(';').map((p) => p.trim());
      const [nameValue, ...attrs] = parts;
      const eq = nameValue?.indexOf('=') ?? -1;
      if (!nameValue || eq < 1 || nameValue.slice(0, eq) !== SESSION_COOKIE) continue;
      const value = nameValue.slice(eq + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
      const expires = attrs.find((a) => a.toLowerCase().startsWith('expires='));
      const expired =
        value === '' || (maxAge !== undefined && Number(maxAge.slice(8)) <= 0) || (expires !== undefined && Date.parse(expires.slice(8)) <= Date.now());
      this.value = expired ? null : value;
    }
  }

  header(): string | undefined {
    return this.value ? `${SESSION_COOKIE}=${this.value}` : undefined;
  }

  get active(): boolean {
    return this.value !== null;
  }

  clear(): void {
    this.value = null;
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array; redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

export interface ApiHandlerOptions {
  /** Validated API origin (see parseAppConfig). */
  apiOrigin: string;
  fetchImpl: FetchLike;
  jar: SessionJar;
  userAgent: string;
  timeoutMs?: number;
}

const deny = (status: number, code: string): Response =>
  new Response(JSON.stringify({ error: { code, message: 'Request not allowed by the desktop client' } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Returns a handler for requests made by the renderer to app://shikkha/api/... */
export function createApiHandler(o: ApiHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const path = normaliseApiPath(url.pathname);
    if (!path) return deny(403, 'DESKTOP_PATH_BLOCKED');
    if (!ALLOWED_METHODS.has(req.method)) return deny(405, 'DESKTOP_METHOD_BLOCKED');

    const headers: Record<string, string> = { 'user-agent': o.userAgent };
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const cookie = o.jar.header();
    if (cookie) headers.cookie = cookie;

    let body: Uint8Array | undefined;
    if (req.method !== 'GET') {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength > MAX_BODY_BYTES) return deny(413, 'DESKTOP_BODY_TOO_LARGE');
      body = buf;
    }

    let upstream: Response;
    try {
      upstream = await o.fetchImpl(`${o.apiOrigin}${path}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: 'manual', // an API redirect must never move the session to another origin
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch {
      return deny(502, 'DESKTOP_API_UNREACHABLE');
    }

    o.jar.store(upstream.headers.getSetCookie());
    const out = new Headers({ 'cache-control': 'no-store' });
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    const payload = upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer();
    return new Response(payload, { status: upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status, headers: out });
  };
}
