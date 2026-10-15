import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { createPool } from '../src/db.js';
import { pgEnv } from '../src/operations.js';
import { assertOperatorUrls, operatorUrlProblems, runtimeUrlTlsParamProblems } from '../src/production-guards.js';
import { generateMasterKey, loadMasterKeys, SecretBox } from '../src/secrets.js';
import { TenantRouter, type RegistryEntry } from '../src/tenancy.js';
import { runtimeDbTls, tlsOptions } from '../src/tls.js';

// Distinctive fake secrets: none of them may ever appear in an error message. Nothing here connects to a database.
const PASSWORD = 'Zx9-not-a-real-password-Qw7';
const MASTER_KEY = generateMasterKey();
/** The TLS settings node-postgres will really use for a connection (connection-string parameters already applied). */
const effectiveSsl = (c: pg.ClientConfig) => (new pg.Client(c) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'petra-guards-'));
const CA = path.join(tmp, 'ca.pem');
fs.writeFileSync(CA, '-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----\n');

const prod = (over: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    CONTROL_DATABASE_URL: `postgres://petra_control_app:${PASSWORD}@db.internal.example:5432/petra_control`,
    PETRA_MASTER_KEY: MASTER_KEY,
    ALLOWED_ORIGINS: 'https://app.example.test',
    TRUST_PROXY: '1',
    CONTROL_DB_SSL: 'true',
    SCHOOL_DB_SSL: 'true',
    ...over,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env as NodeJS.ProcessEnv;
};
const message = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadConfig to throw');
};

describe('production start-up: reverse-proxy trust (TRUST_PROXY)', () => {
  it('accepts every explicit, valid form', () => {
    for (const v of ['1', '3', '10', 'none', 'NONE', '10.0.0.0/8', '10.0.0.0/8, 192.168.1.5', '2001:db8::/32', '::1', 'loopback', 'uniquelocal, 203.0.113.7']) {
      expect(() => loadConfig(prod({ TRUST_PROXY: v })), v).not.toThrow();
    }
    expect(loadConfig(prod({ TRUST_PROXY: 'none' })).TRUST_PROXY).toBe(false);
    expect(loadConfig(prod({ TRUST_PROXY: '2' })).TRUST_PROXY).toBe(2);
  });

  it('refuses a missing or empty value instead of silently trusting the TCP peer', () => {
    expect(message(prod({ TRUST_PROXY: undefined }))).toMatch(/TRUST_PROXY must be set explicitly in production/);
    expect(message(prod({ TRUST_PROXY: '   ' }))).toMatch(/TRUST_PROXY must be set explicitly/);
  });

  it('refuses ambiguous or unsafe values', () => {
    for (const v of [
      '0',
      '11',
      '100',
      'true',
      'false',
      '*',
      'all',
      '0.0.0.0/0',
      '::/0',
      '10.0.0.0/33',
      '10.0.0.0/0',
      'example.com',
      '10.0.0.1,',
      ',10.0.0.1',
      '1,2',
      '10.0.0.1/8/8',
      '999.1.1.1',
    ]) {
      expect(message(prod({ TRUST_PROXY: v })), v).toMatch(/TRUST_PROXY/);
    }
  });
});

