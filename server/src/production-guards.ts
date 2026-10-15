import fs from 'node:fs';
import net from 'node:net';

/**
 * Production start-up guards (docs/security/PHASE3_SECURITY_REVIEW.md: M-1 TRUST_PROXY, H-4 database TLS).
 * Pure functions returning human-readable, non-sensitive problems: they never echo connection strings, passwords or key material.
 */

/** TRUST_PROXY value meaning "no reverse proxy: the API is reached directly, take the client address from the TCP peer". */
export const TRUST_PROXY_NONE = 'none';

const MAX_PROXY_HOPS = 10;
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function validCidrOrIp(token: string): boolean {
  const [addr, prefix, extra] = token.split('/');
  if (extra !== undefined || !addr) return false;
  const family = net.isIP(addr);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  // /0 would trust every client address, which lets anybody forge X-Forwarded-For.
  return n >= 1 && n <= (family === 4 ? 32 : 128);
}

/** Problems with TRUST_PROXY in production (empty list = acceptable). */
export function trustProxyProblems(raw: string): string[] {
  const t = raw.trim();
  if (t === '')
    return [
      `TRUST_PROXY must be set explicitly in production: a proxy hop count (1-${MAX_PROXY_HOPS}), a comma-separated list of proxy IPs/CIDRs, or "${TRUST_PROXY_NONE}" when no reverse proxy is used`,
    ];
  if (t.toLowerCase() === TRUST_PROXY_NONE) return [];
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= MAX_PROXY_HOPS ? [] : [`TRUST_PROXY hop count must be between 1 and ${MAX_PROXY_HOPS} (use "${TRUST_PROXY_NONE}" for no proxy)`];
  }
  const tokens = t.split(',').map((x) => x.trim());
  if (tokens.some((x) => x === '')) return ['TRUST_PROXY contains an empty list entry'];
  const bad = tokens.filter((x) => !PROXY_KEYWORDS.has(x) && !validCidrOrIp(x));
  return bad.length
    ? [
        `TRUST_PROXY must be a hop count, "${TRUST_PROXY_NONE}", or a list of valid proxy IPs/CIDRs (no wildcards, no /0, no "true"); ${bad.length} invalid entr${bad.length === 1 ? 'y' : 'ies'}`,
      ]
    : [];
}

/** Connection-string parameters that node-postgres lets override (and thereby drop) the pool's verified-TLS options. */
const TLS_URL_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'sslpassword', 'uselibpqcompat'];

/**
 * In node-postgres a `sslmode`/`ssl` query parameter replaces the pool's `ssl` option: `sslmode=disable` means plaintext,
 * `no-verify` disables verification and every other value discards the configured CA. Runtime pool URLs must therefore carry
 * none of them; TLS is configured through CONTROL_DB_SSL / SCHOOL_DB_SSL / DB_SSL_CA_FILE only.
 */
export function runtimeUrlTlsParamProblems(name: string, url: string | undefined): string[] {
  if (!url) return [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [`${name} is not a valid URL`];
  }
  const found = TLS_URL_PARAMS.filter((p) => u.searchParams.has(p));
  return found.length
    ? [`${name} must not contain TLS parameters (${found.join(', ')}); configure CONTROL_DB_SSL / SCHOOL_DB_SSL and DB_SSL_CA_FILE instead`]
    : [];
}

export interface ProductionDbEnv {
  CONTROL_DB_SSL: boolean;
  SCHOOL_DB_SSL: boolean;
  DB_SSL_CA_FILE?: string;
  CONTROL_DATABASE_URL: string;
  SHARED_DATABASE_URL?: string;
}

/** Every database TLS problem for the API's runtime pools (control, optional shared, per-school). */
export function productionDbTlsProblems(c: ProductionDbEnv): string[] {
  const out: string[] = [];
  if (!c.CONTROL_DB_SSL) out.push('CONTROL_DB_SSL must be true in production (control-plane and shared database pools)');
  if (!c.SCHOOL_DB_SSL) out.push('SCHOOL_DB_SSL must be true in production (school database pools)');
  out.push(...runtimeUrlTlsParamProblems('CONTROL_DATABASE_URL', c.CONTROL_DATABASE_URL));
  out.push(...runtimeUrlTlsParamProblems('SHARED_DATABASE_URL', c.SHARED_DATABASE_URL));
  if (c.DB_SSL_CA_FILE) {
    try {
      if (!fs.statSync(c.DB_SSL_CA_FILE).isFile()) out.push('DB_SSL_CA_FILE must point to a file');
      else fs.accessSync(c.DB_SSL_CA_FILE, fs.constants.R_OK);
    } catch {
      out.push('DB_SSL_CA_FILE is not a readable file');
    }
  }
  return out;
}

/**
 * Operator tools (petra CLI, migrate/setup scripts) open plain node-postgres clients from the privileged URLs, whose TLS is decided
 * by the URL alone. In production that URL must demand verified TLS explicitly (`sslmode=verify-full`; node-postgres treats the
 * weaker-sounding modes as aliases today but libpq and future versions do not). A private CA is trusted via NODE_EXTRA_CA_CERTS.
 */
export function operatorUrlProblems(env: NodeJS.ProcessEnv, names: string[]): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  for (const name of names) {
    const url = env[name];
    if (!url) continue;
    let mode: string | null;
    try {
      mode = new URL(url).searchParams.get('sslmode');
    } catch {
      out.push(`${name} is not a valid URL`);
      continue;
    }
    if (mode !== 'verify-full') out.push(`${name} must include sslmode=verify-full in production`);
  }
  return out;
}

export const OPERATOR_URL_NAMES = ['PROVISIONER_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'CONTROL_MIGRATION_DATABASE_URL'];

/** Throws a non-sensitive error (names only) when an operator URL would allow plaintext or unverified TLS in production. */
export function assertOperatorUrls(env: NodeJS.ProcessEnv = process.env, names: string[] = OPERATOR_URL_NAMES): void {
  const p = operatorUrlProblems(env, names);
  if (p.length) throw new Error(`Invalid production configuration: ${p.join('; ')}`);
}
