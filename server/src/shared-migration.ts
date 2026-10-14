import pg from 'pg';
import type { Db } from './db.js';
import { dbNameFor, provisionSchool, urlForDb, type ProvisionDeps } from './provisioning.js';
import { platformAudit } from './registry.js';
import { REGISTRY_COLUMNS, type RegistryEntry } from './tenancy.js';

/**
 * Controlled migration of a Phase 1 school from the shared database into its own dedicated database,
 * plus the rollback path. Shared mode exists ONLY for this purpose (see docs/DATABASE_ISOLATION.md).
 */
export interface MigrationDeps extends ProvisionDeps {
  /** Owner/privileged connection URL of the SHARED school database (read-only use). */
  sharedOwnerUrl: string;
  /** Wait for API instances to drop cached registry rows after maintenance starts (>= ENTITLEMENT_CACHE_SECONDS). */
  quiesceMs?: number;
  /** Test hook invoked after each table copy; throw to simulate a failure. */
  afterTable?: (table: string) => void | Promise<void>;
  /** Test hook: runs after copy, before verification. */
  beforeVerify?: (target: pg.Client) => void | Promise<void>;
  /** Test hook: runs after the copy was committed and before the registry cut-over (a crash here is the nastiest interruption). */
  afterCommit?: () => void | Promise<void>;
}

interface TableSpec {
  table: string;
  /** Source-side WHERE clause; $1 = school id. */
  where: string;
  order: string;
}

// Foreign-key order. `users` is handled separately.
export const COPY_ORDER: TableSpec[] = [
  { table: 'schools', where: 'id = $1', order: 'id' },
  { table: 'school_memberships', where: 'school_id = $1', order: 'id' },
  { table: 'academic_years', where: 'school_id = $1', order: 'id' },
  { table: 'classes', where: 'school_id = $1', order: 'id' },
  { table: 'sections', where: 'school_id = $1', order: 'id' },
  { table: 'subjects', where: 'school_id = $1', order: 'id' },
  { table: 'students', where: 'school_id = $1', order: 'id' },
  { table: 'guardian_profiles', where: 'school_id = $1', order: 'id' },
  { table: 'student_guardians', where: 'school_id = $1', order: 'id' },
  { table: 'enrollments', where: 'school_id = $1', order: 'id' },
  { table: 'teacher_assignments', where: 'school_id = $1', order: 'id' },
  { table: 'grading_policies', where: 'school_id = $1', order: 'id' },
  { table: 'exams', where: 'school_id = $1', order: 'id' },
  { table: 'exam_subjects', where: 'school_id = $1', order: 'exam_id, subject_id' },
  { table: 'result_sheets', where: 'school_id = $1', order: 'id' },
  { table: 'marks', where: 'school_id = $1', order: 'id' },
  { table: 'result_events', where: 'school_id = $1', order: 'id' },
  { table: 'result_versions', where: 'school_id = $1', order: 'id' },
  { table: 'published_results', where: 'school_id = $1', order: 'id' },
  { table: 'audit_events', where: 'school_id = $1', order: 'id' },
];

// Every column that may reference a user, so referenced users (even removed members or Phase 1 platform admins) can be carried over safely.
const USER_REFS = `
  SELECT user_id AS uid FROM school_memberships WHERE school_id = $1
  UNION SELECT user_id FROM teacher_assignments WHERE school_id = $1
  UNION SELECT user_id FROM guardian_profiles WHERE school_id = $1
  UNION SELECT verified_by FROM student_guardians WHERE school_id = $1
  UNION SELECT created_by FROM grading_policies WHERE school_id = $1
  UNION SELECT created_by FROM exams WHERE school_id = $1
  UNION SELECT submitted_by FROM result_sheets WHERE school_id = $1
  UNION SELECT reviewer_id FROM result_sheets WHERE school_id = $1
  UNION SELECT created_by FROM result_sheets WHERE school_id = $1
  UNION SELECT updated_by FROM marks WHERE school_id = $1
  UNION SELECT actor_user_id FROM result_events WHERE school_id = $1
  UNION SELECT created_by FROM result_versions WHERE school_id = $1
  UNION SELECT actor_user_id FROM audit_events WHERE school_id = $1`;

const usersSql = `SELECT * FROM users WHERE id IN (SELECT uid FROM (${USER_REFS}) r WHERE uid IS NOT NULL)`;

const CHUNK = 500;

async function loadEntry(control: Db, id: string): Promise<RegistryEntry> {
  const { rows } = await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error('school not found');
  return rows[0] as RegistryEntry;
}