describe('production start-up: database TLS', () => {
  it('requires encrypted connections for the control/shared pools and for the school pools, independently', () => {
    expect(message(prod({ CONTROL_DB_SSL: undefined }))).toMatch(/CONTROL_DB_SSL must be true/);
    expect(message(prod({ CONTROL_DB_SSL: 'false' }))).toMatch(/CONTROL_DB_SSL must be true/);
    expect(message(prod({ SCHOOL_DB_SSL: undefined }))).toMatch(/SCHOOL_DB_SSL must be true/);
    expect(message(prod({ SCHOOL_DB_SSL: 'false' }))).toMatch(/SCHOOL_DB_SSL must be true/);
    const both = message(prod({ CONTROL_DB_SSL: 'false', SCHOOL_DB_SSL: 'false' }));
    expect(both).toMatch(/CONTROL_DB_SSL/);
    expect(both).toMatch(/SCHOOL_DB_SSL/);
  });

  it('refuses URL parameters that would override the verified-TLS pool options (plaintext / no-verify / dropped CA)', () => {
    for (const q of [
      'sslmode=disable',
      'sslmode=allow',
      'sslmode=prefer',
      'sslmode=require',
      'sslmode=verify-ca',
      'sslmode=verify-full',
      'sslmode=no-verify',
      'ssl=true',
      'sslrootcert=/x.pem',
      'uselibpqcompat=true',
    ]) {
      const control = `postgres://petra_control_app:${PASSWORD}@db.internal.example:5432/petra_control?${q}`;
      expect(message(prod({ CONTROL_DATABASE_URL: control })), q).toMatch(/CONTROL_DATABASE_URL must not contain TLS parameters/);
      const shared = `postgres://shikkha_app:${PASSWORD}@db.internal.example:5432/shikkha?${q}`;
      expect(message(prod({ SHARED_DATABASE_URL: shared })), q).toMatch(/SHARED_DATABASE_URL must not contain TLS parameters/);
    }
    expect(runtimeUrlTlsParamProblems('X', 'postgres://u:p@h/db?application_name=petra')).toEqual([]); // unrelated parameters are fine
  });

  it('validates the private CA file and accepts a readable one', () => {
    expect(message(prod({ DB_SSL_CA_FILE: path.join(tmp, 'missing.pem') }))).toMatch(/DB_SSL_CA_FILE is not a readable file/);
    expect(message(prod({ DB_SSL_CA_FILE: tmp }))).toMatch(/DB_SSL_CA_FILE must point to a file/);
    expect(() => loadConfig(prod({ DB_SSL_CA_FILE: CA }))).not.toThrow();
  });

  it('a fully valid production configuration (with and without shared DB / CA) is accepted', () => {
    expect(() => loadConfig(prod())).not.toThrow();
    expect(() =>
      loadConfig(prod({ SHARED_DATABASE_URL: `postgres://shikkha_app:${PASSWORD}@db.internal.example:5432/shikkha`, DB_SSL_CA_FILE: CA })),
    ).not.toThrow();
  });
});

describe('production start-up: error output is non-sensitive and complete', () => {
  it('reports every problem at once, naming settings only', () => {
    const msg = message(
      prod({
        TRUST_PROXY: undefined,
        CONTROL_DB_SSL: 'false',
        SCHOOL_DB_SSL: 'false',
        COOKIE_SECURE: 'false',
        ALLOWED_ORIGINS: 'http://app.example.test',
        CONTROL_DATABASE_URL: `postgres://petra_control_app:${PASSWORD}@db.internal.example:5432/petra_control?sslmode=disable`,
        SHARED_DATABASE_URL: `postgres://shikkha_app:${PASSWORD}@db.internal.example:5432/shikkha?sslmode=no-verify`,
        DB_SSL_CA_FILE: path.join(tmp, 'nope', 'secret-dir', 'ca.pem'),
      }),
    );
    for (const re of [
      /^Invalid production configuration:/,
      /COOKIE_SECURE/,
      /https/,
      /TRUST_PROXY/,
      /CONTROL_DB_SSL/,
      /SCHOOL_DB_SSL/,
      /CONTROL_DATABASE_URL/,
      /SHARED_DATABASE_URL/,
      /DB_SSL_CA_FILE/,
    ]) {
      expect(msg).toMatch(re);
    }
    for (const secret of [PASSWORD, MASTER_KEY, 'db.internal.example', 'petra_control_app', 'secret-dir']) expect(msg, secret).not.toContain(secret);
  });

  it('no failing scenario ever echoes a password, key or host name', () => {
    const scenarios = [
      prod({ TRUST_PROXY: 'bad value' }),
      prod({ CONTROL_DB_SSL: 'false' }),
      prod({ CONTROL_DATABASE_URL: `postgres://u:${PASSWORD}@db.internal.example/db?sslmode=require` }),
      prod({ DB_SSL_CA_FILE: path.join(tmp, 'x.pem') }),
    ];
    for (const env of scenarios) {
      const msg = message(env);
      for (const secret of [PASSWORD, MASTER_KEY, 'db.internal.example']) expect(msg).not.toContain(secret);
    }
    expect(() => tlsOptions(true, path.join(tmp, 'private-location', 'ca.pem'))).toThrow(
      /^Error: DB_SSL_CA_FILE is not a readable file$|DB_SSL_CA_FILE is not a readable file$/,
    );
    try {
      tlsOptions(true, path.join(tmp, 'private-location', 'ca.pem'));
    } catch (e) {
      expect((e as Error).message).not.toContain('private-location');
    }
  });
});

