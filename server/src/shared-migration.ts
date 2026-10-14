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
  const r = await c.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY ${order.replace(/(\w+)/g, 't.$1')})), '') AS md5 FROM ${table} t WHERE ${where}`, params);
  return r.rows[0];
}

export interface MigrationReport {
  schoolId: string;
  tables: { table: string; rows: number; match: boolean }[];
  users: number;
}

export async function migrateSharedToDedicated(d: MigrationDeps, schoolId: string, opts: { actorId?: string | null; resetTarget?: boolean } = {}): Promise<MigrationReport> {
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
  await src.connect();
  await dst.connect();
  let guardDisabled = false;
  try {
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (!(await src.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId])).rowCount) throw new Error('school not found in the shared database');

    const existing = (await dst.query(`SELECT count(*)::int AS n FROM schools`)).rows[0].n;
    if (existing > 0) {
      if (!opts.resetTarget) throw new Error('target database is not empty; re-run with reset to discard the previous partial copy');
      await dst.query(`TRUNCATE ${[...COPY_ORDER].reverse().map((t) => t.table).join(', ')}, users CASCADE`);
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
    for (let i = 0; i < users.length; i += CHUNK) await dst.query(`INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, $1::jsonb)`, [JSON.stringify(users.slice(i, i + CHUNK))]);

    const report: MigrationReport = { schoolId, tables: [], users: users.length };
    for (const t of COPY_ORDER) {
      const rows = (await src.query(`SELECT to_jsonb(t) AS j FROM ${t.table} t WHERE ${t.where} ORDER BY ${t.order}`, [schoolId])).rows.map((r) => r.j);
      for (let i = 0; i < rows.length; i += CHUNK) await dst.query(`INSERT INTO ${t.table} SELECT * FROM jsonb_populate_recordset(NULL::${t.table}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + CHUNK))]);
      await d.afterTable?.(t.table);
    }
    await d.beforeVerify?.(dst);

    // 3. Verify row counts and content digests table by table.
    let allOk = true;
    for (const t of COPY_ORDER) {
      const a = await digest(src, t.table, t.where, t.order, [schoolId]);
      const b = await digest(dst, t.table, '$1::uuid IS NOT NULL', t.order, [schoolId]);
      const match = a.n === b.n && a.md5 === b.md5;
      allOk &&= match;
      report.tables.push({ table: t.table, rows: b.n, match });
    }
    const uSrc = (await src.query(`SELECT count(*)::int AS n FROM (${usersSql}) u`, [schoolId])).rows[0].n;
    const uDst = (await dst.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
    if (uSrc !== uDst) allOk = false;
    if (!allOk) throw new Error(`verification failed: ${report.tables.filter((t) => !t.match).map((t) => t.table).join(', ') || 'users'}`);

    await dst.query('ALTER TABLE marks ENABLE TRIGGER marks_guard_trg');
    guardDisabled = false;
    await dst.query('COMMIT');
    await src.query('ROLLBACK');

    // 4. Cutover: the registry flips atomically. The shared data is left untouched as the rollback copy.
    await d.control.query(`UPDATE schools SET db_mode = 'dedicated', status = 'active', migrated_from_shared_at = now(), provisioning_error = NULL WHERE id = $1 AND db_mode = 'shared'`, [schoolId]);
    await platformAudit(d.control, { actorId: opts.actorId ?? null, schoolId, action: 'school.migrated_to_dedicated', entityType: 'school', entityId: schoolId, metadata: { tables: report.tables } });
    return report;
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => undefined);
    if (guardDisabled) await dst.query('ALTER TABLE marks ENABLE TRIGGER marks_guard_trg').catch(() => undefined);
    await src.query('ROLLBACK').catch(() => undefined);
    // Still shared and serving: reopen it. The partial copy was rolled back with the transaction.
    await d.control.query(`UPDATE schools SET status = 'active', provisioning_error = $2 WHERE id = $1 AND db_mode = 'shared'`, [schoolId, `shared→dedicated migration failed: ${(err as Error).message}`.slice(0, 500)]);
    throw err;
  } finally {
    await src.end().catch(() => undefined);
    await dst.end().catch(() => undefined);
  }
}

/**
 * Returns a migrated school to the shared database. Refused if the dedicated database has accepted writes since
 * cutover (they would be lost), unless acceptDataLoss is given explicitly.
 */
export async function rollbackToShared(d: MigrationDeps, schoolId: string, opts: { acceptDataLoss?: boolean; actorId?: string | null } = {}): Promise<{ writes_since_cutover: number }> {
  const entry = await loadEntry(d.control, schoolId);
  if (entry.db_mode !== 'dedicated' || !entry.migrated_from_shared_at) throw new Error('school was not migrated from the shared database');
  const src = new pg.Client({ connectionString: d.sharedOwnerUrl });
  await src.connect();
  const dst = new pg.Client({ connectionString: urlForDb(d.adminUrl, dbNameFor(schoolId)) });
  await dst.connect();
  try {
    if (!(await src.query(`SELECT 1 FROM schools WHERE id = $1`, [schoolId])).rowCount) throw new Error('the shared copy no longer exists; rollback is impossible');
    const writes = (await dst.query(`SELECT count(*)::int AS n FROM audit_events WHERE created_at > $1`, [entry.migrated_from_shared_at])).rows[0].n as number;
    if (writes > 0 && !opts.acceptDataLoss) throw new Error(`${writes} audited write(s) happened in the dedicated database since cutover; rollback would lose them`);
    await d.control.query(`UPDATE schools SET db_mode = 'shared', migrated_from_shared_at = NULL WHERE id = $1`, [schoolId]);
    await platformAudit(d.control, { actorId: opts.actorId ?? null, schoolId, action: 'school.rolled_back_to_shared', entityType: 'school', entityId: schoolId, metadata: { writes_lost: writes } });
    return { writes_since_cutover: writes };
  } finally {
    await src.end();
    await dst.end();
  }
}

/** Copies active Phase 1 platform administrators from the shared database into the control plane (credentials move; accounts are not duplicated). */
export async function importPlatformAdmins(control: Db, sharedOwnerUrl: string): Promise<{ imported: number }> {
  const src = new pg.Client({ connectionString: sharedOwnerUrl });
  await src.connect();
  try {
    const { rows } = await src.query(`SELECT email::text AS email, password_hash, full_name FROM users WHERE is_platform_admin AND status = 'active'`);
    let imported = 0;
    for (const r of rows) {
      const u = await control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`, [r.email, r.password_hash, r.full_name]);
      imported += u.rowCount ?? 0;
    }
    return { imported };
  } finally {
    await src.end();
  }
}
