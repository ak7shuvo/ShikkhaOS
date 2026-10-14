import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbNameFor, urlForDb } from '../src/provisioning.js';
import { COPY_ORDER, importPlatformAdmins, migrateSharedToDedicated, rollbackToShared, type MigrationDeps } from '../src/shared-migration.js';
import { controlFixture, type ControlFixture } from './fixtures.js';
import { Client, fillSheet, harness, loginAs, PASSWORD, seed, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let f: ControlFixture;
let deps: MigrationDeps;

beforeAll(async () => {
  h = await harness();
  f = await controlFixture();
  deps = { ...f.deps, sharedOwnerUrl: process.env.TEST_MIGRATION_DATABASE_URL! };
});
afterAll(async () => {
  await f.close();
  await h.close();
});

const dedicated = async <T>(id: string, sql: string, params: unknown[] = []): Promise<T[]> => {
  const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(id)) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
};
const mode = async (id: string) => (await f.control.query(`SELECT db_mode, status FROM schools WHERE id = $1`, [id])).rows[0];

/** Phase 1 school with realistic history: published result, a correction in progress, audit trail, and a platform-admin audit actor. */
async function phase1School(prefix: string): Promise<{ S: SeededSchool; sheetId: string }> {
  const S = await seed(h, prefix);
  const teacher = await loginAs(h, S.users.teacher.email);
  const ctrl = await loginAs(h, S.users.controller.email);
  const { sheetId } = await fillSheet(h, teacher, S);
  for (const a of ['submit']) await teacher.post(`/result-sheets/${sheetId}/${a}`);
  for (const a of ['start-review', 'approve', 'publish']) expect((await ctrl.post(`/result-sheets/${sheetId}/${a}`)).status).toBe(200);
  expect((await ctrl.post(`/result-sheets/${sheetId}/correction`, { reason: 'Re-check after audit' })).status).toBe(200);
  // A Phase 1 platform administrator who acted inside this school (audit actor), as Phase 1 allowed.
  const pa = (await h.owner.query(`INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES ($1,'x','Old Root',true) RETURNING id`, [`oldroot-${S.code}@petra.example.test`])).rows[0].id;
  await h.owner.query(`INSERT INTO audit_events (school_id, actor_user_id, action, entity_type) VALUES ($1,$2,'platform.school.create','school')`, [S.schoolId, pa]);
  return { S, sheetId };
}