describe('development and test workflows keep working', () => {
  it('development and test need no TRUST_PROXY, no TLS and allow plain URLs and sslmode parameters', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const c = loadConfig({
        NODE_ENV,
        CONTROL_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db?sslmode=disable',
        PETRA_MASTER_KEY: MASTER_KEY,
      } as NodeJS.ProcessEnv);
      expect(c.CONTROL_DB_SSL).toBe(false);
      expect(c.SCHOOL_DB_SSL).toBe(false);
      expect(c.TRUST_PROXY).toBe(false);
      expect(runtimeDbTls(c)).toEqual({ control: false, school: false });
    }
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('none')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
  });

  it('operator URL checks and pg_* hardening apply only in production', () => {
    expect(
      operatorUrlProblems({ NODE_ENV: 'development', PROVISIONER_DATABASE_URL: 'postgres://u:p@h/db' } as NodeJS.ProcessEnv, ['PROVISIONER_DATABASE_URL']),
    ).toEqual([]);
    const dev = pgEnv('postgres://u:p@h:5432/db', { NODE_ENV: 'test', PGSSLMODE: 'prefer' } as NodeJS.ProcessEnv);
    expect(dev.env.PGSSLMODE).toBe('prefer');
  });
});

describe('every runtime pool verifies the server certificate and host name', () => {
  const prodCfg = () => loadConfig(prod({ DB_SSL_CA_FILE: CA }));
  const caText = fs.readFileSync(CA, 'utf8');

  it('runtimeDbTls gives the control/shared and school pools certificate AND host-name verification with the private CA', () => {
    const tls = runtimeDbTls(prodCfg());
    for (const t of [tls.control, tls.school]) {
      expect(t).toEqual({ rejectUnauthorized: true, ca: caText });
    }
    // The option can never be built in a weakened form.
    expect(Object.keys(tls.control as object).sort()).toEqual(['ca', 'rejectUnauthorized']);
  });

  it('the control-plane (and shared) pool created by createPool keeps verified TLS on the actual client connection parameters', async () => {
    const { control } = runtimeDbTls(prodCfg());
    for (const url of ['postgres://u:p@db.internal.example:5432/c', 'postgres://u:p@db.internal.example:5432/s']) {
      const pool = createPool(url, control);
      try {
        expect(effectiveSsl((pool as unknown as { options: pg.PoolConfig }).options)).toMatchObject({ rejectUnauthorized: true, ca: caText });
      } finally {
        await pool.end();
      }
    }
  });

  it('documents why URL parameters are refused: node-postgres lets them replace the verified options', () => {
    const verified = { rejectUnauthorized: true as const, ca: caText };
    const effective = (q: string) => effectiveSsl({ connectionString: `postgres://u:p@h.example/db${q}`, ssl: verified });
    expect(effective('')).toMatchObject({ rejectUnauthorized: true, ca: caText });
    expect(effective('?sslmode=disable')).toBe(false); // silent plaintext fallback
    expect(effective('?sslmode=no-verify')).toMatchObject({ rejectUnauthorized: false }); // no certificate check
    expect((effective('?sslmode=verify-full') as { ca?: string }).ca).toBeUndefined(); // private CA dropped
  });

  it('per-school pools created by the TenantRouter use the school TLS options', async () => {
    const { school } = runtimeDbTls(prodCfg());
    const secrets = new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: MASTER_KEY, PETRA_MASTER_KEY_ID: 'k1' }));
    const router = new TenantRouter({} as never, secrets, { maxPools: 1, poolMax: 1, cacheMs: 0, ssl: school });
    const entry = {
      id: 'e',
      db_host: 'db.internal.example',
      db_port: 5432,
      db_name: 'sk_aaaaaaaaaaaa',
      db_role: 'sk_aaaaaaaaaaaa_app',
    } as unknown as RegistryEntry;
    const pool = (router as unknown as { makePool(e: RegistryEntry, pw: string): pg.Pool }).makePool(entry, 'not-a-real-password');
    try {
      expect(effectiveSsl((pool as unknown as { options: pg.PoolConfig }).options)).toMatchObject({ rejectUnauthorized: true, ca: caText });
    } finally {
      await pool.end();
    }
  });

  it('buildApp wires the school TLS options from the production configuration into the router', async () => {
    const config = prodCfg();
    const control = createPool('postgres://u:p@127.0.0.1:1/none'); // never queried: no connection is made
    const app = await buildApp(config, control);
    try {
      expect((app.deps.router as unknown as { opts: { ssl: unknown } }).opts.ssl).toEqual({ rejectUnauthorized: true, ca: caText });
    } finally {
      await app.close();
      await control.end();
    }
  });

  it('no runtime source file builds a pool without TLS options (static guard for newly added pools)', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const files = fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const poolSites: string[] = [];
    for (const f of files) {
      const text = strip(fs.readFileSync(path.join(src, f), 'utf8'));
      for (const m of text.matchAll(/createPool\(([^)]*)\)/g)) {
        if (f === 'db.ts') continue; // the definition
        // Allowed: two arguments, the second being a TLS options variable.
        expect(/,\s*(dbTls|tls)\b/.test(m[1]!) || /,\s*(dbTls|tls)\.\w+/.test(m[1]!), `${f}: createPool(${m[1]}) must pass TLS options`).toBe(true);
        poolSites.push(f);
      }
      if (/new pg\.Pool\(/.test(text)) poolSites.push(`${f}:Pool`);
    }
    // The only direct `new pg.Pool` constructions are the shared factory (db.ts) and the tenant router, which spreads `ssl`.
    expect(poolSites.filter((s) => s.endsWith(':Pool')).sort()).toEqual(['db.ts:Pool', 'tenancy.ts:Pool']);
    expect(fs.readFileSync(path.join(src, 'tenancy.ts'), 'utf8')).toMatch(/\.\.\.\(this\.opts\.ssl \? \{ ssl: this\.opts\.ssl \} : \{\}\)/);
    expect(poolSites).toContain('index.ts');
    expect(poolSites).toContain('scripts/petra.ts');
  });
});

