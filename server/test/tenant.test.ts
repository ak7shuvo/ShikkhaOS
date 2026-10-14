import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillSheet, harness, loginAs, seed, type Client, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let A: SeededSchool;
let B: SeededSchool;
let adminA: Client;
let teacherA: Client;
let ctrlA: Client;
let sheetB: string;

beforeAll(async () => {
  h = await harness();
  A = await seed(h, 'ta');
  B = await seed(h, 'tb');
  adminA = await loginAs(h, A.users.admin.email);
  teacherA = await loginAs(h, A.users.teacher.email);
  ctrlA = await loginAs(h, A.users.controller.email);
  // School B has a real sheet in draft with data.
  const teacherB = await loginAs(h, B.users.teacher.email);
  sheetB = (await fillSheet(h, teacherB, B)).sheetId;
});
afterAll(() => h.close());

describe('cross-tenant isolation: School A user vs School B record IDs', () => {
  it('list endpoints never contain School B data', async () => {
    for (const url of [
      '/students',
      '/classes',
      '/subjects',
      '/exams',
      '/academic-years',
      '/guardians',
      '/teacher-assignments',
      '/result-sheets',
      '/school/members',
      '/school/audit',
      '/school/grading-policies',
    ]) {
      const r = await adminA.get(url);
      const ctrl = r.status === 200 ? r : await ctrlA.get(url);
      const text = JSON.stringify(ctrl.body);
      expect(text, url).not.toContain(B.schoolId);
      for (const s of B.students) expect(text, url).not.toContain(s.id);
      expect(text, url).not.toContain(B.examId);
      expect(text, url).not.toContain(`@${B.code}.example.test`);
    }
  });

  it('cannot read a School B result sheet by ID (404, not 403)', async () => {
    for (const c of [ctrlA, teacherA, adminA]) {
      expect((await c.get(`/result-sheets/${sheetB}`)).status).toBe(404);
      expect((await c.get(`/result-sheets/${sheetB}/history`)).status).toBe(404);
    }
  });

  it('cannot write marks to a School B sheet', async () => {
    const r = await teacherA.put(`/result-sheets/${sheetB}/marks`, {
      entries: [{ enrollment_id: B.students[0]!.enrollmentId, obtained: 1, is_absent: false }],
    });
    expect(r.status).toBe(404);
    const { rows } = await h.owner.query(`SELECT obtained FROM marks WHERE sheet_id = $1 AND enrollment_id = $2`, [sheetB, B.students[0]!.enrollmentId]);
    expect(rows[0].obtained).toBe(90);
  });

  it('cannot drive School B workflow transitions', async () => {
    for (const a of ['submit', 'start-review', 'approve', 'publish', 'correction']) {
      const r = await (a === 'submit' ? teacherA : ctrlA).post(`/result-sheets/${sheetB}/${a}`, { reason: 'because' });
      expect(r.status, a).toBe(404);
    }
    const { rows } = await h.owner.query(`SELECT status FROM result_sheets WHERE id = $1`, [sheetB]);
    expect(rows[0].status).toBe('draft');
  });

  it('cannot create sheets for School B exam/section/subject', async () => {
    const r = await teacherA.post('/result-sheets', { exam_id: B.examId, subject_id: B.subjectIds.bangla, section_id: B.sectionId });
    expect(r.status).toBe(400);
  });

  it('cannot enroll a School A student into a School B section, or vice versa', async () => {
    const r = await adminA.post(`/students/${A.students[0]!.id}/enrollments`, {
      academic_year_id: B.yearId,
      class_id: B.classId,
      section_id: B.sectionId,
      roll_no: 99,
    });
    expect(r.status).toBe(404);
    const r2 = await adminA.post(`/students/${B.students[0]!.id}/enrollments`, {
      academic_year_id: A.yearId,
      class_id: A.classId,
      section_id: A.sectionId,
      roll_no: 98,
    });
    expect(r2.status).toBe(404);
  });

  it('cannot create exams referencing School B classes/subjects/years', async () => {
    const r = await ctrlA.post('/exams', {
      name: 'Evil',
      academic_year_id: B.yearId,
      class_id: B.classId,
      subjects: [{ subject_id: B.subjectIds.math, max_marks: 100 }],
    });
    expect([404, 409]).toContain(r.status);
    const r2 = await ctrlA.post('/exams', {
      name: 'Evil2',
      academic_year_id: A.yearId,
      class_id: A.classId,
      grading_policy_id: B.policyId,
      subjects: [{ subject_id: A.subjectIds.math, max_marks: 100 }],
    });
    expect(r2.status).toBe(409);
  });

  it('cannot link School B guardian/student, nor verify/revoke School B links', async () => {
    const gB = (await h.owner.query(`SELECT id FROM guardian_profiles WHERE school_id = $1 LIMIT 1`, [B.schoolId])).rows[0].id;
    expect((await adminA.post(`/students/${A.students[2]!.id}/guardians`, { guardian_id: gB, relationship: 'x' })).status).toBe(404);
    expect((await adminA.post(`/students/${B.students[2]!.id}/guardians`, { guardian_id: gB, relationship: 'x' })).status).toBe(404);
    const linkB = (await h.owner.query(`SELECT id FROM student_guardians WHERE school_id = $1 LIMIT 1`, [B.schoolId])).rows[0].id;
    expect((await adminA.post(`/student-guardians/${linkB}/revoke`)).status).toBe(404);
    expect((await h.owner.query(`SELECT status FROM student_guardians WHERE id = $1`, [linkB])).rows[0].status).toBe('verified');
  });

  it('cannot modify School B memberships or teacher assignments', async () => {
    const m = (await h.owner.query(`SELECT id FROM school_memberships WHERE school_id = $1 AND role = 'teacher' LIMIT 1`, [B.schoolId])).rows[0].id;
    expect((await adminA.patch(`/school/members/${m}`, { status: 'removed' })).status).toBe(404);
    expect((await h.owner.query(`SELECT status FROM school_memberships WHERE id = $1`, [m])).rows[0].status).toBe('active');
    const r = await adminA.post('/teacher-assignments', {
      user_id: B.users.teacher.id,
      academic_year_id: A.yearId,
      class_id: A.classId,
      subject_id: A.subjectIds.math,
    });
    expect(r.status).toBe(400);
  });

  it('a client-supplied school_id (body, query, header) is ignored as authority', async () => {
    const r = await adminA.req('PATCH', `/school?school_id=${B.schoolId}`, { name: 'Renamed By A', school_id: B.schoolId } as never, {
      'x-school-id': B.schoolId,
    });
    // unknown key `school_id` is rejected by the strict schema
    expect(r.status).toBe(400);
    const r2 = await adminA.req('PATCH', `/school?school_id=${B.schoolId}`, { name: 'Renamed By A' }, { 'x-school-id': B.schoolId });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(A.schoolId);
    expect((await h.owner.query(`SELECT name FROM schools WHERE id = $1`, [B.schoolId])).rows[0].name).toBe('School tb');
    const g = await adminA.get(`/students?school_id=${B.schoolId}`);
    expect(JSON.stringify(g.body)).not.toContain(B.students[0]!.id);
  });

  it('school admins cannot change platform-level fields', async () => {
    for (const body of [{ status: 'archived' }, { code: 'hijack' }]) {
      expect((await adminA.patch('/school', body)).status).toBe(400);
    }
    expect((await adminA.get('/platform/schools')).status).toBe(403);
    expect((await adminA.req('PUT', `/platform/schools/${A.schoolId}/license`, { plan: 'x', status: 'active', starts_on: '2026-01-01' })).status).toBe(403);
  });

  it('audit trail is per school', async () => {
    const r = await adminA.get('/school/audit');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    const { rows } = await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE school_id = $1 AND id = ANY($2)`, [
      A.schoolId,
      r.body.items.map((i: any) => i.id),
    ]);
    expect(rows[0].n).toBe(r.body.items.length);
  });

  it('role permissions are enforced server-side', async () => {
    expect((await teacherA.post('/students', { student_code: 'T1', full_name: 'x' })).status).toBe(403);
    expect((await teacherA.get('/students')).status).toBe(403);
    expect(
      (
        await teacherA.post('/exams', {
          name: 'x',
          academic_year_id: A.yearId,
          class_id: A.classId,
          subjects: [{ subject_id: A.subjectIds.math, max_marks: 10 }],
        })
      ).status,
    ).toBe(403);
    expect((await ctrlA.post('/classes', { name: 'Nope' })).status).toBe(403);
    expect((await adminA.put('/result-sheets/00000000-0000-4000-8000-000000000000/marks', { entries: [] })).status).toBe(403);
    const guardian = await loginAs(h, A.users.guardian.email);
    expect((await guardian.get('/result-sheets')).status).toBe(403);
    expect((await guardian.get('/school/members')).status).toBe(403);
    expect((await guardian.get('/students')).status).toBe(403);
  });

  it('student role is reserved and cannot be assigned', async () => {
    const r = await adminA.post('/school/members', { email: 'stu@x.example.test', full_name: 'S', initial_password: 'long-enough-pw', role: 'student' });
    expect(r.status).toBe(400);
    const p = await adminA.post('/school/members', {
      email: 'pa@x.example.test',
      full_name: 'S',
      initial_password: 'long-enough-pw',
      role: 'platform_super_admin',
    });
    expect(p.status).toBe(400);
  });
});
