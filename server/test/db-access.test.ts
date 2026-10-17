import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAINTENANCE_DBS, checkDatabaseAcls, hardenDatabaseAccess } from '../src/db-access.js';
import { CONTROL_MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import { dbNameFor, checkSchoolHealth, provisionSchool, urlForDb } from '../src/provisioning.js';
import { exportSchool, restoreDump } from '../src/operations.js';
import { REGISTRY_COLUMNS } from '../src/tenancy.js';
import { controlFixture, provisionNew, registerNew, scratchDbName, type ControlFixture } from './fixtures.js';
import { MARKER_DB, validateTestEnvironment } from './safety.js';
import { acceptInitialPassword, Client, harness, type Harness } from './helpers.js';

const env = validateTestEnvironment(process.env);
let f: ControlFixture;
let h: Harness;

const parts = (url: string) => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
};
async function canConnect(cfg: pg.ClientConfig): Promise<string> {
  const c = new pg.Client({ ...cfg, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return 'connected';
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.end().catch(() => undefined);
  }
}
const denied = /permission denied for database/;

async function schoolCfg(id: string) {
  const r = (await f.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id])).rows[0];
  return {
    host: r.db_host as string,
    port: r.db_port as number,
    user: r.db_role as string,
    password: f.deps.secrets.decrypt(r.db_secret_enc, id),
    database: r.db_name as string,
  };
}

beforeAll(async () => {
  f = await controlFixture();
  h = await harness();
});
afterAll(async () => {
  await h.close();
  await f.close();
});

describe('who may CONNECT to which database (real roles)', () => {
  it('a school role opens a session on its own database only: not the control plane, shared, maintenance, marker or other schools', async () => {
    const a = await provisionNew(f, 'acl-a');
    const b = await provisionNew(f, 'acl-b');
    const cfg = await schoolCfg(a.id);
    expect(await canConnect(cfg)).toBe('connected');
    for (const database of [env.controlDb, env.sharedDb, 'postgres', 'template1', MARKER_DB, dbNameFor(b.id)]) {
      expect(await canConnect({ ...cfg, database }), database).toMatch(denied);
    }
    const health = await checkSchoolHealth(f.deps, (await f.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [a.id])).rows[0]);
    expect(health.ok, JSON.stringify(health.checks.filter((c) => !c.ok))).toBe(true);
    expect(health.checks.find((c) => c.name === 'no_connect_privilege_on_other_databases')?.ok).toBe(true);
  });

  it('the control role and the legacy shared role are confined to their own databases', async () => {
    const a = await provisionNew(f, 'acl-roles');
    const ctl = { ...parts(env.controlApp) };
    const shared = { ...parts(env.sharedApp) };
    expect(await canConnect({ ...ctl, database: env.controlDb })).toBe('connected');
    expect(await canConnect({ ...shared, database: env.sharedDb })).toBe('connected');
    for (const database of [env.sharedDb, 'postgres', 'template1', MARKER_DB, dbNameFor(a.id)])
      expect(await canConnect({ ...ctl, database }), `control→${database}`).toMatch(denied);
    for (const database of [env.controlDb, 'postgres', 'template1', MARKER_DB, dbNameFor(a.id)])
      expect(await canConnect({ ...shared, database }), `shared→${database}`).toMatch(denied);
  });

  it('the health check reports a school role that could still open another database, naming the fix', async () => {
    const a = await provisionNew(f, 'acl-leak');
    const leak = await scratchDbName('leak');
    await f.admin.query(`CREATE DATABASE "${leak}"`); // default ACL: PUBLIC may CONNECT
    const entry = (await f.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [a.id])).rows[0];
    const bad = await checkSchoolHealth(f.deps, entry);
    const check = bad.checks.find((c) => c.name === 'no_connect_privilege_on_other_databases')!;
    expect(bad.ok).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(leak);
    expect(check.detail).toContain('harden-db-access');
    await f.admin.query(`DROP DATABASE "${leak}" WITH (FORCE)`);
    expect((await checkSchoolHealth(f.deps, entry)).ok).toBe(true);
  });
});