describe('operator tools in production (privileged URLs, pg_dump / pg_restore)', () => {
  const env = (over: Record<string, string>) => ({ NODE_ENV: 'production', ...over }) as NodeJS.ProcessEnv;

  it('require an explicit sslmode=verify-full and refuse everything weaker', () => {
    const ok = `postgres://op:${PASSWORD}@db.internal.example:5432/postgres?sslmode=verify-full`;
    expect(() => assertOperatorUrls(env({ PROVISIONER_DATABASE_URL: ok }))).not.toThrow();
    for (const q of ['', '?sslmode=disable', '?sslmode=require', '?sslmode=prefer', '?sslmode=verify-ca', '?sslmode=no-verify']) {
      const url = `postgres://op:${PASSWORD}@db.internal.example:5432/postgres${q}`;
      let msg = '';
      try {
        assertOperatorUrls(env({ PROVISIONER_DATABASE_URL: url, MIGRATION_DATABASE_URL: url }));
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, q).toMatch(/PROVISIONER_DATABASE_URL must include sslmode=verify-full in production/);
      expect(msg).toMatch(/MIGRATION_DATABASE_URL must include sslmode=verify-full/);
      for (const secret of [PASSWORD, 'db.internal.example']) expect(msg).not.toContain(secret);
    }
    expect(() => assertOperatorUrls(env({}))).not.toThrow(); // unset URLs are the caller's concern
  });

  it('pgEnv forces verify-full for pg_dump/pg_restore and passes the private CA, overriding a weaker inherited setting', () => {
    const r = pgEnv('postgres://op:pw@db.internal.example:5432/sk_aaaaaaaaaaaa', env({ PGSSLMODE: 'disable', DB_SSL_CA_FILE: CA }));
    expect(r.env.PGSSLMODE).toBe('verify-full');
    expect(r.env.PGSSLROOTCERT).toBe(CA);
    expect(r.args).toEqual(['-h', 'db.internal.example', '-p', '5432', '-U', 'op']); // no password on the command line
    expect(pgEnv('postgres://op:pw@h/db', env({ PGSSLROOTCERT: '/custom/root.pem', DB_SSL_CA_FILE: CA })).env.PGSSLROOTCERT).toBe('/custom/root.pem');
  });
});
