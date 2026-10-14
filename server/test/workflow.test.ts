import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillSheet, harness, loginAs, seed, type Client, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let S: SeededSchool;
let teacher: Client, teacher2: Client, ctrl: Client, principal: Client, admin: Client;

beforeAll(async () => {
  h = await harness();
  S = await seed(h, 'wf');
  [teacher, teacher2, ctrl, principal, admin] = await Promise.all([
    loginAs(h, S.users.teacher.email),
    loginAs(h, S.users.teacher2.email),
    loginAs(h, S.users.controller.email),
    loginAs(h, S.users.principal.email),
    loginAs(h, S.users.admin.email),
  ]);
});
afterAll(() => h.close());

const status = async (id: string) => (await h.owner.query('SELECT status, revision FROM result_sheets WHERE id = $1', [id])).rows[0];

describe('marks entry & validation', () => {
  it('requires a teacher assignment to open or edit a sheet', async () => {
    const r = await teacher2.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.bangla, section_id: S.sectionId });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_ASSIGNED');
    // teacher2 is assigned Maths for section B only, not section A
    const r2 = await teacher2.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.math, section_id: S.sectionId });
    expect(r2.status).toBe(403);
    const r3 = await teacher2.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.math, section_id: S.sectionBId });
    expect(r3.status).toBe(201);
  });

  it('opening a sheet is idempotent', async () => {
    const a = await teacher.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.bangla, section_id: S.sectionId });
    const b = await teacher.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.bangla, section_id: S.sectionId });
    expect(a.body.id).toBe(b.body.id);
    expect(b.status).toBe(200);
    const sheet = await teacher.get(`/result-sheets/${a.body.id}`);
    expect(sheet.body.marks).toHaveLength(4);
    expect(sheet.body.status).toBe('draft');
  });

  it('rejects marks above the maximum, negatives, absent-with-marks, duplicates, bad decimals', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    const e = S.students[0]!.enrollmentId;
    const bad = async (entries: unknown[]) => teacher.put(`/result-sheets/${sheetId}/marks`, { entries });
    expect((await bad([{ enrollment_id: e, obtained: 100.01, is_absent: false }])).status).toBe(400);
    expect((await bad([{ enrollment_id: e, obtained: -1, is_absent: false }])).status).toBe(400);
    expect((await bad([{ enrollment_id: e, obtained: 5, is_absent: true }])).status).toBe(400);
    expect(
      (
        await bad([
          { enrollment_id: e, obtained: 5, is_absent: false },
          { enrollment_id: e, obtained: 6, is_absent: false },
        ])
      ).status,
    ).toBe(400);
    expect((await bad([{ enrollment_id: e, obtained: 5.123, is_absent: false }])).status).toBe(400);
    expect((await bad([{ enrollment_id: e, obtained: '50', is_absent: false }])).status).toBe(400);
    const ok = await bad([{ enrollment_id: e, obtained: 100, is_absent: false }]);
    expect(ok.status).toBe(200);
  });

  it('the database itself rejects over-maximum marks and locked-sheet edits', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    await expect(h.owner.query(`UPDATE marks SET obtained = 101 WHERE sheet_id = $1`, [sheetId])).rejects.toThrow(/exceed maximum/);
    await h.owner.query(`UPDATE result_sheets SET status = 'published' WHERE id = $1`, [sheetId]);
    await expect(h.owner.query(`UPDATE marks SET obtained = 1 WHERE sheet_id = $1`, [sheetId])).rejects.toThrow(/locked/);
  });

  it('rejects enrollments from another section and detects stale edits', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    const foreign = (await h.owner.query(`INSERT INTO students (school_id, student_code, full_name) VALUES ($1,'ZB','Demo B') RETURNING id`, [S.schoolId]))
      .rows[0].id;
    const en = (
      await h.owner.query(
        `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_no) VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
        [S.schoolId, foreign, S.yearId, S.classId, S.sectionBId],
      )
    ).rows[0].id;
    expect((await teacher.put(`/result-sheets/${sheetId}/marks`, { entries: [{ enrollment_id: en, obtained: 5, is_absent: false }] })).status).toBe(400);
    const cur = await teacher.get(`/result-sheets/${sheetId}`);
    const m = cur.body.marks[0];
    const upd = await teacher.put(`/result-sheets/${sheetId}/marks`, {
      entries: [{ enrollment_id: m.enrollment_id, obtained: 11, is_absent: false, expected_version: m.row_version }],
    });
    expect(upd.status).toBe(200);
    const stale = await teacher.put(`/result-sheets/${sheetId}/marks`, {
      entries: [{ enrollment_id: m.enrollment_id, obtained: 12, is_absent: false, expected_version: m.row_version }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_MARK');
  });

  it('records mark changes in the audit trail', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    const { rows } = await h.owner.query(`SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'marks.update'`, [sheetId]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('result approval workflow', () => {
  it('walks Draft → Submitted → Under Review → Approved → Published with a full history', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    expect((await teacher.post(`/result-sheets/${sheetId}/submit`)).status).toBe(200);
    expect((await status(sheetId)).status).toBe('submitted');
    expect((await ctrl.post(`/result-sheets/${sheetId}/start-review`)).status).toBe(200);
    expect((await ctrl.post(`/result-sheets/${sheetId}/approve`)).status).toBe(200);
    expect((await status(sheetId)).status).toBe('approved');
    expect((await principal.post(`/result-sheets/${sheetId}/publish`)).status).toBe(200);
    expect((await status(sheetId)).status).toBe('published');

    const hist = await ctrl.get(`/result-sheets/${sheetId}/history`);
    expect(hist.body.events.map((e: any) => e.action)).toEqual(['create', 'submit', 'start_review', 'approve', 'publish']);
    expect(hist.body.events.every((e: any) => e.actor_name && e.created_at)).toBe(true);
    expect(hist.body.versions.map((v: any) => v.stage)).toEqual(['submitted', 'approved', 'published']);

    const pub = await h.owner.query(`SELECT grade, obtained FROM published_results WHERE sheet_id = $1 ORDER BY obtained DESC`, [sheetId]);
    // development sample bands: >=80 A, >=60 B, >=40 C, else F
    expect(pub.rows.map((r) => r.grade)).toEqual(['A', 'B', 'C', 'F']);
  });

  it('rejects every invalid transition with 409 INVALID_TRANSITION', async () => {
    const { sheetId } = await fillSheet(h, teacher, S);
    const tryIt = async (c: Client, a: string) => await c.post(`/result-sheets/${sheetId}/${a}`, { reason: 'some reason' });
    // from draft
    for (const a of ['start-review', 'approve', 'return', 'publish', 'correction']) {
      const r = await tryIt(ctrl, a);
      expect(r.status, `draft→${a}`).toBe(409);
      expect(r.body.error.code).toBe('INVALID_TRANSITION');
    }
    await teacher.post(`/result-sheets/${sheetId}/submit`);
    // from submitted: cannot approve/return/publish directly, nor submit twice
    for (const [c, a] of [
      [ctrl, 'approve'],
      [ctrl, 'return'],
      [ctrl, 'publish'],
      [teacher, 'submit'],
      [ctrl, 'correction'],
    ] as [Client, string][]) {
      expect((await tryIt(c, a)).status, `submitted→${a}`).toBe(409);
    }
    await ctrl.post(`/result-sheets/${sheetId}/start-review`);
    for (const [c, a] of [
      [ctrl, 'publish'],
      [ctrl, 'start-review'],
      [teacher, 'submit'],
    ] as [Client, string][]) {
      expect((await tryIt(c, a)).status, `under_review→${a}`).toBe(409);
    }
    await ctrl.post(`/result-sheets/${sheetId}/approve`);
    for (const [c, a] of [
      [ctrl, 'return'],
      [ctrl, 'approve'],
      [teacher, 'submit'],
      [ctrl, 'start-review'],
    ] as [Client, string][]) {
      expect((await tryIt(c, a)).status, `approved→${a}`).toBe(409);
    }
    expect((await status(sheetId)).status).toBe('approved');
  });

  it('return requires a reason; returned sheets are editable and can be resubmitted', async () => {
    const exam2 = (
      await ctrl.post('/exams', {
        name: 'Class test',
        academic_year_id: S.yearId,
        class_id: S.classId,
        grading_policy_id: S.policyId,
        subjects: [{ subject_id: S.subjectIds.bangla, max_marks: 20, pass_marks: 7 }],
      })
    ).body.id;
    const open = await teacher.post('/result-sheets', { exam_id: exam2, subject_id: S.subjectIds.bangla, section_id: S.sectionId });
    const id = open.body.id;
    // incomplete marks cannot be submitted
    expect((await teacher.post(`/result-sheets/${id}/submit`)).body.error.code).toBe('INCOMPLETE_MARKS');
    await teacher.put(`/result-sheets/${id}/marks`, {
      entries: S.students.map((s, i) => ({ enrollment_id: s.enrollmentId, obtained: i === 0 ? null : 10, is_absent: i === 0 })),
    });
    expect((await teacher.post(`/result-sheets/${id}/submit`)).status).toBe(200);
    // locked while submitted
    const locked = await teacher.put(`/result-sheets/${id}/marks`, {
      entries: [{ enrollment_id: S.students[1]!.enrollmentId, obtained: 1, is_absent: false }],
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('SHEET_LOCKED');
    await ctrl.post(`/result-sheets/${id}/start-review`);
    const noReason = await ctrl.post(`/result-sheets/${id}/return`);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    expect((await ctrl.post(`/result-sheets/${id}/return`, { reason: '  ' })).status).toBe(400);
    expect((await ctrl.post(`/result-sheets/${id}/return`, { reason: 'Student 3 marks look wrong' })).status).toBe(200);
    expect(
      (await teacher.put(`/result-sheets/${id}/marks`, { entries: [{ enrollment_id: S.students[2]!.enrollmentId, obtained: 12, is_absent: false }] })).status,
    ).toBe(200);
    expect((await teacher.post(`/result-sheets/${id}/submit`)).status).toBe(200);
    const hist = await ctrl.get(`/result-sheets/${id}/history`);
    const ret = hist.body.events.find((e: any) => e.action === 'return');
    expect(ret.reason).toBe('Student 3 marks look wrong');
    expect(hist.body.versions.filter((v: any) => v.stage === 'submitted')).toHaveLength(2);
  });

  it('only authorised roles can submit, review, approve and publish', async () => {
    const exam = (
      await ctrl.post('/exams', {
        name: 'Auth test',
        academic_year_id: S.yearId,
        class_id: S.classId,
        subjects: [{ subject_id: S.subjectIds.bangla, max_marks: 50 }],
      })
    ).body.id;
    const id = (await teacher.post('/result-sheets', { exam_id: exam, subject_id: S.subjectIds.bangla, section_id: S.sectionId })).body.id;
    await teacher.put(`/result-sheets/${id}/marks`, { entries: S.students.map((s) => ({ enrollment_id: s.enrollmentId, obtained: 10, is_absent: false })) });
    // non-teachers cannot submit
    for (const c of [ctrl, principal, admin]) expect((await c.post(`/result-sheets/${id}/submit`)).status).toBe(403);
    // a teacher not assigned to this subject cannot submit
    expect((await teacher2.post(`/result-sheets/${id}/submit`)).status).toBe(403);
    expect((await teacher.post(`/result-sheets/${id}/submit`)).status).toBe(200);
    // teachers and admins cannot review/approve/publish
    for (const c of [teacher, admin, teacher2])
      for (const a of ['start-review', 'approve', 'return', 'publish', 'correction']) {
        expect((await c.post(`/result-sheets/${id}/${a}`, { reason: 'try it' })).status, a).toBe(403);
      }
    await ctrl.post(`/result-sheets/${id}/start-review`);
    await ctrl.post(`/result-sheets/${id}/approve`);
    // approving staff cannot be a teacher/admin: publish still blocked for them
    for (const c of [teacher, admin]) expect((await c.post(`/result-sheets/${id}/publish`)).status).toBe(403);
    expect((await status(id)).status).toBe('approved');
    expect((await h.owner.query('SELECT count(*)::int AS n FROM published_results WHERE sheet_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('a reviewer who is also the submitter cannot review their own submission', async () => {
    // give the exam controller a teacher role and assignment in this school
    await h.owner.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,'teacher')`, [S.schoolId, S.users.principal.id]);
    await h.owner.query(`INSERT INTO teacher_assignments (school_id, user_id, academic_year_id, class_id, subject_id) VALUES ($1,$2,$3,$4,$5)`, [
      S.schoolId,
      S.users.principal.id,
      S.yearId,
      S.classId,
      S.subjectIds.english,
    ]);
    const dual = await loginAs(h, S.users.principal.email);
    const exam = (
      await ctrl.post('/exams', {
        name: 'Dual role',
        academic_year_id: S.yearId,
        class_id: S.classId,
        subjects: [{ subject_id: S.subjectIds.english, max_marks: 10 }],
      })
    ).body.id;
    const id = (await dual.post('/result-sheets', { exam_id: exam, subject_id: S.subjectIds.english, section_id: S.sectionId })).body.id;
    await dual.put(`/result-sheets/${id}/marks`, { entries: S.students.map((s) => ({ enrollment_id: s.enrollmentId, obtained: 5, is_absent: false })) });
    expect((await dual.post(`/result-sheets/${id}/submit`)).status).toBe(200);
    const r = await dual.post(`/result-sheets/${id}/start-review`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_REVIEW');
    expect((await ctrl.post(`/result-sheets/${id}/start-review`)).status).toBe(200);
  });

  it('concurrent transitions: exactly one wins, no duplicate publication', async () => {
    const exam = (
      await ctrl.post('/exams', {
        name: 'Race',
        academic_year_id: S.yearId,
        class_id: S.classId,
        grading_policy_id: S.policyId,
        subjects: [{ subject_id: S.subjectIds.bangla, max_marks: 100 }],
      })
    ).body.id;
    const id = (await teacher.post('/result-sheets', { exam_id: exam, subject_id: S.subjectIds.bangla, section_id: S.sectionId })).body.id;
    await teacher.put(`/result-sheets/${id}/marks`, { entries: S.students.map((s) => ({ enrollment_id: s.enrollmentId, obtained: 55, is_absent: false })) });
    const subs = await Promise.all([1, 2, 3].map(() => teacher.post(`/result-sheets/${id}/submit`)));
    expect(subs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    await ctrl.post(`/result-sheets/${id}/start-review`);
    await ctrl.post(`/result-sheets/${id}/approve`);
    const pubs = await Promise.all([1, 2, 3].map(() => ctrl.post(`/result-sheets/${id}/publish`)));
    expect(pubs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await h.owner.query('SELECT count(*)::int AS n FROM published_results WHERE sheet_id = $1', [id])).rows[0].n).toBe(4);
  });

  it('stale expected_version is rejected', async () => {
    const exam = (
      await ctrl.post('/exams', {
        name: 'Stale',
        academic_year_id: S.yearId,
        class_id: S.classId,
        subjects: [{ subject_id: S.subjectIds.bangla, max_marks: 100 }],
      })
    ).body.id;
    const id = (await teacher.post('/result-sheets', { exam_id: exam, subject_id: S.subjectIds.bangla, section_id: S.sectionId })).body.id;
    await teacher.put(`/result-sheets/${id}/marks`, { entries: S.students.map((s) => ({ enrollment_id: s.enrollmentId, obtained: 55, is_absent: false })) });
    const r = await teacher.post(`/result-sheets/${id}/submit`, { expected_version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STALE_SHEET');
  });
});

describe('published results: no silent overwrite, explicit correction', () => {
  it('blocks mark edits on approved and published sheets; correction needs permission and reason', async () => {
    const exam = (
      await ctrl.post('/exams', {
        name: 'Final',
        academic_year_id: S.yearId,
        class_id: S.classId,
        grading_policy_id: S.policyId,
        subjects: [{ subject_id: S.subjectIds.bangla, max_marks: 100 }],
      })
    ).body.id;
    const id = (await teacher.post('/result-sheets', { exam_id: exam, subject_id: S.subjectIds.bangla, section_id: S.sectionId })).body.id;
    const put = (obtained: number) =>
      teacher.put(`/result-sheets/${id}/marks`, { entries: S.students.map((s) => ({ enrollment_id: s.enrollmentId, obtained, is_absent: false })) });
    await put(85);
    await teacher.post(`/result-sheets/${id}/submit`);
    await ctrl.post(`/result-sheets/${id}/start-review`);
    await ctrl.post(`/result-sheets/${id}/approve`);
    expect((await put(10)).status).toBe(409); // approved
    await ctrl.post(`/result-sheets/${id}/publish`);
    const locked = await put(10);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('SHEET_LOCKED');
    expect((await h.owner.query(`SELECT DISTINCT obtained FROM marks WHERE sheet_id = $1`, [id])).rows).toEqual([{ obtained: 85 }]);

    // teacher / admin cannot open a correction; reason is mandatory
    expect((await teacher.post(`/result-sheets/${id}/correction`, { reason: 'typo here' })).status).toBe(403);
    expect((await admin.post(`/result-sheets/${id}/correction`, { reason: 'typo here' })).status).toBe(403);
    expect((await ctrl.post(`/result-sheets/${id}/correction`)).body.error.code).toBe('REASON_REQUIRED');

    // guardian-visible published row remains until the correction is republished
    const g = await loginAs(h, S.users.guardian.email);
    const before = await g.get(`/guardian/students/${S.students[0]!.id}/results`);
    expect(before.body.items.find((r: any) => r.exam_name === 'Final').obtained).toBe(85);

    const corr = await ctrl.post(`/result-sheets/${id}/correction`, { reason: 'Data entry error found by teacher' });
    expect(corr.status).toBe(200);
    expect(corr.body).toMatchObject({ status: 'draft', revision: 2 });
    expect((await g.get(`/guardian/students/${S.students[0]!.id}/results`)).body.items.find((r: any) => r.exam_name === 'Final').obtained).toBe(85);

    expect((await put(95)).status).toBe(200);
    await teacher.post(`/result-sheets/${id}/submit`);
    await ctrl.post(`/result-sheets/${id}/start-review`);
    await ctrl.post(`/result-sheets/${id}/approve`);
    expect((await ctrl.post(`/result-sheets/${id}/publish`)).status).toBe(200);

    const after = await g.get(`/guardian/students/${S.students[0]!.id}/results`);
    expect(after.body.items.filter((r: any) => r.exam_name === 'Final')).toHaveLength(1);
    expect(after.body.items.find((r: any) => r.exam_name === 'Final').obtained).toBe(95);

    // old revision is preserved, not overwritten
    const all = await h.owner.query(
      `SELECT revision, obtained, superseded_at IS NOT NULL AS superseded FROM published_results WHERE sheet_id = $1 AND student_id = $2 ORDER BY revision`,
      [id, S.students[0]!.id],
    );
    expect(all.rows).toEqual([
      { revision: 1, obtained: 85, superseded: true },
      { revision: 2, obtained: 95, superseded: false },
    ]);
    const hist = await ctrl.get(`/result-sheets/${id}/history`);
    const c = hist.body.events.find((e: any) => e.action === 'open_correction');
    expect(c.reason).toBe('Data entry error found by teacher');
    expect(hist.body.versions.filter((v: any) => v.stage === 'published').map((v: any) => v.revision)).toEqual([1, 2]);
  });

  it('published rows cannot be changed or deleted, even by the table owner', async () => {
    const row = (await h.owner.query(`SELECT id FROM published_results WHERE school_id = $1 LIMIT 1`, [S.schoolId])).rows[0];
    await expect(h.owner.query(`UPDATE published_results SET obtained = 100 WHERE id = $1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(h.owner.query(`DELETE FROM published_results WHERE id = $1`, [row.id])).rejects.toThrow(/cannot be deleted/);
    await expect(h.owner.query(`DELETE FROM result_events WHERE school_id = $1`, [S.schoolId])).rejects.toThrow(/append-only/);
    await expect(h.owner.query(`UPDATE result_versions SET snapshot = '{}' WHERE school_id = $1`, [S.schoolId])).rejects.toThrow(/append-only/);
  });
});

describe('listing visibility', () => {
  it('teachers see only sheets for their assignments', async () => {
    const t1 = await teacher.get('/result-sheets');
    const t2 = await teacher2.get('/result-sheets');
    expect(t1.body.items.every((s: any) => s.subject_name === 'Bangla')).toBe(true);
    expect(t2.body.items.every((s: any) => s.subject_name === 'Mathematics')).toBe(true);
    const all = await ctrl.get('/result-sheets');
    expect(all.body.items.length).toBeGreaterThanOrEqual(t1.body.items.length + t2.body.items.length);
    const other = await teacher2.get(`/result-sheets/${t1.body.items[0].id}`);
    expect(other.status).toBe(404);
  });
});
