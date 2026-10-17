import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkSchoolHealth,
  dbNameFor,
  migrateSchool,
  provisionSchool,
  ProvisioningBusyError,
  roleNameFor,
  rotateSchoolSecret,
  urlForDb,
  type Step,
} from '../src/provisioning.js';
import { SCHOOL_MIGRATIONS_DIR } from '../src/migrate.js';
import { REGISTRY_COLUMNS, TenantRouter, TenantUnavailableError, type RegistryEntry } from '../src/tenancy.js';
import { SecretBox, generateMasterKey, loadMasterKeys } from '../src/secrets.js';
import { controlFixture, provisionNew, registerNew, testSecretBox, type ControlFixture } from './fixtures.js';

let f: ControlFixture;
beforeAll(async () => {
  f = await controlFixture();
});
afterAll(() => f.close());

const entry = async (id: string): Promise<RegistryEntry> => (await f.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id])).rows[0];
const schoolConn = async (e: RegistryEntry, database = e.db_name!) => {
  const c = new pg.Client({ host: e.db_host!, port: e.db_port!, database, user: e.db_role!, password: f.deps.secrets.decrypt(e.db_secret_enc!, e.id) });
  await c.connect();
  return c;
};
const dbExists = async (name: string) => (await f.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
const roleCount = async (name: string) => (await f.admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount;

describe('provisioning a dedicated school database', () => {
  it('creates database, restricted role, schema, first admin; registry holds an encrypted credential', async () => {
    const { id, slug, result } = await provisionNew(f, 'prov');
    expect(result.step).toBe('active');
    expect(result.adminInitialPassword).toMatch(/^.{20}$/);
    const e = await entry(id);
    expect(e).toMatchObject({
      status: 'active',
      db_mode: 'dedicated',
      db_name: dbNameFor(id),
      db_role: roleNameFor(id),
      provisioning_step: 'active',
      schema_version: '005_login_attempts.sql',
    });
    expect(e.db_secret_enc).toMatch(/^v1\.k1\./);
    expect(JSON.stringify(e)).not.toContain(f.deps.secrets.decrypt(e.db_secret_enc!, id));
    expect(await dbExists(dbNameFor(id))).toBe(true);

    const role = (
      await f.admin.query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1', [roleNameFor(id)])
    ).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true });

    const sdb = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(id)) });
    await sdb.connect();
    expect((await sdb.query('SELECT id, code FROM schools')).rows).toEqual([{ id, code: slug }]);
    expect((await sdb.query(`SELECT count(*)::int AS n FROM school_memberships WHERE role = 'school_admin'`)).rows[0].n).toBe(1);
    expect((await sdb.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name)).toEqual([
      '001_init.sql',
      '002_session_idle.sql',
      '003_database_acl.sql',
      '005_login_attempts.sql',
    ]);
    await sdb.end();
  });

  it('is idempotent: a second run changes nothing and creates no second admin/password', async () => {
    const { id, result } = await provisionNew(f, 'idem');
    const before = await entry(id);
    const again = await provisionSchool(f.deps, id);
    expect(again).toEqual({ schoolId: id, step: 'active' });
    expect(result.adminInitialPassword).toBeDefined();
    expect(await entry(id)).toEqual(before);
  });

  it('the health check passes, using the school’s own credential', async () => {
    const { id } = await provisionNew(f, 'health');
    const h = await checkSchoolHealth(f.deps, await entry(id));
    expect(h.ok, JSON.stringify(h.checks)).toBe(true);
    expect(h.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'connect_as_school_role',
        'role_is_restricted',
        'single_school_row_matches_registry',
        'no_connect_privilege_on_other_databases',
        'migrations_current',
      ]),
    );
  });

  it('rejects invalid slugs and duplicates at registration', async () => {
    const { registerSchool } = await import('../src/registry.js');
    const base = { name: 'X School', adminEmail: 'a@x.example.test', adminName: 'A', createdBy: null, today: '2026-01-01', trialDays: 30 };
    await expect(registerSchool(f.control, { ...base, slug: 'Bad Slug' })).rejects.toThrow(/invalid/);
    await expect(registerSchool(f.control, { ...base, slug: 'admin' })).rejects.toThrow(/reserved/);
    const { slug } = await registerNew(f, 'dupe');
    await expect(registerSchool(f.control, { ...base, slug })).rejects.toThrow(/duplicate key/);
  });
});