describe('shared → dedicated migration', () => {
  it('copies everything faithfully, verifies it, cuts over, and keeps the shared copy untouched', async () => {
    const { S, sheetId } = await phase1School('mig1');
    const before = (await h.owner.query(`SELECT (SELECT count(*) FROM students WHERE school_id=$1)::int AS students, (SELECT count(*) FROM published_results WHERE school_id=$1)::int AS pub`, [S.schoolId])).rows[0];

    const report = await migrateSharedToDedicated(deps, S.schoolId);
    expect(report.tables.every((t) => t.match)).toBe(true);
    expect(report.tables.map((t) => t.table)).toEqual(COPY_ORDER.map((t) => t.table));
    expect(await mode(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
    expect((await f.control.query(`SELECT migrated_from_shared_at FROM schools WHERE id = $1`, [S.schoolId])).rows[0].migrated_from_shared_at).not.toBeNull();

    // Shared copy is untouched (rollback source).
    expect((await h.owner.query(`SELECT (SELECT count(*) FROM students WHERE school_id=$1)::int AS students, (SELECT count(*) FROM published_results WHERE school_id=$1)::int AS pub`, [S.schoolId])).rows[0]).toEqual(before);

    // Same credentials still work; the app now talks to the dedicated database.
    const guardian = await loginAs(h, S.users.guardian.email);
    const res = await guardian.get(`/guardian/students/${S.students[0]!.id}/results`);
    expect(res.body.items).toMatchObject([{ subject_name: 'Bangla', obtained: 90, grade: 'A' }]);
    expect((await dedicated<{ n: number }>(S.schoolId, `SELECT count(*)::int AS n FROM students`))[0]!.n).toBe(before.students);

    // History preserved, and the correction-in-progress state is intact (published stays visible, sheet is back to draft r2).
    const ctrl = await loginAs(h, S.users.controller.email);
    const hist = await ctrl.get(`/result-sheets/${sheetId}/history`);
    expect(hist.body.events.map((e: any) => e.action)).toEqual(['create', 'submit', 'start_review', 'approve', 'publish', 'open_correction']);
    expect((await ctrl.get(`/result-sheets/${sheetId}`)).body).toMatchObject({ status: 'draft', revision: 2 });
  });

  it('Phase 1 platform admins do not carry credentials into the school database; referenced actors become disabled stubs', async () => {
    const { S } = await phase1School('mig2');
    await migrateSharedToDedicated(deps, S.schoolId);
    const users = await dedicated<{ email: string; status: string; password_hash: string; is_platform_admin: boolean }>(S.schoolId, `SELECT email::text AS email, status, password_hash, is_platform_admin FROM users`);
    const stub = users.find((u) => u.email.startsWith('oldroot-'))!;
    expect(stub).toMatchObject({ status: 'disabled', password_hash: '!', is_platform_admin: false });
    expect(users.every((u) => !u.is_platform_admin)).toBe(true);
    expect((await new Client(h.app).login(stub.email, 'anything-123', S.code)).status).toBe(401);
  });

  it('the restored database keeps its guards: marks of locked sheets cannot be edited afterwards', async () => {
    const { S } = await phase1School('mig3');
    await migrateSharedToDedicated(deps, S.schoolId);
    const trg = await dedicated<{ tgenabled: string }>(S.schoolId, `SELECT tgenabled FROM pg_trigger WHERE tgname = 'marks_guard_trg'`);
    expect(trg[0]!.tgenabled).toBe('O');
    await expect(dedicated(S.schoolId, `UPDATE published_results SET obtained = 1`)).rejects.toThrow(/immutable/);
  });

  it('refuses non-shared, non-active or missing schools', async () => {
    const { S } = await phase1School('mig4');
    await f.control.query(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [S.schoolId]);
    await expect(migrateSharedToDedicated(deps, S.schoolId)).rejects.toThrow(/must be active/);
    await f.control.query(`UPDATE schools SET status = 'active' WHERE id = $1`, [S.schoolId]);
    await migrateSharedToDedicated(deps, S.schoolId);
    await expect(migrateSharedToDedicated(deps, S.schoolId)).rejects.toThrow(/not in shared mode/);
  });

  it('a failure mid-copy leaves the school shared and serving; a retry succeeds', async () => {
    const { S } = await phase1School('mig5');
    const failing = { ...deps, afterTable: (t: string) => { if (t === 'marks') throw new Error('simulated failure during copy'); } };
    await expect(migrateSharedToDedicated(failing, S.schoolId)).rejects.toThrow(/simulated failure/);
    expect(await mode(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
    expect((await f.control.query(`SELECT provisioning_error FROM schools WHERE id = $1`, [S.schoolId])).rows[0].provisioning_error).toMatch(/migration failed/);
    // still works on the shared database
    expect((await (await loginAs(h, S.users.admin.email)).get('/classes')).status).toBe(200);
    // the transaction rolled back the partial copy
    expect((await dedicated<{ n: number }>(S.schoolId, `SELECT count(*)::int AS n FROM schools`))[0]!.n).toBe(0);
    expect((await dedicated<{ tgenabled: string }>(S.schoolId, `SELECT tgenabled FROM pg_trigger WHERE tgname = 'marks_guard_trg'`))[0]!.tgenabled).toBe('O');
    await migrateSharedToDedicated(deps, S.schoolId);
    expect(await mode(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
  });

  it('refuses a non-empty target unless the operator explicitly resets it', async () => {
    const { S } = await phase1School('mig5b');
    const failing = { ...deps, afterTable: () => { throw new Error('stop after provisioning'); } };
    await expect(migrateSharedToDedicated(failing, S.schoolId)).rejects.toThrow();
    await dedicated(S.schoolId, `INSERT INTO schools (id, code, name) VALUES ($1,'leftover','Leftover')`, [S.schoolId]);
    await expect(migrateSharedToDedicated(deps, S.schoolId)).rejects.toThrow(/not empty/);
    expect((await mode(S.schoolId)).db_mode).toBe('shared');
    await migrateSharedToDedicated(deps, S.schoolId, { resetTarget: true });
    expect((await mode(S.schoolId)).db_mode).toBe('dedicated');
    expect((await dedicated<{ code: string }>(S.schoolId, `SELECT code FROM schools`))[0]!.code).toBe(S.code);
  });

  it('verification catches corrupted copies and never cuts over', async () => {
    const { S } = await phase1School('mig6');
    const corrupting = { ...deps, beforeVerify: async (c: pg.Client) => { await c.query(`UPDATE marks SET obtained = obtained + 1 WHERE obtained IS NOT NULL`); } };
    await expect(migrateSharedToDedicated(corrupting, S.schoolId)).rejects.toThrow(/verification failed: marks/);
    expect(await mode(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
  });

  it('maintenance mode blocks traffic during the copy and is reported as 503', async () => {
    const { S } = await phase1School('mig7');
    const admin = await loginAs(h, S.users.admin.email);
    let during = 0;
    let loginDuring = 0;
    const probing = { ...deps, afterTable: async (t: string) => {
      if (t === 'schools') {
        during = (await admin.get('/classes')).status;
        loginDuring = (await new Client(h.app).login(S.users.admin.email)).status;
      }
    } };
    await migrateSharedToDedicated(probing, S.schoolId);
    expect(during).toBe(503);
    expect(loginDuring).toBe(503);
    expect((await admin.get('/classes')).status).toBe(401); // sessions did not move: users sign in again
    expect((await loginAs(h, S.users.admin.email).then((c) => c.get('/classes'))).status).toBe(200);
  });
});

describe('rollback to the shared database', () => {
  it('is allowed while no writes happened since cutover, and returns traffic to the shared copy', async () => {
    const { S } = await phase1School('rb1');
    await migrateSharedToDedicated(deps, S.schoolId);
    const r = await rollbackToShared(deps, S.schoolId);
    expect(r.writes_since_cutover).toBe(0);
    expect(await mode(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
    expect((await (await loginAs(h, S.users.admin.email)).get('/classes')).status).toBe(200);
  });

  it('is refused when the dedicated database accepted writes after cutover, unless data loss is accepted explicitly', async () => {
    const { S } = await phase1School('rb2');
    await migrateSharedToDedicated(deps, S.schoolId);
    const admin = await loginAs(h, S.users.admin.email);
    expect((await admin.post('/classes', { name: 'Written after cutover' })).status).toBe(201);
    await expect(rollbackToShared(deps, S.schoolId)).rejects.toThrow(/would lose them/);
    expect((await mode(S.schoolId)).db_mode).toBe('dedicated');
    const r = await rollbackToShared(deps, S.schoolId, { acceptDataLoss: true });
    expect(r.writes_since_cutover).toBeGreaterThan(0);
    expect((await mode(S.schoolId)).db_mode).toBe('shared');
  });

  it('only schools that were migrated can be rolled back', async () => {
    const { S } = await phase1School('rb3');
    await expect(rollbackToShared(deps, S.schoolId)).rejects.toThrow(/not migrated/);
  });
});

describe('platform admin import', () => {
  it('moves active Phase 1 platform admins into the control plane once', async () => {
    const email = `imp-${Date.now()}@petra.example.test`;
    await h.owner.query(`INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES ($1,'hash-from-phase1','Imported',true)`, [email]);
    const first = await importPlatformAdmins(f.control, process.env.TEST_MIGRATION_DATABASE_URL!);
    expect(first.imported).toBeGreaterThanOrEqual(1);
    expect((await f.control.query(`SELECT password_hash FROM platform_admins WHERE email = $1`, [email])).rows[0].password_hash).toBe('hash-from-phase1');
    expect((await importPlatformAdmins(f.control, process.env.TEST_MIGRATION_DATABASE_URL!)).imported).toBe(0);
    void PASSWORD;
  });
});