async function digest(c: pg.Client, table: string, where: string, order: string, params: unknown[]): Promise<{ n: number; md5: string }> {
  const r = await c.query(
    `SELECT count(*)::int AS n, coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY ${order.replace(/(\w+)/g, 't.$1')})), '') AS md5 FROM ${table} t WHERE ${where}`,
    params,
  );
  return r.rows[0];
}

export class MigrationBusyError extends Error {
  constructor() {
    super('another migration or recovery holds the lock for this school');
  }
}

/**
 * Per-school advisory lock held on a dedicated control-plane connection for the WHOLE lifecycle (provisioning of the
 * target, maintenance window, copy, verification, cut-over, recovery, rollback). Session-level, so it is released
 * automatically if the process dies. Fails fast instead of waiting.
 */
async function withMigrationLock<T>(control: Db, schoolId: string, fn: () => Promise<T>): Promise<T> {
  const conn = await control.connect();
  try {
    const got = (await conn.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`migrate:${schoolId}`])).rows[0].ok as boolean;
    if (!got) throw new MigrationBusyError();
    try {
      return await fn();
    } finally {
      await conn.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`migrate:${schoolId}`]).catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}

export interface CopyVerification {
  ok: boolean;
  tables: { table: string; rows: number; match: boolean }[];
  users_match: boolean;
  mismatched: string[];
}