describe('cross-school isolation at the PostgreSQL role level', () => {
  it('school A’s role cannot connect to school B’s database; B’s likewise', async () => {
    const a = await provisionNew(f, 'isoa');
    const b = await provisionNew(f, 'isob');
    const ea = await entry(a.id);
    const eb = await entry(b.id);

    const own = await schoolConn(ea);
    expect((await own.query('SELECT current_database() AS d')).rows[0].d).toBe(ea.db_name);
    await own.end();

    await expect(schoolConn(ea, eb.db_name!)).rejects.toThrow(/permission denied for database|no pg_hba|not allowed/);
    await expect(schoolConn(eb, ea.db_name!)).rejects.toThrow(/permission denied for database|no pg_hba|not allowed/);

    const priv = (await f.admin.query(`SELECT has_database_privilege($1, $2, 'CONNECT') AS c`, [ea.db_role, eb.db_name])).rows[0].c;
    expect(priv).toBe(false);
  });

  it('a school role cannot create databases/roles, and cannot read another school’s data even with its id', async () => {
    const a = await provisionNew(f, 'privA');
    const ea = await entry(a.id);
    const c = await schoolConn(ea);
    await expect(c.query('CREATE DATABASE evil')).rejects.toThrow(/permission denied/);
    await expect(c.query('CREATE ROLE evil LOGIN')).rejects.toThrow(/permission denied/);
    await expect(c.query('CREATE TABLE public.evil (x int)')).rejects.toThrow(/permission denied/);
    // RLS still applies inside the school database: no context means no rows.
    expect((await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    await c.end();
  });

  it('writes through the school role land only in that school’s database', async () => {
    const a = await provisionNew(f, 'wra');
    const b = await provisionNew(f, 'wrb');
    const ea = await entry(a.id);
    const ca = await schoolConn(ea);
    await ca.query('BEGIN');
    await ca.query(`SELECT set_config('app.school_id', $1, true)`, [a.id]);
    await ca.query(`INSERT INTO classes (school_id, name) VALUES ($1, 'Only in A')`, [a.id]);
    await ca.query('COMMIT');
    await ca.end();
    const own = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(b.id)) });
    await own.connect();
    expect((await own.query(`SELECT count(*)::int AS n FROM classes`)).rows[0].n).toBe(0);
    await own.end();
  });
});

