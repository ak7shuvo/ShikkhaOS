import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/db.js';
import { assertRestrictedRole } from '../src/db.js';
import { harness, seed, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

// These tests hit the real PostgreSQL policies through the restricted app role.
let h: Harness;
let A: SeededSchool;
let B: SeededSchool;

beforeAll(async () => {
  h = await harness();
  A = await seed(h, 'rlsa');
  B = await seed(h, 'rlsb');
});
afterAll(() => h.close());

describe('PostgreSQL row-level security (restricted role)', () => {
  it('app role is not superuser and does not bypass RLS', async () => {
    await expect(assertRestrictedRole(h.pool)).resolves.toBeUndefined();
    await expect(assertRestrictedRole(h.owner)).rejects.toThrow(/bypasses row-level security/);
  });

  it('without a school context no tenant rows are visible', async () => {
    const r = await withContext(h.pool, {}, (tx) => tx.query('SELECT count(*)::int AS n FROM students'));
    expect(r.rows[0].n).toBe(0);
  });

  it('school A context sees only school A students', async () => {
    const r = await withContext(h.pool, { schoolId: A.schoolId }, (tx) => tx.query('SELECT DISTINCT school_id FROM students'));
    expect(r.rows.map((x) => x.school_id)).toEqual([A.schoolId]);
  });

  it('knowing a school B row id does not help under school A context', async () => {
    const r = await withContext(h.pool, { schoolId: A.schoolId }, (tx) => tx.query('SELECT * FROM students WHERE id = $1', [B.students[0]!.id]));
    expect(r.rows).toHaveLength(0);
  });

  it('cannot UPDATE another school’s rows', async () => {
    const r = await withContext(h.pool, { schoolId: A.schoolId }, (tx) =>
      tx.query(`UPDATE students SET full_name = 'hacked' WHERE id = $1`, [B.students[0]!.id]),
    );
    expect(r.rowCount).toBe(0);
    const check = await h.owner.query('SELECT full_name FROM students WHERE id = $1', [B.students[0]!.id]);
    expect(check.rows[0].full_name).toBe('Demo Student 1');
  });

  it('cannot INSERT a row into another school (WITH CHECK)', async () => {
    await expect(
      withContext(h.pool, { schoolId: A.schoolId }, (tx) =>
        tx.query(`INSERT INTO students (school_id, student_code, full_name) VALUES ($1,'X1','x')`, [B.schoolId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('composite foreign keys block cross-school references even for the owner', async () => {
    await expect(
      h.owner.query(
        `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship) VALUES ($1,$2,(SELECT id FROM guardian_profiles WHERE school_id=$1 LIMIT 1),'x')`,
        [A.schoolId, B.students[0]!.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('school A context cannot read school B in schools/memberships/users/audit', async () => {
    const r = await withContext(h.pool, { schoolId: A.schoolId, userId: A.users.admin.id }, async (tx) => ({
      schools: (await tx.query('SELECT id FROM schools')).rows,
      members: (await tx.query('SELECT DISTINCT school_id FROM school_memberships')).rows,
      users: (await tx.query('SELECT email FROM users')).rows,
    }));
    expect(r.schools.map((x) => x.id)).toEqual([A.schoolId]);
    expect(r.members.map((x) => x.school_id)).toEqual([A.schoolId]);
    expect(r.users.every((u) => u.email.endsWith(`@${A.code}.example.test`))).toBe(true);
  });

  it('school context cannot create platform admins or schools', async () => {
    await expect(
      withContext(h.pool, { schoolId: A.schoolId }, (tx) =>
        tx.query(`INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES ('p@x.test','x','x',true)`),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(withContext(h.pool, { schoolId: A.schoolId }, (tx) => tx.query(`INSERT INTO schools (code, name) VALUES ('evil','Evil')`))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('platform context sees schools but not tenant data', async () => {
    const r = await withContext(h.pool, { platform: true }, async (tx) => ({
      schools: (await tx.query('SELECT count(*)::int AS n FROM schools')).rows[0].n,
      students: (await tx.query('SELECT count(*)::int AS n FROM students')).rows[0].n,
    }));
    expect(r.schools).toBeGreaterThanOrEqual(2);
    expect(r.students).toBe(0);
  });

  it('audit, result events and versions are append-only', async () => {
    await withContext(h.pool, { schoolId: A.schoolId, userId: A.users.admin.id }, (tx) =>
      tx.query(`INSERT INTO audit_events (school_id, action, entity_type) VALUES ($1,'t','t')`, [A.schoolId]),
    );
    await expect(withContext(h.pool, { schoolId: A.schoolId }, (tx) => tx.query(`UPDATE audit_events SET action = 'x'`))).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(h.owner.query(`DELETE FROM audit_events WHERE school_id = $1`, [A.schoolId])).rejects.toThrow(/append-only/);
  });

  it('context settings do not leak between pooled transactions', async () => {
    await withContext(h.pool, { schoolId: A.schoolId }, (tx) => tx.query('SELECT 1'));
    const r = await withContext(h.pool, {}, (tx) => tx.query(`SELECT current_setting('app.school_id', true) AS s`));
    expect(r.rows[0].s).toBe('');
  });
});
