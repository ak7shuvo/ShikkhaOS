import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillSheet, harness, loginAs, seed, type Client, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let A: SeededSchool;
let B: SeededSchool;
let g1: Client, g2: Client, gB: Client, teacher: Client, ctrl: Client, admin: Client;
let examId: string;
let sheetId: string;

const advance = async (...actions: string[]) => {
  for (const a of actions) {
    const r = await (a === 'submit' ? teacher : ctrl).post(`/result-sheets/${sheetId}/${a}`, { reason: 'needs another look' });
    expect(r.status, a).toBe(200);
  }
};
const results = (c: Client, studentId: string) => c.get(`/guardian/students/${studentId}/results`);

beforeAll(async () => {
  h = await harness();
  A = await seed(h, 'ga');
  B = await seed(h, 'gb');
  [g1, g2, gB, teacher, ctrl, admin] = await Promise.all([
    loginAs(h, A.users.guardian.email),
    loginAs(h, A.users.guardian2.email),
    loginAs(h, B.users.guardian.email),
    loginAs(h, A.users.teacher.email),
    loginAs(h, A.users.controller.email),
    loginAs(h, A.users.admin.email),
  ]);
  ({ sheetId, examId } = await fillSheet(h, teacher, A));
});
afterAll(() => h.close());

describe('guardian portal', () => {
  it('lists only verified linked students', async () => {
    const r = await g1.get('/guardian/students');
    expect(r.body.items.map((s: any) => s.id)).toEqual([A.students[0]!.id]);
    expect((await g2.get('/guardian/students')).body.items.map((s: any) => s.id)).toEqual([A.students[1]!.id]);
  });

  it('shows profile, enrollment and exams of a linked student only', async () => {
    const p = await g1.get(`/guardian/students/${A.students[0]!.id}`);
    expect(p.status).toBe(200);
    expect(p.body.full_name).toBe('Demo Student 1');
    expect(p.body.enrollments[0]).toMatchObject({ class_name: 'Class 6', section_name: 'A', roll_no: 1 });
    const ex = await g1.get(`/guardian/students/${A.students[0]!.id}/exams`);
    expect(ex.status).toBe(200);
    expect(ex.body.items.map((e: any) => e.id)).toContain(examId);
  });

  it('cannot access siblings of other guardians (IDOR) or other schools’ students', async () => {
    for (const path of ['', '/results', '/exams']) {
      expect((await g1.get(`/guardian/students/${A.students[1]!.id}${path}`)).status, `other student ${path}`).toBe(404);
      expect((await g1.get(`/guardian/students/${B.students[0]!.id}${path}`)).status, `other school ${path}`).toBe(404);
      expect((await gB.get(`/guardian/students/${A.students[0]!.id}${path}`)).status, `reverse ${path}`).toBe(404);
    }
    expect((await g1.get('/guardian/students/not-a-uuid')).status).toBe(400);
  });

  it('pending and revoked links grant no access', async () => {
    const link = (await h.owner.query(`SELECT id FROM student_guardians WHERE student_id = $1`, [A.students[0]!.id])).rows[0].id;
    await h.owner.query(`UPDATE student_guardians SET status = 'revoked' WHERE id = $1`, [link]);
    expect((await g1.get(`/guardian/students/${A.students[0]!.id}`)).status).toBe(404);
    expect((await g1.get('/guardian/students')).body.items).toEqual([]);
    await h.owner.query(`UPDATE student_guardians SET status = 'verified' WHERE id = $1`, [link]);
    expect((await g1.get(`/guardian/students/${A.students[0]!.id}`)).status).toBe(200);
  });

  it('shows an empty list until results are published — never drafts or in-review data', async () => {
    const sid = A.students[0]!.id;
    expect((await results(g1, sid)).body.items).toEqual([]); // draft
    await advance('submit');
    expect((await results(g1, sid)).body.items).toEqual([]); // submitted
    await advance('start-review');
    expect((await results(g1, sid)).body.items).toEqual([]); // under review
    await ctrl.post(`/result-sheets/${sheetId}/return`, { reason: 'needs another look' });
    expect((await results(g1, sid)).body.items).toEqual([]); // returned
    await advance('submit', 'start-review', 'approve');
    expect((await results(g1, sid)).body.items).toEqual([]); // approved but unpublished
    expect(JSON.stringify((await results(g1, sid)).body)).not.toMatch(/90/);
  });

  it('shows only the guardian’s own child’s published results after publication', async () => {
    await advance('publish');
    const r = await results(g1, A.students[0]!.id);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ subject_name: 'Bangla', obtained: 90, max_marks: 100, grade: 'A', is_absent: false });
    const r2 = await results(g2, A.students[1]!.id);
    expect(r2.body.items[0]).toMatchObject({ obtained: 70, grade: 'B' });
    // g1 still cannot see g2's child
    expect((await results(g1, A.students[1]!.id)).status).toBe(404);
    // no internal/workflow fields leak
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'exam_id',
      'exam_name',
      'grade',
      'grade_point',
      'is_absent',
      'max_marks',
      'obtained',
      'published_at',
      'subject_name',
    ]);
  });

  it('staff roles do not get guardian endpoints, guardians do not get staff endpoints', async () => {
    expect((await admin.get('/guardian/students')).status).toBe(403);
    expect((await ctrl.get('/guardian/students')).status).toBe(403);
    expect((await g1.get('/result-sheets')).status).toBe(403);
    expect((await g1.get(`/result-sheets/${sheetId}`)).status).toBe(404); // no existence leak
    expect((await g1.post(`/result-sheets/${sheetId}/publish`)).status).toBe(403);
  });

  it('admin guardian creation + verification flow gates access', async () => {
    const created = await admin.post('/guardians', {
      full_name: 'Demo Guardian Three',
      account: { email: 'g3@ga.example.test', initial_password: 'long-enough-password' },
    });
    expect(created.status).toBe(201);
    const link = await admin.post(`/students/${A.students[2]!.id}/guardians`, { guardian_id: created.body.id, relationship: 'parent' });
    expect(link.body.status).toBe('pending');
    const g3 = new (await import('./helpers.js')).Client(h.app);
    expect((await g3.login('g3@ga.example.test', 'long-enough-password', A.code)).status).toBe(200);
    expect((await g3.get(`/guardian/students/${A.students[2]!.id}`)).status).toBe(404); // pending
    expect((await admin.post(`/student-guardians/${link.body.id}/verify`)).status).toBe(200);
    expect((await g3.get(`/guardian/students/${A.students[2]!.id}`)).status).toBe(200);
    expect((await admin.post(`/student-guardians/${link.body.id}/verify`)).status).toBe(409); // not pending any more
  });
});