/** Compares the shared source (school slice) with the dedicated target: row counts and content digests per table, plus users. */
export async function verifyCopy(src: pg.Client, dst: pg.Client, schoolId: string): Promise<CopyVerification> {
  const tables: CopyVerification['tables'] = [];
  for (const t of COPY_ORDER) {
    const a = await digest(src, t.table, t.where, t.order, [schoolId]);
    const b = await digest(dst, t.table, '$1::uuid IS NOT NULL', t.order, [schoolId]);
    tables.push({ table: t.table, rows: b.n, match: a.n === b.n && a.md5 === b.md5 });
  }
  const uSrc = (await src.query(`SELECT count(*)::int AS n FROM (${usersSql}) u`, [schoolId])).rows[0].n;
  const uDst = (await dst.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
  const usersMatch = uSrc === uDst;
  const mismatched = tables.filter((t) => !t.match).map((t) => t.table);
  if (!usersMatch) mismatched.push('users');
  return { ok: mismatched.length === 0, tables, users_match: usersMatch, mismatched };
}

export interface MigrationReport {
  schoolId: string;
  tables: { table: string; rows: number; match: boolean }[];
  users: number;
}

async function migrateLocked(d: MigrationDeps, schoolId: string, opts: { actorId?: string | null; resetTarget?: boolean }): Promise<MigrationReport> {
  let entry = await loadEntry(d.control, schoolId);
  if (entry.db_mode !== 'shared') throw new Error('school is not in shared mode');
  if (entry.status !== 'active') throw new Error(`school must be active to migrate (is "${entry.status}")`);

  // 1. Prepare the empty dedicated database (idempotent). No initial data: it is copied from the shared database.
  await provisionSchool(d, schoolId, { seed: false, actorId: opts.actorId });
  entry = await loadEntry(d.control, schoolId);

  // 2. Maintenance window: no traffic while data is copied, so the copy is consistent.
  await d.control.query(`UPDATE schools SET status = 'maintenance' WHERE id = $1 AND status = 'active'`, [schoolId]);
  if (d.quiesceMs) await new Promise((r) => setTimeout(r, d.quiesceMs));

  const src = new pg.Client({ connectionString: d.sharedOwnerUrl });
  const dst = new pg.Client({ connectionString: urlForDb(d.adminUrl, dbNameFor(schoolId)) });
  let guardDisabled = false;
  let committed = false;
  try {
    await src.connect();
    await dst.connect();
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (!(await src.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId])).rowCount) throw new Error('school not found in the shared database');

    const existing = (await dst.query(`SELECT count(*)::int AS n FROM schools`)).rows[0].n;
    if (existing > 0) {
      if (!opts.resetTarget) throw new Error('target database is not empty; re-run with reset to discard the previous partial copy');
      await dst.query(
        `TRUNCATE ${[...COPY_ORDER]
          .reverse()
          .map((t) => t.table)
          .join(', ')}, users CASCADE`,
      );
    }

    await dst.query('BEGIN');
    // The marks trigger forbids inserting marks of locked/published sheets; the copy is a faithful restore, so suspend it only here.
    await dst.query('ALTER TABLE marks DISABLE TRIGGER marks_guard_trg');
    guardDisabled = true;

    // users first (referenced everywhere). Credentials only move for real members; referenced-only accounts become disabled stubs.
    const members = new Set((await src.query(`SELECT user_id FROM school_memberships WHERE school_id = $1`, [schoolId])).rows.map((r) => r.user_id));
    const users = (await src.query(`SELECT to_jsonb(u) AS j FROM (${usersSql}) u ORDER BY (u.id)`, [schoolId])).rows.map((r) => {
      const j = r.j;
      j.is_platform_admin = false;
      if (!members.has(j.id)) {
        j.status = 'disabled';
        j.password_hash = '!';
      }
      j.failed_login_count = 0;
      j.locked_until = null;
      return j;
    });
    for (let i = 0; i < users.length; i += CHUNK)
      await dst.query(`INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, $1::jsonb)`, [JSON.stringify(users.slice(i, i + CHUNK))]);

    const report: MigrationReport = { schoolId, tables: [], users: users.length };
    for (const t of COPY_ORDER) {
      const rows = (await src.query(`SELECT to_jsonb(t) AS j FROM ${t.table} t WHERE ${t.where} ORDER BY ${t.order}`, [schoolId])).rows.map((r) => r.j);
      for (let i = 0; i < rows.length; i += CHUNK)
        await dst.query(`INSERT INTO ${t.table} SELECT * FROM jsonb_populate_recordset(NULL::${t.table}, $1::jsonb)`, [
          JSON.stringify(rows.slice(i, i + CHUNK)),
        ]);
      await d.afterTable?.(t.table);
    }
    await d.beforeVerify?.(dst);

    // 3. Verify row counts and content digests table by table.
    const v = await verifyCopy(src, dst, schoolId);
    report.tables = v.tables;
    if (!v.ok) throw new Error(`verification failed: ${v.mismatched.join(', ')}`);

    await dst.query('ALTER TABLE marks ENABLE TRIGGER marks_guard_trg');
    guardDisabled = false;
    await dst.query('COMMIT');
    committed = true;
    await src.query('ROLLBACK');
    await d.afterCommit?.();

    // 4. Cutover: the registry flips atomically. The shared data is left untouched as the rollback copy.
    await d.control.query(
      `UPDATE schools SET db_mode = 'dedicated', status = 'active', migrated_from_shared_at = now(), provisioning_error = NULL WHERE id = $1 AND db_mode = 'shared'`,
      [schoolId],
    );
    await platformAudit(d.control, {
      actorId: opts.actorId ?? null,
      schoolId,
      action: 'school.migrated_to_dedicated',
      entityType: 'school',
      entityId: schoolId,
      metadata: { tables: report.tables },
    });
    return report;
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => undefined);
    if (guardDisabled) await dst.query('ALTER TABLE marks ENABLE TRIGGER marks_guard_trg').catch(() => undefined);
    await src.query('ROLLBACK').catch(() => undefined);
    // Still shared and serving: reopen it. Before the commit the partial copy was rolled back with the transaction; after the commit
    // (cut-over failed) the complete copy stays in the target, and the next attempt needs resetTarget or `petra migration-recover`.
    await d.control.query(`UPDATE schools SET status = 'active', provisioning_error = $2 WHERE id = $1 AND db_mode = 'shared'`, [
      schoolId,
      `shared→dedicated migration failed${committed ? ' after the copy was committed (target kept)' : ''}: ${(err as Error).message}`.slice(0, 500),
    ]);
    throw err;
  } finally {
    await src.end().catch(() => undefined);
    await dst.end().catch(() => undefined);
  }
}

/** See the file header. Holds the per-school migration lock from the first step to the cut-over; a second concurrent call fails with MigrationBusyError. */
export async function migrateSharedToDedicated(
  d: MigrationDeps,
  schoolId: string,
  opts: { actorId?: string | null; resetTarget?: boolean } = {},
): Promise<MigrationReport> {
  return withMigrationLock(d.control, schoolId, () => migrateLocked(d, schoolId, opts));
}

/**
 * Returns a migrated school to the shared database. Refused if the dedicated database has accepted writes since
 * cutover (they would be lost), unless acceptDataLoss is given explicitly.
 */
