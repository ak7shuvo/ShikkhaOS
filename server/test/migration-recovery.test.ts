import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbNameFor, urlForDb } from '../src/provisioning.js';
import {
  inspectMaintenance,
  MigrationBusyError,
  migrateSharedToDedicated,
  recoverMaintenance,
  rollbackToShared,
  type MigrationDeps,
} from '../src/shared-migration.js';
import { controlFixture, registerNew, type ControlFixture } from './fixtures.js';
import { harness, loginAs, seed, type Harness } from './helpers.js';

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

const state = async (id: string) => (await f.control.query(`SELECT db_mode, status FROM schools WHERE id = $1`, [id])).rows[0];
const targetRows = async (id: string, sql: string) => {
  const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(id)) });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
};
const auditActions = async (id: string) =>
  (await f.control.query(`SELECT action FROM platform_audit_events WHERE school_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.action as string);

function crash(schoolId: string, point: 'mid-copy' | 'after-commit') {
  const r = spawnSync(path.resolve('../node_modules/.bin/tsx'), ['test/crash-child.ts', schoolId, point], {
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  // the tsx launcher re-spawns node and reports a SIGKILLed child as exit status 137
  expect(r.signal === 'SIGKILL' || r.status === 137, `status=${r.status} signal=${r.signal} stderr: ${r.stderr}`).toBe(true);
}

describe('concurrency: one lifecycle per school', () => {
  it('a second migration, recovery, inspect or rollback while one runs is refused/reported busy; the first completes', async () => {
    const S = await seed(h, 'mrc1');
    let secondary: unknown[] = [];
    let inspect: Awaited<ReturnType<typeof inspectMaintenance>> | undefined;
    const blocking = {
      ...deps,
      afterTable: async (t: string) => {
        if (t !== 'schools') return;
        secondary = await Promise.allSettled([
          migrateSharedToDedicated(deps, S.schoolId),
          recoverMaintenance(deps, S.schoolId, 'reopen-shared'),
          rollbackToShared(deps, S.schoolId),
        ]);
        inspect = await inspectMaintenance(deps, S.schoolId);
      },
    };
    await migrateSharedToDedicated(blocking, S.schoolId);
    for (const r of secondary as PromiseSettledResult<unknown>[]) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(MigrationBusyError);
    }
    expect(inspect?.recommendation).toBe('migration_in_progress');
    expect(inspect?.lock_free).toBe(false);
    expect(inspect?.allowed_actions).toEqual([]);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
  });

  it('two simultaneous migrations: exactly one wins, the other is refused, and the target is consistent', async () => {
    const S = await seed(h, 'mrc2');
    const res = await Promise.allSettled([migrateSharedToDedicated(deps, S.schoolId), migrateSharedToDedicated(deps, S.schoolId)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason).toBeInstanceOf(MigrationBusyError);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
    expect((await targetRows(S.schoolId, `SELECT count(*)::int AS n FROM schools`))[0].n).toBe(1);
  });

  it('the lock is released after success and after failure (a later attempt is not reported busy)', async () => {
    const S = await seed(h, 'mrc3');
    await expect(
      migrateSharedToDedicated(
        {
          ...deps,
          afterTable: () => {
            throw new Error('boom');
          },
        },
        S.schoolId,
      ),
    ).rejects.toThrow(/boom/);
    await migrateSharedToDedicated(deps, S.schoolId);
    expect((await state(S.schoolId)).db_mode).toBe('dedicated');
  });
});

describe('interrupted migration → recovery workflow', () => {
  it('SIGKILL mid-copy: school stays in maintenance, lock is released, inspect recommends reopen-shared, recovery and retry work', async () => {
    const S = await seed(h, 'mrc4');
    crash(S.schoolId, 'mid-copy');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'maintenance' });

    const ins = await inspectMaintenance(deps, S.schoolId);
    expect(ins.lock_free).toBe(true);
    expect(ins.shared_source_intact).toBe(true);
    expect(ins.target.has_school_row).toBe(false); // the uncommitted copy died with the connection
    expect(ins.recommendation).toBe('reopen-shared');
    expect(ins.allowed_actions).toEqual(['reopen-shared']);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'maintenance' }); // inspect changed nothing

    await expect(recoverMaintenance(deps, S.schoolId, 'complete-cutover')).rejects.toThrow(/not allowed/);
    await expect(recoverMaintenance(deps, S.schoolId, 'reopen-dedicated')).rejects.toThrow(/not allowed/);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'maintenance' });

    await recoverMaintenance(deps, S.schoolId, 'reopen-shared');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
    expect(await auditActions(S.schoolId)).toContain('school.maintenance_recovered.reopen-shared');
    expect((await (await loginAs(h, S.users.admin.email)).get('/classes')).status).toBe(200);

    await migrateSharedToDedicated(deps, S.schoolId);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
  });

  it('SIGKILL after the copy committed but before cut-over: inspect verifies the target; complete-cutover loses nothing', async () => {
    const S = await seed(h, 'mrc5');
    const students = (await h.owner.query(`SELECT count(*)::int AS n FROM students WHERE school_id = $1`, [S.schoolId])).rows[0].n;
    crash(S.schoolId, 'after-commit');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'maintenance' });

    const ins = await inspectMaintenance(deps, S.schoolId);
    expect(ins.target.has_school_row).toBe(true);
    expect(ins.verification).toEqual({ all_match: true, mismatched: [] });
    expect(ins.recommendation).toBe('complete-cutover');
    expect([...ins.allowed_actions].sort()).toEqual(['complete-cutover', 'reopen-shared']);

    await recoverMaintenance(deps, S.schoolId, 'complete-cutover');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
    expect((await targetRows(S.schoolId, `SELECT count(*)::int AS n FROM students`))[0].n).toBe(students);
    expect(await auditActions(S.schoolId)).toContain('school.maintenance_recovered.complete-cutover');
    expect((await (await loginAs(h, S.users.admin.email)).get('/classes')).status).toBe(200);
  });

  it('after a post-commit crash reopen-shared is also safe, and the copy is then re-done with --reset-target', async () => {
    const S = await seed(h, 'mrc6');
    crash(S.schoolId, 'after-commit');
    await recoverMaintenance(deps, S.schoolId, 'reopen-shared');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
    await expect(migrateSharedToDedicated(deps, S.schoolId)).rejects.toThrow(/not empty/); // never silently overwrites
    expect((await state(S.schoolId)).db_mode).toBe('shared');
    await migrateSharedToDedicated(deps, S.schoolId, { resetTarget: true });
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
  });

  it('a target that no longer matches the source is never cut over: only reopen-shared is allowed', async () => {
    const S = await seed(h, 'mrc7');
    crash(S.schoolId, 'after-commit');
    await targetRows(S.schoolId, `UPDATE students SET full_name = full_name || ' (tampered)' WHERE true RETURNING 1`);
    const ins = await inspectMaintenance(deps, S.schoolId);
    expect(ins.verification?.all_match).toBe(false);
    expect(ins.verification?.mismatched).toContain('students');
    expect(ins.recommendation).toBe('reopen-shared');
    expect(ins.allowed_actions).toEqual(['reopen-shared']);
    await expect(recoverMaintenance(deps, S.schoolId, 'complete-cutover')).rejects.toThrow(/not allowed/);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'maintenance' });
  });

  it('school absent from the shared database (registered but never in shared) → manual_review, no action allowed', async () => {
    const { id } = await registerNew(f, 'mrc8');
    await f.control.query(`UPDATE schools SET db_mode = 'shared', status = 'maintenance' WHERE id = $1`, [id]);
    const ins = await inspectMaintenance(deps, id);
    expect(ins.shared_source_intact).toBe(false);
    expect(ins.recommendation).toBe('manual_review');
    expect(ins.allowed_actions).toEqual([]);
    for (const a of ['reopen-shared', 'complete-cutover', 'reopen-dedicated'] as const)
      await expect(recoverMaintenance(deps, id, a)).rejects.toThrow(/not allowed/);
    expect((await state(id)).status).toBe('maintenance');
  });

  it('a school that is not in maintenance has nothing to recover', async () => {
    const S = await seed(h, 'mrc9');
    const ins = await inspectMaintenance(deps, S.schoolId);
    expect(ins.recommendation).toBe('not_in_maintenance');
    await expect(recoverMaintenance(deps, S.schoolId, 'reopen-shared')).rejects.toThrow(/not allowed/);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
  });

  it('dedicated school stuck in maintenance: reopen-dedicated only when the dedicated DB holds the school', async () => {
    const S = await seed(h, 'mrc10');
    await migrateSharedToDedicated(deps, S.schoolId);
    await f.control.query(`UPDATE schools SET status = 'maintenance' WHERE id = $1`, [S.schoolId]);
    const ins = await inspectMaintenance(deps, S.schoolId);
    expect(ins.recommendation).toBe('reopen-dedicated');
    await expect(recoverMaintenance(deps, S.schoolId, 'reopen-shared')).rejects.toThrow(/not allowed/);
    await recoverMaintenance(deps, S.schoolId, 'reopen-dedicated');
    expect(await state(S.schoolId)).toEqual({ db_mode: 'dedicated', status: 'active' });
  });

  it('an error between commit and cut-over keeps the target and reports it; the registry is reopened on shared', async () => {
    const S = await seed(h, 'mrc11');
    await expect(
      migrateSharedToDedicated(
        {
          ...deps,
          afterCommit: () => {
            throw new Error('control plane unavailable');
          },
        },
        S.schoolId,
      ),
    ).rejects.toThrow(/control plane unavailable/);
    expect(await state(S.schoolId)).toEqual({ db_mode: 'shared', status: 'active' });
    const err = (await f.control.query(`SELECT provisioning_error FROM schools WHERE id = $1`, [S.schoolId])).rows[0].provisioning_error as string;
    expect(err).toMatch(/after the copy was committed \(target kept\)/);
    expect((await targetRows(S.schoolId, `SELECT count(*)::int AS n FROM schools`))[0].n).toBe(1);
  });
});