describe('hardenDatabaseAccess / checkDatabaseAcls', () => {
  it('detects PUBLIC CONNECT from the real ACL, closes it idempotently, and keeps the intended role connected', async () => {
    const name = await scratchDbName('harden');
    await f.admin.query(`CREATE DATABASE "${name}"`);
    const spec = { controlDb: name, controlRole: 'petra_control_app', maintenanceDbs: [] };
    expect((await checkDatabaseAcls(env.adminUrl, spec)).findings).toEqual([{ database: name, exists: true, public_connect: true, ok: false }]);
    const first = await hardenDatabaseAccess(env.adminUrl, spec);
    expect(first).toEqual({ applied: [name], failed: [] });
    expect((await hardenDatabaseAccess(env.adminUrl, spec)).applied).toEqual([name]); // idempotent
    expect((await checkDatabaseAcls(env.adminUrl, spec)).ok).toBe(true);
    expect(await canConnect({ ...parts(env.controlApp), database: name })).toBe('connected');
    expect(await canConnect({ ...parts(env.sharedApp), database: name })).toMatch(denied);
    await f.admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  });

  it('the cluster-level databases are closed by the setup and by the migrations (default deployment path)', async () => {
    const acl = await checkDatabaseAcls(env.adminUrl, {
      controlDb: env.controlDb,
      sharedDb: env.sharedDb,
      maintenanceDbs: [...DEFAULT_MAINTENANCE_DBS, MARKER_DB],
    });
    expect(acl.findings.map((x) => [x.database, x.ok])).toEqual([
      [env.controlDb, true],
      [env.sharedDb, true],
      ['postgres', true],
      ['template1', true],
      [MARKER_DB, true],
    ]);
    // The migrations alone close a freshly created database (no separate command needed).
    const ctl = await scratchDbName('ctlmig');
    const sch = await scratchDbName('schmig');
    await f.admin.query(`CREATE DATABASE "${ctl}"`);
    await f.admin.query(`CREATE DATABASE "${sch}"`);
    await migrate(urlForDb(env.adminUrl, ctl), { dir: CONTROL_MIGRATIONS_DIR, lockKey: 727011 });
    await migrate(urlForDb(env.adminUrl, sch), { appRole: 'shikkha_app', lockKey: 727012 });
    expect((await checkDatabaseAcls(env.adminUrl, { controlDb: ctl, sharedDb: sch, maintenanceDbs: [] })).ok).toBe(true);
    expect(await canConnect({ ...parts(env.controlApp), database: ctl })).toBe('connected');
    expect(await canConnect({ ...parts(env.sharedApp), database: sch })).toBe('connected');
    expect(await canConnect({ ...parts(env.sharedApp), database: ctl })).toMatch(denied);
    for (const d of [ctl, sch]) await f.admin.query(`DROP DATABASE "${d}" WITH (FORCE)`);
  });

  it('reports — instead of silently claiming success — when the connecting role cannot change the ACL', async () => {
    const owner = 'petra_test_notowner';
    const name = await scratchDbName('notown');
    await f.admin.query(`DROP ROLE IF EXISTS ${owner}`);
    await f.admin.query(`CREATE ROLE ${owner} LOGIN CREATEDB PASSWORD 'not-owner-pass-1'`);
    await f.admin.query(`CREATE DATABASE "${name}"`); // owned by the superuser, not by `owner`
    const u = new URL(env.adminUrl);
    const adminDb = u.pathname.slice(1) || 'postgres';
    await f.admin.query(`GRANT CONNECT ON DATABASE "${adminDb}" TO ${owner}`);
    u.username = owner;
    u.password = 'not-owner-pass-1';
    const r = await hardenDatabaseAccess(u.toString(), { controlDb: name, maintenanceDbs: [] });
    expect(r.applied).toEqual([]);
    expect(r.failed[0]?.database).toBe(name);
    expect(r.failed[0]?.error).toMatch(/no effect|permission denied|must be owner/);
    expect(r.failed[0]?.sql[0]).toContain('REVOKE ALL ON DATABASE');
    await f.admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await f.admin.query(`REVOKE CONNECT ON DATABASE "${adminDb}" FROM ${owner}`);
    await f.admin.query(`DROP ROLE ${owner}`);
  });

  it('refuses unsafe identifiers', async () => {
    await expect(hardenDatabaseAccess(env.adminUrl, { controlDb: 'x"; DROP DATABASE postgres; --', maintenanceDbs: [] })).rejects.toThrow(/unsafe/);
  });
});

describe('legitimate operator workflows still work after hardening (non-superuser provisioner)', () => {
  const op = 'petra_test_operator';
  const opPw = 'operator-pass-123';
  const opUrl = () => {
    const u = new URL(env.adminUrl);
    u.username = op;
    u.password = opPw;
    return u.toString();
  };
  const ids: string[] = [];

  beforeAll(async () => {
    await f.admin.query(`DROP ROLE IF EXISTS ${op}`);
    await f.admin.query(`CREATE ROLE ${op} LOGIN CREATEDB CREATEROLE PASSWORD '${opPw}'`);
    const r = await hardenDatabaseAccess(env.adminUrl, {
      controlDb: env.controlDb,
      sharedDb: env.sharedDb,
      maintenanceDbs: [...DEFAULT_MAINTENANCE_DBS, MARKER_DB],
      operatorRoles: [op],
    });
    expect(r.failed).toEqual([]);
  });
  afterAll(async () => {
    for (const id of ids) {
      await f.admin.query(`DROP DATABASE IF EXISTS "${dbNameFor(id)}" WITH (FORCE)`);
      await f.admin.query(`DROP ROLE IF EXISTS "${dbNameFor(id)}_app"`);
    }
    await f.admin.query(`REVOKE ALL ON DATABASE postgres FROM ${op}`);
    await f.admin.query(`DROP ROLE IF EXISTS ${op}`);
  });

  it('the operator can reach the maintenance database, provision, health-check, export and restore; the school role stays confined', async () => {
    expect(await canConnect({ ...parts(opUrl()), database: 'postgres' })).toBe('connected');
    expect(await canConnect({ ...parts(opUrl()), database: 'template1' })).toMatch(denied); // not needed: CREATE DATABASE copies the template without connecting
    const deps = { ...f.deps, adminUrl: opUrl() };
    const { id, slug } = await registerNew(f, 'acl-op');
    ids.push(id);
    const r = await provisionSchool(deps, id);
    expect(r.step).toBe('active'); // includes the ACL health gate
    const entry = (await f.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id])).rows[0];
    expect((await checkSchoolHealth(deps, entry)).ok).toBe(true);

    const admin = new Client(h.app);
    expect((await admin.login(`admin@${slug}.example.test`, r.adminInitialPassword!, slug)).status).toBe(200);
    await acceptInitialPassword(admin, r.adminInitialPassword!);
    expect((await admin.post('/classes', { name: 'After hardening' })).status).toBe(201);

    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'acl-op-'));
    const { manifestPath } = await exportSchool(deps, id, dir);
    const scratch = await scratchDbName('opre');
    const restored = await restoreDump(deps, manifestPath, scratch);
    expect(restored.ok).toBe(true);
    // restored copies are closed to everybody but their owner by default
    expect(await canConnect({ ...(await schoolCfg(id)), database: scratch })).toMatch(denied);
    await f.admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  });
});