async function rollbackLocked(
  d: MigrationDeps,
  schoolId: string,
  opts: { acceptDataLoss?: boolean; actorId?: string | null },
): Promise<{ writes_since_cutover: number }> {
  const entry = await loadEntry(d.control, schoolId);
  if (entry.db_mode !== 'dedicated' || !entry.migrated_from_shared_at) throw new Error('school was not migrated from the shared database');
  const src = new pg.Client({ connectionString: d.sharedOwnerUrl });
  await src.connect();
  const dst = new pg.Client({ connectionString: urlForDb(d.adminUrl, dbNameFor(schoolId)) });
  await dst.connect();
  try {
    if (!(await src.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId])).rowCount)
      throw new Error('the shared copy no longer exists; rollback is impossible');
    const writes = (await dst.query(`SELECT count(*)::int AS n FROM audit_events WHERE created_at > $1`, [entry.migrated_from_shared_at])).rows[0].n as number;
    if (writes > 0 && !opts.acceptDataLoss)
      throw new Error(`${writes} audited write(s) happened in the dedicated database since cutover; rollback would lose them`);
    await d.control.query(`UPDATE schools SET db_mode = 'shared', migrated_from_shared_at = NULL WHERE id = $1`, [schoolId]);
    await platformAudit(d.control, {
      actorId: opts.actorId ?? null,
      schoolId,
      action: 'school.rolled_back_to_shared',
      entityType: 'school',
      entityId: schoolId,
      metadata: { writes_lost: writes },
    });
    return { writes_since_cutover: writes };
  } finally {
    await src.end();
    await dst.end();
  }
}

export async function rollbackToShared(
  d: MigrationDeps,
  schoolId: string,
  opts: { acceptDataLoss?: boolean; actorId?: string | null } = {},
): Promise<{ writes_since_cutover: number }> {
  return withMigrationLock(d.control, schoolId, () => rollbackLocked(d, schoolId, opts));
}

