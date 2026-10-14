import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { provisionSchool } from '../src/provisioning.js';
import { tlsOptions } from '../src/tls.js';
import { controlFixture, registerNew, type ControlFixture } from './fixtures.js';
import { Client, testEnv } from './helpers.js';

const TRUSTED = process.env.PETRA_TEST_TLS_CA;
const UNTRUSTED = process.env.PETRA_TEST_TLS_UNTRUSTED_CA;

describe('tlsOptions (always runs)', () => {
  it('disabled → no TLS; enabled → verification is always on; CA file is loaded', () => {
    expect(tlsOptions(false)).toBe(false);
    expect(tlsOptions(false, '/nonexistent')).toBe(false);
    expect(tlsOptions(true)).toEqual({ rejectUnauthorized: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petra-tls-'));
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
    expect(tlsOptions(true, ca)).toEqual({ rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') });
    expect(() => tlsOptions(true, path.join(dir, 'missing.pem'))).toThrow();
  });
});

/**
 * Trusted-CA integration tests. They need a disposable PostgreSQL with `ssl=on` and a server certificate (localhost/127.0.0.1)
 * signed by PETRA_TEST_TLS_CA, plus an unrelated CA in PETRA_TEST_TLS_UNTRUSTED_CA. scripts/ci/gen-test-certs.sh creates the
 * material; the CI workflow starts such a server. Without these variables the tests are SKIPPED (reported as skipped, never as passed).
 */
describe.skipIf(!TRUSTED || !UNTRUSTED)('database TLS with certificate verification', () => {
  let f: ControlFixture;
  const controlUrl = () => process.env.TEST_CONTROL_DATABASE_URL!;

  beforeAll(async () => {
    f = await controlFixture();
  });
  afterAll(() => f.close());

  const probe = async (url: string, ssl: false | pg.PoolConfig['ssl']) => {
    const pool = createPool(url, ssl);
    try {
      const r = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      return { ok: true as const, ssl: r.rows[0]?.ssl as boolean };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    } finally {
      await pool.end().catch(() => undefined);
    }
  };

  it('the server really offers TLS (precondition)', async () => {
    expect((await f.admin.query('SHOW ssl')).rows[0].ssl).toBe('on');
  });

  it('control-plane pool: trusted CA → connected over TLS; untrusted CA → refused; no CA configured → refused; TLS off → plain', async () => {
    expect(await probe(controlUrl(), tlsOptions(true, TRUSTED))).toEqual({ ok: true, ssl: true });
    const bad = await probe(controlUrl(), tlsOptions(true, UNTRUSTED));
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/self.signed|unable to (get|verify)|certificate/i);
    const none = await probe(controlUrl(), tlsOptions(true)); // system trust store does not contain the test CA
    expect(none.ok).toBe(false);
    expect(await probe(controlUrl(), false)).toMatchObject({ ok: true, ssl: false });
  });

  it('host name verification stays on: the right CA but a name the certificate does not cover is refused', async () => {
    const u = new URL(controlUrl());
    u.hostname = '127.0.0.2';
    const r = await probe(u.toString(), tlsOptions(true, TRUSTED));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/altnames|hostname|IP|ECONNREFUSED|certificate/i);
  });

  it('school database pools (TenantRouter via the API): trusted CA → login works over TLS; untrusted CA → school unavailable', async () => {
    const { id, slug } = await registerNew(f, 'tls');
    const p = await provisionSchool(f.deps, id);
    const role = (await f.control.query('SELECT db_role FROM schools WHERE id = $1', [id])).rows[0].db_role as string;
    const sslSessions = async () =>
      Number(
        (await f.admin.query(`SELECT count(*)::int AS n FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename = $1 AND s.ssl`, [role])).rows[0]
          .n,
      );

    const build = async (caFile: string) => {
      const control = createPool(controlUrl());
      const app = await buildApp(testEnv({ SCHOOL_DB_SSL: 'true', DB_SSL_CA_FILE: caFile }), control, {});
      await app.ready();
      return {
        app,
        close: async () => {
          await app.close();
          await control.end();
        },
      };
    };

    const good = await build(TRUSTED!);
    try {
      const c = new Client(good.app);
      expect((await c.login(`admin@${slug}.example.test`, p.adminInitialPassword!, slug)).status).toBe(200);
      expect((await c.get('/classes')).status).toBe(200);
      expect(await sslSessions()).toBeGreaterThan(0); // the school role's sessions are encrypted
    } finally {
      await good.close();
    }

    const evil = await build(UNTRUSTED!);
    try {
      const c = new Client(evil.app);
      const r = await c.login(`admin@${slug}.example.test`, p.adminInitialPassword!, slug);
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(r.status).not.toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/self.signed|certificate|postgres:\/\//i); // no connection details leak to clients
    } finally {
      await evil.close();
    }
  });

  it('operator tools (pg_dump through libpq): verify-full with the trusted CA succeeds; untrusted CA and a missing root cert fail', async () => {
    const u = new URL(process.env.TEST_PROVISIONER_DATABASE_URL!);
    const run = (root: string | undefined) =>
      spawnSync('pg_dump', ['-s', '-h', u.hostname, '-p', u.port, '-U', decodeURIComponent(u.username), '-d', 'petra_control_test', '-f', '/dev/null'], {
        env: {
          ...process.env,
          PGPASSWORD: decodeURIComponent(u.password),
          PGSSLMODE: 'verify-full',
          ...(root ? { PGSSLROOTCERT: root } : { PGSSLROOTCERT: '/nonexistent/root.crt' }),
        },
        encoding: 'utf8',
      });
    expect(run(TRUSTED).status).toBe(0);
    const bad = run(UNTRUSTED);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/certificate verify failed/i);
    expect(run(undefined).status).not.toBe(0);
  });
});
