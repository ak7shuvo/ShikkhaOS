import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import { cleanupOwnedObjects, runSetup } from './global-setup.js';
import { MARKER_DB, UnsafeTestEnvironmentError, assertClusterMarker, planCleanup, urlWithDb, validateTestEnvironment } from './safety.js';

// Pure fixture: never connected to.
const base = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  PETRA_TEST_CLUSTER: 'disposable',
  PETRA_TEST_CLUSTER_ID: 'cluster-id-0001',
  TEST_PROVISIONER_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/postgres',
  TEST_DATABASE_URL: 'postgres://shikkha_app:x@127.0.0.1:54329/shikkhaos_test',
  TEST_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/shikkhaos_test',
  TEST_CONTROL_DATABASE_URL: 'postgres://petra_control_app:x@127.0.0.1:54329/petra_control_test',
  TEST_CONTROL_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/petra_control_test',
  ...over,
});
const refuses = (env: NodeJS.ProcessEnv, re: RegExp) => expect(() => validateTestEnvironment(env)).toThrow(re);

describe('environment validation (pure, no I/O)', () => {
  it('accepts a fully specified disposable environment', () => {
    expect(validateTestEnvironment(base())).toMatchObject({ host: '127.0.0.1', port: '54329', sharedDb: 'shikkhaos_test', controlDb: 'petra_control_test' });
  });
  it('requires the explicit opt-in and a cluster id', () => {
    refuses(base({ PETRA_TEST_CLUSTER: undefined }), /PETRA_TEST_CLUSTER=disposable/);
    refuses(base({ PETRA_TEST_CLUSTER: 'true' }), /PETRA_TEST_CLUSTER=disposable/);
    refuses(base({ PETRA_TEST_CLUSTER_ID: undefined }), /PETRA_TEST_CLUSTER_ID/);
    refuses(base({ PETRA_TEST_CLUSTER_ID: 'short' }), /PETRA_TEST_CLUSTER_ID/);
  });
  it('requires every TEST_* URL and rejects non-postgres or malformed ones', () => {
    for (const k of [
      'TEST_PROVISIONER_DATABASE_URL',
      'TEST_DATABASE_URL',
      'TEST_MIGRATION_DATABASE_URL',
      'TEST_CONTROL_DATABASE_URL',
      'TEST_CONTROL_MIGRATION_DATABASE_URL',
    ])
      refuses(base({ [k]: undefined }), new RegExp(`${k} is not set`));
    refuses(base({ TEST_DATABASE_URL: 'mysql://a:b@127.0.0.1/x' }), /not a postgres URL/);
    refuses(base({ TEST_DATABASE_URL: 'not a url' }), /not a valid URL/);
  });
  it('refuses non-loopback hosts unless explicitly allow-listed, and mixed hosts/ports', () => {
    const remote = (h: string) => ({
      TEST_PROVISIONER_DATABASE_URL: `postgres://o:x@${h}:54329/postgres`,
      TEST_DATABASE_URL: `postgres://shikkha_app:x@${h}:54329/shikkhaos_test`,
      TEST_MIGRATION_DATABASE_URL: `postgres://o:x@${h}:54329/shikkhaos_test`,
      TEST_CONTROL_DATABASE_URL: `postgres://petra_control_app:x@${h}:54329/petra_control_test`,
      TEST_CONTROL_MIGRATION_DATABASE_URL: `postgres://o:x@${h}:54329/petra_control_test`,
    });
    refuses(base(remote('db.prod.example.com')), /neither loopback nor listed/);
    expect(validateTestEnvironment(base({ ...remote('ci-pg.internal'), PETRA_TEST_ALLOWED_HOSTS: 'ci-pg.internal' })).host).toBe('ci-pg.internal');
    refuses(base({ ...remote('ci-pg.internal'), PETRA_TEST_ALLOWED_HOSTS: 'other-host' }), /neither loopback nor listed/);
    refuses(base({ TEST_DATABASE_URL: 'postgres://shikkha_app:x@127.0.0.1:5432/shikkhaos_test' }), /different host\/port/);
    refuses(base({ TEST_CONTROL_DATABASE_URL: 'postgres://petra_control_app:x@localhost:54329/petra_control_test' }), /different host\/port/);
  });
  it('allows only strictly test-named databases and the maintenance database for provisioning', () => {
    refuses(base({ TEST_PROVISIONER_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/shikkhaos_dev' }), /maintenance database "postgres"/);
    for (const name of ['shikkhaos_dev', 'shikkhaos', 'shikkhaos_test_UPPER', 'shikkhaos_testing_x_very_long_name_exceeding', 'postgres']) {
      refuses(
        base({
          TEST_DATABASE_URL: `postgres://shikkha_app:x@127.0.0.1:54329/${name}`,
          TEST_MIGRATION_DATABASE_URL: `postgres://owner:x@127.0.0.1:54329/${name}`,
        }),
        /does not match/,
      );
    }
    for (const name of ['petra_control_dev', 'petra_control', 'petra_control_test-x', 'sk_0123456789ab']) {
      refuses(
        base({
          TEST_CONTROL_DATABASE_URL: `postgres://petra_control_app:x@127.0.0.1:54329/${name}`,
          TEST_CONTROL_MIGRATION_DATABASE_URL: `postgres://owner:x@127.0.0.1:54329/${name}`,
        }),
        /does not match/,
      );
    }
    expect(
      validateTestEnvironment(
        base({
          TEST_DATABASE_URL: 'postgres://shikkha_app:x@127.0.0.1:54329/shikkhaos_test_ab1',
          TEST_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/shikkhaos_test_ab1',
        }),
      ).sharedDb,
    ).toBe('shikkhaos_test_ab1');
  });
  it('requires owner and app URLs to name the same database and the fixed application roles', () => {
    refuses(base({ TEST_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/shikkhaos_test_other' }), /same database/);
    refuses(base({ TEST_CONTROL_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:54329/petra_control_test_other' }), /same database/);
    refuses(base({ TEST_DATABASE_URL: 'postgres://someone_else:x@127.0.0.1:54329/shikkhaos_test' }), /role shikkha_app/);
    refuses(base({ TEST_CONTROL_DATABASE_URL: 'postgres://someone_else:x@127.0.0.1:54329/petra_control_test' }), /role petra_control_app/);
  });
});

describe('cluster marker (read-only check)', () => {
  const stub = (rows: { cluster_id: string }[] | Error) => ({
    query: async () => {
      if (rows instanceof Error) throw rows;
      return { rows };
    },
  });
  it('refuses a cluster without the marker, with a different id, or with an ambiguous marker', async () => {
    await expect(assertClusterMarker(stub(new Error('relation "marker" does not exist')), 'id')).rejects.toBeInstanceOf(UnsafeTestEnvironmentError);
    await expect(assertClusterMarker(stub([{ cluster_id: 'other' }]), 'id')).rejects.toThrow(/does not match/);
    await expect(assertClusterMarker(stub([]), 'id')).rejects.toThrow(/does not match/);
    await expect(assertClusterMarker(stub([{ cluster_id: 'id' }, { cluster_id: 'id' }]), 'id')).rejects.toThrow(/does not match/);
  });
  it('accepts exactly one matching marker row', async () => {
    await expect(assertClusterMarker(stub([{ cluster_id: 'id' }]), 'id')).resolves.toBeUndefined();
  });
});

describe('cleanup plan (pure)', () => {
  const db = 'sk_0123456789ab';
  it('includes only registry-attributed school objects, their verify scratch databases, and ledger scratch databases', () => {
    const plan = planCleanup({
      registry: [
        { db_name: db, db_role: `${db}_app` },
        { db_name: null, db_role: null },
      ],
      ledger: [{ kind: 'database', name: 'petra_test_scratch_x_abc' }],
    });
    expect(plan.databases.sort()).toEqual([db, `verify_${db}`, 'petra_test_scratch_x_abc'].sort());
    expect(plan.roles).toEqual([`${db}_app`]);
  });
  it('fails closed on anything unexpected (nothing would be dropped)', () => {
    for (const bad of ['postgres', 'shikkhaos_dev', 'petra_control_dev', 'sk_short', 'SK_0123456789AB', MARKER_DB, 'template1']) {
      expect(() => planCleanup({ registry: [{ db_name: bad, db_role: `${bad}_app` }], ledger: [] }), bad).toThrow(UnsafeTestEnvironmentError);
    }
    expect(() => planCleanup({ registry: [{ db_name: db, db_role: 'some_other_role' }], ledger: [] })).toThrow(/unexpected registry role/);
    expect(() => planCleanup({ registry: [{ db_name: db, db_role: null }], ledger: [] })).toThrow(UnsafeTestEnvironmentError);
    for (const bad of ['postgres', 'restore_something', 'verify_sk_0123456789ab', db, MARKER_DB, 'petra_test_scratch_', 'petra_test_scratch_UPPER']) {
      expect(() => planCleanup({ registry: [], ledger: [{ kind: 'database', name: bad }] }), bad).toThrow(UnsafeTestEnvironmentError);
    }
    expect(() => planCleanup({ registry: [], ledger: [{ kind: 'role', name: 'petra_test_scratch_x' }] })).toThrow(/unexpected ledger entry/);
  });
});

// --- real PostgreSQL, but only on the validated disposable cluster, and only on objects created by this test ---
const env = validateTestEnvironment(process.env); // the suite itself already refused to start otherwise
const DECOY_DB = 'sk_0123456789ab';
const DECOY_ROLE = 'sk_0123456789ab_app';
const OTHER_DB = 'unrelated_probe_db';
const OTHER_ROLE = 'unrelated_probe_role';
const GUARD_CONTROL = 'petra_control_test_guard';
const OWNED_DB = 'sk_aaaaaaaaaaaa';
const OWNED_ROLE = 'sk_aaaaaaaaaaaa_app';
const OWNED_VERIFY = 'verify_sk_aaaaaaaaaaaa';
const OWNED_SCRATCH = 'petra_test_scratch_guard_aa';
const guardOwnerUrl = urlWithDb(env.controlOwner, GUARD_CONTROL);

const admin = async <T>(fn: (c: pg.Client) => Promise<T>, url = env.adminUrl): Promise<T> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const dbs = () => admin(async (c) => (await c.query(`SELECT datname FROM pg_database`)).rows.map((r) => r.datname as string));
const roles = () => admin(async (c) => (await c.query(`SELECT rolname FROM pg_roles`)).rows.map((r) => r.rolname as string));
const dropAll = () =>
  admin(async (c) => {
    for (const d of [DECOY_DB, OTHER_DB, GUARD_CONTROL, OWNED_DB, OWNED_VERIFY, OWNED_SCRATCH]) await c.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
    for (const r of [DECOY_ROLE, OTHER_ROLE, OWNED_ROLE]) await c.query(`DROP ROLE IF EXISTS "${r}"`);
  });

describe('guarded setup on the disposable cluster', () => {
  beforeAll(async () => {
    await dropAll();
    await admin(async (c) => {
      for (const d of [DECOY_DB, OTHER_DB, GUARD_CONTROL, OWNED_DB, OWNED_VERIFY, OWNED_SCRATCH]) await c.query(`CREATE DATABASE "${d}"`);
      for (const r of [DECOY_ROLE, OTHER_ROLE, OWNED_ROLE]) await c.query(`CREATE ROLE "${r}" NOLOGIN`);
    });
    await migrate(guardOwnerUrl, { dir: CONTROL_MIGRATIONS_DIR, lockKey: 727009 });
  });
  afterAll(dropAll);

  it('refuses before any connection when the opt-in is missing (a dead port yields the validation error, not ECONNREFUSED)', async () => {
    const dead = base({
      PETRA_TEST_CLUSTER: undefined,
      TEST_PROVISIONER_DATABASE_URL: 'postgres://owner:x@127.0.0.1:1/postgres',
      TEST_DATABASE_URL: 'postgres://shikkha_app:x@127.0.0.1:1/shikkhaos_test',
      TEST_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:1/shikkhaos_test',
      TEST_CONTROL_DATABASE_URL: 'postgres://petra_control_app:x@127.0.0.1:1/petra_control_test',
      TEST_CONTROL_MIGRATION_DATABASE_URL: 'postgres://owner:x@127.0.0.1:1/petra_control_test',
    });
    await expect(runSetup(dead)).rejects.toBeInstanceOf(UnsafeTestEnvironmentError);
  });

  it('refuses an unapproved cluster (wrong marker id) and leaves every database and role untouched', async () => {
    const beforeDbs = (await dbs()).sort();
    const beforeRoles = (await roles()).sort();
    const sharedHadSchema = await admin(async (c) => (await c.query(`SELECT to_regclass('public.users') AS t`)).rows[0].t, env.sharedOwner);
    await expect(runSetup({ ...process.env, PETRA_TEST_CLUSTER_ID: 'a-different-cluster-id' })).rejects.toThrow(/cluster marker does not match/);
    await expect(
      runSetup({
        ...process.env,
        TEST_DATABASE_URL: env.sharedApp.replace('/shikkhaos_test', '/shikkhaos_dev'),
        TEST_MIGRATION_DATABASE_URL: env.sharedOwner.replace('/shikkhaos_test', '/shikkhaos_dev'),
      }),
    ).rejects.toThrow(/does not match/);
    expect((await dbs()).sort()).toEqual(beforeDbs);
    expect((await roles()).sort()).toEqual(beforeRoles);
    expect(await admin(async (c) => (await c.query(`SELECT to_regclass('public.users') AS t`)).rows[0].t, env.sharedOwner)).toBe(sharedHadSchema);
  });

  it('cleanup drops only registry/ledger-attributed objects; unregistered sk_* and unrelated databases/roles survive', async () => {
    await admin(
      (c) =>
        c.query(
          `INSERT INTO schools (slug, name, status, db_mode, db_name, db_role, db_secret_enc, provisioning_step) VALUES ('guard-owned','Guard Owned','active','dedicated',$1,$2,'v1.k1.x.x.x','active')`,
          [OWNED_DB, OWNED_ROLE],
        ),
      guardOwnerUrl,
    );
    await admin(async (c) => {
      await c.query('CREATE TABLE IF NOT EXISTS created_objects (kind text NOT NULL, name text PRIMARY KEY)');
      await c.query(`INSERT INTO created_objects VALUES ('database', $1) ON CONFLICT DO NOTHING`, [OWNED_SCRATCH]);
    }, env.markerUrl);

    const plan = await cleanupOwnedObjects({ adminUrl: env.adminUrl, markerUrl: env.markerUrl, controlOwner: guardOwnerUrl });
    expect(plan.databases.sort()).toEqual([OWNED_DB, OWNED_SCRATCH, OWNED_VERIFY].sort());

    const d = await dbs();
    const r = await roles();
    for (const gone of [OWNED_DB, OWNED_VERIFY, OWNED_SCRATCH]) expect(d, gone).not.toContain(gone);
    expect(r).not.toContain(OWNED_ROLE);
    // survivors: unregistered look-alikes, unrelated objects, protected databases, the test databases themselves
    for (const kept of [DECOY_DB, OTHER_DB, 'postgres', 'template1', MARKER_DB, env.sharedDb, env.controlDb, GUARD_CONTROL]) expect(d, kept).toContain(kept);
    for (const kept of [DECOY_ROLE, OTHER_ROLE, 'shikkha_app', 'petra_control_app']) expect(r, kept).toContain(kept);
    // the ledger row was consumed
    expect(
      await admin(async (c) => (await c.query(`SELECT count(*)::int n FROM created_objects WHERE name = $1`, [OWNED_SCRATCH])).rows[0].n, env.markerUrl),
    ).toBe(0);
  });

  it('aborts without dropping anything when the ledger or registry holds an unexpected entry', async () => {
    await admin(async (c) => {
      await c.query(`CREATE DATABASE "${OWNED_DB}"`);
    });
    await admin(
      (c) =>
        c.query(
          `INSERT INTO schools (slug, name, status, db_mode, db_name, db_role, db_secret_enc, provisioning_step) VALUES ('guard-owned2','Guard Owned 2','active','dedicated',$1,$2,'v1.k1.x.x.x','active')`,
          [OWNED_DB, OWNED_ROLE],
        ),
      guardOwnerUrl,
    ).catch(() => undefined);
    await admin((c) => c.query(`INSERT INTO created_objects VALUES ('database', 'postgres') ON CONFLICT DO NOTHING`), env.markerUrl);
    const before = (await dbs()).sort();
    await expect(cleanupOwnedObjects({ adminUrl: env.adminUrl, markerUrl: env.markerUrl, controlOwner: guardOwnerUrl })).rejects.toBeInstanceOf(
      UnsafeTestEnvironmentError,
    );
    expect((await dbs()).sort()).toEqual(before); // nothing dropped, including the registered database
    await admin((c) => c.query(`DELETE FROM created_objects WHERE name = 'postgres'`), env.markerUrl);
  });
});