/** Copies active Phase 1 platform administrators from the shared database into the control plane (credentials move; accounts are not duplicated). */
export async function importPlatformAdmins(control: Db, sharedOwnerUrl: string): Promise<{ imported: number }> {
  const src = new pg.Client({ connectionString: sharedOwnerUrl });
  await src.connect();
  try {
    const { rows } = await src.query(`SELECT email::text AS email, password_hash, full_name FROM users WHERE is_platform_admin AND status = 'active'`);
    let imported = 0;
    for (const r of rows) {
      const u = await control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`, [
        r.email,
        r.password_hash,
        r.full_name,
      ]);
      imported += u.rowCount ?? 0;
    }
    return { imported };
  } finally {
    await src.end();
  }
}

// ------------------------------------------------------------------------------------------------ maintenance recovery
export type RecoveryAction = 'reopen-shared' | 'complete-cutover' | 'reopen-dedicated';

export interface MaintenanceInspection {
  slug: string;
  status: string;
  db_mode: 'shared' | 'dedicated';
  /** False when another migration/recovery is running (then nothing else is inspected or allowed). */
  lock_free: boolean;
  shared_source_intact: boolean;
  target: { exists: boolean; has_school_row: boolean };
  /** Result of comparing source and target (only when both exist and the target holds the school). */
  verification: { all_match: boolean; mismatched: string[] } | null;
  /** The only actions recoverMaintenance will accept right now. */
  allowed_actions: RecoveryAction[];
  recommendation: RecoveryAction | 'not_in_maintenance' | 'migration_in_progress' | 'manual_review';
  reason: string;
}

async function inspectLocked(d: MigrationDeps, schoolId: string): Promise<MaintenanceInspection> {
  const e = await loadEntry(d.control, schoolId);
  const base = {
    slug: e.slug,
    status: e.status,
    db_mode: e.db_mode,
    lock_free: true,
    shared_source_intact: false,
    target: { exists: false, has_school_row: false },
    verification: null,
    allowed_actions: [] as RecoveryAction[],
  };
  if (e.status !== 'maintenance')
    return { ...base, recommendation: 'not_in_maintenance', reason: `school is "${e.status}", not in maintenance; nothing to recover` };

  const src = new pg.Client({ connectionString: d.sharedOwnerUrl });
  await src.connect();
  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  let dst: pg.Client | null = null;
  try {
    base.shared_source_intact = ((await src.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId])).rowCount ?? 0) > 0;
    const dbName = e.db_name ?? dbNameFor(schoolId);
    base.target.exists = ((await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName])).rowCount ?? 0) > 0;
    if (base.target.exists) {
      dst = new pg.Client({ connectionString: urlForDb(d.adminUrl, dbName) });
      await dst.connect();
      base.target.has_school_row = ((await dst.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId]).catch(() => ({ rowCount: 0 }))).rowCount ?? 0) > 0;
    }
    if (e.db_mode === 'dedicated') {
      // Cut-over already recorded; the school was left in maintenance (e.g. a rollback or an operator action was interrupted).
      return base.target.has_school_row
        ? {
            ...base,
            allowed_actions: ['reopen-dedicated'],
            recommendation: 'reopen-dedicated',
            reason: 'registry already points at the dedicated database and it holds the school; reopening discards nothing',
          }
        : {
            ...base,
            recommendation: 'manual_review',
            reason: 'registry points at a dedicated database that is missing or empty; restore from backup before reopening',
          };
    }
    if (!base.shared_source_intact) {
      return {
        ...base,
        recommendation: 'manual_review',
        reason: 'the school is missing from the shared database; neither reopening nor cut-over is safe without a manual review',
      };
    }
    if (base.target.has_school_row && dst) {
      await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const v = await verifyCopy(src, dst, schoolId);
      await src.query('ROLLBACK');
      const verification = { all_match: v.ok, mismatched: v.mismatched };
      if (v.ok) {
        return {
          ...base,
          verification,
          allowed_actions: ['complete-cutover', 'reopen-shared'],
          recommendation: 'complete-cutover',
          reason: 'a complete, verified copy exists in the target (interruption after the commit, before the registry cut-over); both actions lose nothing',
        };
      }
      return {
        ...base,
        verification,
        allowed_actions: ['reopen-shared'],
        recommendation: 'reopen-shared',
        reason:
          'the target does not match the shared source; the shared database is still authoritative (cut-over was never recorded). Reopen on shared and re-run the migration with --reset-target',
      };
    }
    return {
      ...base,
      allowed_actions: ['reopen-shared'],
      recommendation: 'reopen-shared',
      reason: base.target.exists
        ? 'the target holds no school data (the copy never committed); the shared database is authoritative'
        : 'no dedicated database exists yet; the shared database is authoritative',
    };
  } finally {
    await src.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await dst?.end().catch(() => undefined);
  }
}

/** Read-only report of what state a school left in `maintenance` is really in. Changes nothing. */
export async function inspectMaintenance(d: MigrationDeps, schoolId: string): Promise<MaintenanceInspection> {
  try {
    return await withMigrationLock(d.control, schoolId, () => inspectLocked(d, schoolId));
  } catch (e) {
    if (!(e instanceof MigrationBusyError)) throw e;
    const s = await loadEntry(d.control, schoolId);
    return {
      slug: s.slug,
      status: s.status,
      db_mode: s.db_mode,
      lock_free: false,
      shared_source_intact: false,
      target: { exists: false, has_school_row: false },
      verification: null,
      allowed_actions: [],
      recommendation: 'migration_in_progress',
      reason: 'another migration or recovery holds the lock; wait for it to finish',
    };
  }
}

/**
 * Explicitly recovers a school left in `maintenance`. The caller names the action; it is executed only if the CURRENT, freshly
 * inspected state allows it (inspection and action run under the same per-school lock). Nothing is ever deleted or overwritten:
 * `reopen-*` only change the registry status, `complete-cutover` additionally records the dedicated mode after a full re-verification.
 */
export async function recoverMaintenance(
  d: MigrationDeps,
  schoolId: string,
  action: RecoveryAction,
  actorId: string | null = null,
): Promise<MaintenanceInspection> {
  return withMigrationLock(d.control, schoolId, async () => {
    const inspection = await inspectLocked(d, schoolId);
    if (!inspection.allowed_actions.includes(action)) {
      throw new Error(`action "${action}" is not allowed: ${inspection.reason} (allowed: ${inspection.allowed_actions.join(', ') || 'none'})`);
    }
    if (action === 'complete-cutover') {
      await d.control.query(
        `UPDATE schools SET db_mode = 'dedicated', status = 'active', migrated_from_shared_at = now(), provisioning_error = NULL WHERE id = $1 AND db_mode = 'shared' AND status = 'maintenance'`,
        [schoolId],
      );
    } else {
      await d.control.query(`UPDATE schools SET status = 'active', provisioning_error = NULL WHERE id = $1 AND status = 'maintenance'`, [schoolId]);
    }
    await platformAudit(d.control, {
      actorId,
      schoolId,
      action: `school.maintenance_recovered.${action}`,
      entityType: 'school',
      entityId: schoolId,
      metadata: { inspection },
    });
    return inspection;
  });
}