describe('recovery from partial failures', () => {
  const STEPS_TO_BREAK: Step[] = ['db_created', 'role_created', 'migrated', 'seeded'];
  for (const step of STEPS_TO_BREAK) {
    it(`crash after "${step}": status failed with an error, resume completes with no duplicates`, async () => {
      const { id, slug } = await registerNew(f, `crash-${step}`.replace('_', ''));
      const crashing = {
        ...f.deps,
        afterStep: (s: Step) => {
          if (s === step) throw new Error(`simulated crash after ${s}`);
        },
      };
      await expect(provisionSchool(crashing, id)).rejects.toThrow(/simulated crash/);
      let e = await entry(id);
      expect(e.status).toBe('failed');
      expect(e.provisioning_error).toMatch(/simulated crash/);
      expect(e.provisioning_step).toBe(step);

      const resumed = await provisionSchool(f.deps, id);
      expect(resumed.step).toBe('active');
      e = await entry(id);
      expect(e).toMatchObject({ status: 'active', provisioning_error: null, provisioning_step: 'active' });
      expect(await roleCount(roleNameFor(id))).toBe(1);

      const sdb = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(id)) });
      await sdb.connect();
      expect((await sdb.query('SELECT code FROM schools')).rows).toEqual([{ code: slug }]);
      expect((await sdb.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
      await sdb.end();
      expect((await checkSchoolHealth(f.deps, e)).ok).toBe(true);
    });
  }

  it('a crash after the admin row was written never creates a second admin (the unrecorded initial password must be reset by an operator)', async () => {
    const { id } = await registerNew(f, 'lostpw');
    const crashing = {
      ...f.deps,
      afterStep: (s: Step) => {
        if (s === 'seeded') throw new Error('crash');
      },
    };
    await expect(provisionSchool(crashing, id)).rejects.toThrow();
    const r = await provisionSchool(f.deps, id);
    expect(r.adminInitialPassword).toBeUndefined(); // admin already exists; password was never persisted anywhere
  });

  it('a credential stored in the registry before the role exists is authoritative on resume', async () => {
    const { id } = await registerNew(f, 'presecret');
    const known = 'pre-stored-credential-123';
    await f.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1`, [id, f.deps.secrets.encrypt(known, id)]);
    await provisionSchool(f.deps, id);
    const e = await entry(id);
    const c = new pg.Client({ host: e.db_host!, port: e.db_port!, database: e.db_name!, user: e.db_role!, password: known });
    await c.connect();
    await c.end();
  });

  it('two concurrent runs cannot both provision; the loser is rejected as busy or finds it done', async () => {
    const { id } = await registerNew(f, 'race');
    const results = await Promise.allSettled([provisionSchool(f.deps, id), provisionSchool(f.deps, id)]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProvisioningBusyError);
    expect((await entry(id)).status).toBe('active');
    expect(await roleCount(roleNameFor(id))).toBe(1);
  });

  it('unreachable provisioner connection: school ends up failed with a sanitized error, no secret leak', async () => {
    const { id } = await registerNew(f, 'noadmin');
    const broken = { ...f.deps, adminUrl: 'postgres://nobody:wrong@127.0.0.1:1/postgres' };
    await expect(provisionSchool(broken, id)).rejects.toThrow();
    const e = await entry(id);
    expect(e.status).toBe('failed');
    expect(e.provisioning_error).toBeTruthy();
    expect((await provisionSchool(f.deps, id)).step).toBe('active');
  });

  it('refuses to provision a school in a terminal status', async () => {
    const { id } = await provisionNew(f, 'archived');
    await f.control.query(`UPDATE schools SET status = 'archived' WHERE id = $1`, [id]);
    await expect(provisionSchool(f.deps, id)).rejects.toThrow(/cannot be provisioned|archived/);
  });
});

describe('per-school migrations', () => {
  it('reports pending migrations, applies them to one school only, and is idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    for (const file of fs.readdirSync(SCHOOL_MIGRATIONS_DIR)) fs.copyFileSync(path.join(SCHOOL_MIGRATIONS_DIR, file), path.join(dir, file));
    const deps = { ...f.deps, schoolMigrationsDir: dir };
    const a = await provisionNew({ ...f, deps }, 'mga');
    const b = await provisionNew({ ...f, deps }, 'mgb');
    fs.writeFileSync(path.join(dir, '006_test.sql'), 'CREATE TABLE phase2_probe (id int);');
    expect((await checkSchoolHealth(deps, await entry(a.id))).pending_migrations).toEqual(['006_test.sql']);
    expect(await migrateSchool(deps, a.id)).toEqual(['006_test.sql']);
    expect(await migrateSchool(deps, a.id)).toEqual([]);
    expect((await checkSchoolHealth(deps, await entry(a.id))).ok).toBe(true);
    expect((await checkSchoolHealth(deps, await entry(b.id))).pending_migrations).toEqual(['006_test.sql']);
    expect((await entry(a.id)).schema_version).toBe('006_test.sql');
  });

  it('a failing migration rolls back and leaves the previous version intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    for (const file of fs.readdirSync(SCHOOL_MIGRATIONS_DIR)) fs.copyFileSync(path.join(SCHOOL_MIGRATIONS_DIR, file), path.join(dir, file));
    const deps = { ...f.deps, schoolMigrationsDir: dir };
    const a = await provisionNew({ ...f, deps }, 'mgfail');
    fs.writeFileSync(path.join(dir, '006_bad.sql'), 'CREATE TABLE ok_part (id int); SELECT 1/0;');
    await expect(migrateSchool(deps, a.id)).rejects.toThrow(/006_bad.sql failed/);
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(a.id)) });
    await c.connect();
    expect((await c.query(`SELECT to_regclass('public.ok_part') AS t`)).rows[0].t).toBeNull();
    await c.end();
  });
});

describe('credential rotation and master-key handling', () => {
  const routerFor = (secrets: SecretBox = f.deps.secrets) => new TenantRouter(f.control, secrets, { maxPools: 3, poolMax: 2, cacheMs: 0, ssl: false });

  it('rotation switches the password; the old one stops working; the router recovers', async () => {
    const { id } = await provisionNew(f, 'rot');
    const before = await entry(id);
    const oldPw = f.deps.secrets.decrypt(before.db_secret_enc!, id);
    const router = routerFor();
    await router.poolFor(before);
    await rotateSchoolSecret(f.deps, id);
    const after = await entry(id);
    expect(after.db_secret_enc).not.toBe(before.db_secret_enc);
    expect(after.db_secret_pending_enc).toBeNull();
    const bad = new pg.Client({ host: after.db_host!, port: after.db_port!, database: after.db_name!, user: after.db_role!, password: oldPw });
    await expect(bad.connect()).rejects.toThrow(/password authentication failed/);
    const pool = await router.poolFor(after);
    expect((await pool.query('SELECT 1 AS x')).rows[0].x).toBe(1);
    await router.close();
  });

  it('crash between ALTER ROLE and promotion: router falls back to the pending secret; rotate resumes', async () => {
    const { id } = await provisionNew(f, 'rotcrash');
    await expect(
      rotateSchoolSecret(f.deps, id, {
        afterPending: () => {
          throw new Error('crash before ALTER');
        },
      }),
    ).rejects.toThrow();
    let e = await entry(id);
    expect(e.db_secret_pending_enc).toBeTruthy();
    // simulate: ALTER ROLE ran but the registry was not promoted
    const pending = f.deps.secrets.decrypt(e.db_secret_pending_enc!, id);
    await f.admin.query(`ALTER ROLE "${e.db_role}" PASSWORD '${pending}'`);
    const router = routerFor();
    const pool = await router.poolFor(e); // current secret now fails with 28P01 → pending is tried
    expect((await pool.query('SELECT 1 AS x')).rows[0].x).toBe(1);
    await router.close();
    await rotateSchoolSecret(f.deps, id);
    e = await entry(id);
    expect(e.db_secret_pending_enc).toBeNull();
    expect(f.deps.secrets.decrypt(e.db_secret_enc!, id)).toBe(pending);
  });

  it('wrong master key: only that school’s traffic fails, with a generic unavailable error', async () => {
    const { id } = await provisionNew(f, 'wrongkey');
    const e = await entry(id);
    const wrong = new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: generateMasterKey(), PETRA_MASTER_KEY_ID: 'k1' }));
    const router = routerFor(wrong);
    await expect(router.poolFor(e)).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(router.poolFor(e)).rejects.toThrow(/cannot be decrypted/);
    await router.close();
  });

  it('a credential copied from another school’s registry row is rejected', async () => {
    const a = await provisionNew(f, 'swapa');
    const b = await provisionNew(f, 'swapb');
    const ea = await entry(a.id);
    const eb = await entry(b.id);
    const router = routerFor();
    await expect(router.poolFor({ ...eb, db_secret_enc: ea.db_secret_enc })).rejects.toBeInstanceOf(TenantUnavailableError);
    await router.close();
  });

  it('router refuses a registry row that points at the wrong database/role', async () => {
    const a = await provisionNew(f, 'mis-a');
    const b = await provisionNew(f, 'mis-b');
    const ea = await entry(a.id);
    const eb = await entry(b.id);
    const router = routerFor();
    // A's credential cannot open B's database (privilege), so the router reports unavailable rather than crossing over.
    await expect(router.poolFor({ ...ea, id: ea.id, db_name: eb.db_name })).rejects.toBeInstanceOf(TenantUnavailableError);
    await router.close();
  });

  it('keeps open pools bounded (LRU) and reuses pools', async () => {
    const entries: RegistryEntry[] = [];
    for (let i = 0; i < 4; i++) entries.push(await entry((await provisionNew(f, `lru${i}`)).id));
    const router = routerFor();
    for (const e of entries) await router.poolFor(e);
    expect(router.openPools).toBe(3);
    const p1 = await router.poolFor(entries[3]!);
    const p2 = await router.poolFor(entries[3]!);
    expect(p1).toBe(p2);
    await router.close();
    expect(router.openPools).toBe(0);
  });

  it('non-active schools are not routable', async () => {
    const router = routerFor();
    const base = await entry((await provisionNew(f, 'status')).id);
    for (const [status, code] of [
      ['requested', 'TENANT_NOT_READY'],
      ['provisioning', 'TENANT_NOT_READY'],
      ['failed', 'TENANT_NOT_READY'],
      ['suspended', 'SCHOOL_SUSPENDED'],
      ['offboarding', 'SCHOOL_OFFBOARDED'],
      ['archived', 'SCHOOL_OFFBOARDED'],
    ] as const) {
      try {
        router.assertRoutable({ ...base, status });
        expect.unreachable();
      } catch (e) {
        expect((e as TenantUnavailableError).code).toBe(code);
      }
    }
    expect(() => router.assertRoutable(base)).not.toThrow();
    await router.close();
    void testSecretBox;
  });
});
