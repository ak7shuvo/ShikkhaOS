/**
 * Non-secret, build-time configuration of one school-branded desktop build (written by scripts/build.mjs from the output of
 * `petra build-profile`). It contains no credentials: the application authenticates through the normal login API.
 */
export interface AppConfig {
  format: 1;
  /** School slug the build is locked to (the login form hides the school field), or null for a generic build. */
  slug: string | null;
  display_name: string;
  /** Origin of the ShikkhaOS API this build talks to, e.g. https://api.example.test */
  api_base_url: string;
  /** TEST BUILDS ONLY: permits plain http to a loopback API (disposable E2E). Rejected by the build script for release builds. */
  allow_insecure_loopback: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** Validates an untrusted parsed JSON document and returns the typed config, or throws a non-sensitive Error. */
export function parseAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') throw new Error('app-config: not an object');
  const r = raw as Record<string, unknown>;
  if (r.format !== 1) throw new Error('app-config: unsupported format');
  const slug = r.slug === null || r.slug === undefined ? null : r.slug;
  if (slug !== null && (typeof slug !== 'string' || !SLUG_RE.test(slug))) throw new Error('app-config: invalid slug');
  if (typeof r.display_name !== 'string' || r.display_name.trim().length < 2 || r.display_name.length > 80) throw new Error('app-config: invalid display_name');
  if (typeof r.api_base_url !== 'string') throw new Error('app-config: invalid api_base_url');
  const allowInsecure = r.allow_insecure_loopback === true;
  let u: URL;
  try {
    u = new URL(r.api_base_url);
  } catch {
    throw new Error('app-config: invalid api_base_url');
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    throw new Error('app-config: api_base_url must be a bare origin');
  if (u.protocol !== 'https:') {
    if (!(allowInsecure && u.protocol === 'http:' && isLoopbackHost(u.hostname)))
      throw new Error('app-config: api_base_url must be https:// (http only for loopback test builds)');
  }
  return { format: 1, slug, display_name: r.display_name.trim(), api_base_url: u.origin, allow_insecure_loopback: allowInsecure };
}
