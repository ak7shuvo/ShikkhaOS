import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/passwords.js';
import { Client, harness, loginAs, PASSWORD, seed, uniqueCode, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let A: SeededSchool;
let platform: Client;
const email = `root-${Date.now()}@platform.example.test`;

beforeAll(async () => {
  h = await harness();
  A = await seed(h, 'pl');
  await h.owner.query(`INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES ($1,$2,'Root',true)`, [
    email,
    await hashPassword(PASSWORD),
  ]);
  platform = await loginAs(h, email);
});
afterAll(() => h.close());

describe('platform administration', () => {
  it('platform admin has no school context and cannot read tenant data', async () => {
    const me = await platform.get('/auth/me');
    expect(me.body.active_school_id).toBeNull();
    expect(me.body.permissions).toEqual(['platform.licenses.manage', 'platform.schools.manage']);
    for (const url of ['/students', '/school', '/result-sheets', '/exams', '/school/members']) {
      expect((await platform.get(url)).status, url).toBe(409);
    }
    expect((await platform.post('/auth/switch-school', { school_id: A.schoolId })).status).toBe(403);
  });

  it('creates a school with trial licence and first admin, who can log in and sees only that school', async () => {
    const code = uniqueCode('new');
    const r = await platform.post('/platform/schools', {
      code,
      name: 'New School',
      admin: { email: `a@${code}.example.test`, full_name: 'New Admin', initial_password: 'initial-pass-123' },
    });
    expect(r.status).toBe(201);
    const list = await platform.get('/platform/schools');
    expect(list.body.items.find((s: any) => s.code === code).license_status).toBe('trial');
    const admin = new Client(h.app);
    const login = await admin.login(`a@${code}.example.test`, 'initial-pass-123');
    expect(login.body.active_school_id).toBe(r.body.id);
    expect(login.body.roles).toEqual(['school_admin']);
    expect((await admin.get('/students')).body.items).toEqual([]);
    expect((await admin.get('/platform/schools')).status).toBe(403);
  });

  it('rejects duplicate school codes and invalid input', async () => {
    const dup = await platform.post('/platform/schools', {
      code: A.code,
      name: 'Dup',
      admin: { email: 'd@x.example.test', full_name: 'D', initial_password: 'initial-pass-123' },
    });
    expect(dup.status).toBe(409);
    const bad = await platform.post('/platform/schools', { code: 'BAD CODE', name: 'x', admin: { email: 'nope', full_name: '', initial_password: 'short' } });
    expect(bad.status).toBe(400);
  });

  it('suspending a school or expiring its licence cuts off its users; audit is recorded', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.get('/school')).status).toBe(200);
    expect((await platform.patch(`/platform/schools/${A.schoolId}/status`, { status: 'suspended' })).status).toBe(200);
    expect((await admin.get('/school')).status).toBe(409);
    await platform.patch(`/platform/schools/${A.schoolId}/status`, { status: 'active' });
    const lic = await platform.req('PUT', `/platform/schools/${A.schoolId}/license`, { plan: 'standard', status: 'suspended', starts_on: '2026-01-01' });
    expect(lic.status).toBe(200);
    expect((await admin.get('/school')).body.error.code).toBe('LICENSE_INACTIVE');
    await platform.req('PUT', `/platform/schools/${A.schoolId}/license`, {
      plan: 'standard',
      status: 'active',
      starts_on: '2026-01-01',
      ends_on: '2099-01-01',
    });
    expect((await admin.get('/school')).status).toBe(200);
    const { rows } = await h.owner.query(`SELECT action FROM audit_events WHERE school_id = $1 AND action LIKE 'platform.%'`, [A.schoolId]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['platform.school.status', 'platform.license.set']));
  });

  it('school admin profile edits are validated and audited', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.patch('/school', { logo_url: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await admin.patch('/school', { logo_url: 'https://cdn.example.test/logo.png', phone: '+880000000000', settings: { default_language: 'en' } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ default_language: 'en' });
    expect((await admin.get('/school')).body.logo_url).toBe('https://cdn.example.test/logo.png');
  });

  it('school admin manages members; passwords never appear in responses or audit', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    const pw = 'a-very-secret-pw-1';
    const r = await admin.post('/school/members', { email: 'newteacher@pl.example.test', full_name: 'New Teacher', initial_password: pw, role: 'teacher' });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.body)).not.toContain(pw);
    const list = await admin.get('/school/members');
    expect(JSON.stringify(list.body)).not.toMatch(/password|argon2/i);
    const audit = await h.owner.query(`SELECT metadata::text AS m FROM audit_events WHERE school_id = $1`, [A.schoolId]);
    expect(audit.rows.some((x) => x.m.includes(pw))).toBe(false);
    expect((await admin.post('/school/members', { email: 'newteacher@pl.example.test', full_name: 'Dup', initial_password: pw, role: 'teacher' })).status).toBe(
      409,
    );
    expect((await admin.post('/school/members', { email: 'weak@pl.example.test', full_name: 'W', initial_password: 'short', role: 'teacher' })).status).toBe(
      400,
    );
  });

  it('exam creation validates marks and grading policies validate bands', async () => {
    const ctrl = await loginAs(h, A.users.controller.email);
    const base = { name: 'Validation', academic_year_id: A.yearId, class_id: A.classId };
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 0 }] })).status).toBe(400);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10, pass_marks: 11 }] })).status).toBe(400);
    expect((await ctrl.post('/exams', { ...base, subjects: [] })).status).toBe(400);
    expect(
      (
        await ctrl.post('/exams', {
          ...base,
          subjects: [
            { subject_id: A.subjectIds.math, max_marks: 10 },
            { subject_id: A.subjectIds.math, max_marks: 10 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10 }] })).status).toBe(201);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10 }] })).status).toBe(409); // duplicate name
    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.post('/school/grading-policies', { name: 'bad', bands: [{ min_percent: 50, grade: 'A' }] })).status).toBe(400);
    expect((await admin.post('/school/grading-policies', { name: 'school-defined', bands: [{ min_percent: 0, grade: 'X' }] })).status).toBe(201);
  });
});
