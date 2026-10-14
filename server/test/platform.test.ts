import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/passwords.js';
import { Client, harness, loginAs, PASSWORD, seed, uniqueCode, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let A: SeededSchool;
let platform: Client;
const email = `root-${Date.now()}@petra.example.test`;

beforeAll(async () => {
  h = await harness();
  A = await seed(h, 'pl');
  await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'Root')`, [email, await hashPassword(PASSWORD)]);
  platform = new Client(h.app);
  const r = await platform.req('POST', '/platform/auth/login', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`platform login failed ${r.status}`);
});
afterAll(() => h.close());

describe('platform (Petra) administration is separate from school administration', () => {
  it('platform endpoints require a platform session; school sessions and anonymous users are rejected', async () => {
    const anon = new Client(h.app);
    const school = await loginAs(h, A.users.admin.email);
    for (const c of [anon, school]) {
      for (const url of ['/platform/schools', '/platform/audit', '/platform/releases', `/platform/schools/${A.schoolId}/subscription`])
        expect((await c.get(url)).status, url).toBe(401);
    }
  });

  it('a platform session cannot call school endpoints (it has no school database access)', async () => {
    for (const url of ['/students', '/school', '/result-sheets', '/exams', '/auth/me']) expect((await platform.get(url)).status, url).toBe(401);
  });

  it('platform cookie is scoped to /api/platform and is HttpOnly + SameSite=Strict', async () => {
    const r = await new Client(h.app).req('POST', '/platform/auth/login', { email, password: PASSWORD });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/psid=/);
    expect(cookie).toMatch(/Path=\/api\/platform/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('platform login: generic errors and lockout', async () => {
    const strict = await harness({ LOGIN_MAX_FAILURES: '3' });
    try {
      const em = `lock-${Date.now()}@petra.example.test`;
      await strict.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'L')`, [em, await hashPassword(PASSWORD)]);
      const bad = (e: string) => new Client(strict.app).req('POST', '/platform/auth/login', { email: e, password: 'wrong-password-1' });
      expect((await bad('nobody@petra.example.test')).body).toEqual((await bad(em)).body);
      await bad(em);
      await bad(em);
      expect((await new Client(strict.app).req('POST', '/platform/auth/login', { email: em, password: PASSWORD })).status).toBe(401); // locked
    } finally {
      await strict.close();
    }
  });

  it('registers a school (registry + trial subscription + default branding) without creating a database', async () => {
    const slug = uniqueCode('new');
    const r = await platform.post('/platform/schools', { slug, name: 'New School', admin_email: `a@${slug}.example.test`, admin_name: 'New Admin' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('requested');
    const list = await platform.get('/platform/schools');
    const row = list.body.items.find((s: any) => s.slug === slug);
    expect(row).toMatchObject({
      status: 'requested',
      db_mode: 'dedicated',
      provisioning_step: 'requested',
      subscription_status: 'trial',
      access_level: 'full',
    });
    expect(JSON.stringify(list.body)).not.toMatch(/db_secret|password|v1\./);
    expect((await h.control.query(`SELECT 1 FROM school_branding WHERE school_id = $1`, [r.body.id])).rowCount).toBe(1);
    // Not provisioned: nobody can log in to it yet, and the response does not reveal why.
    expect((await new Client(h.app).login(`a@${slug}.example.test`, PASSWORD, slug)).status).toBe(401);
  });

  it('rejects duplicate, invalid and reserved slugs', async () => {
    const base = { name: 'X School', admin_email: 'a@x.example.test', admin_name: 'A' };
    expect((await platform.post('/platform/schools', { ...base, slug: A.code })).status).toBe(409);
    expect((await platform.post('/platform/schools', { ...base, slug: 'BAD SLUG' })).status).toBe(400);
    expect((await platform.post('/platform/schools', { ...base, slug: 'admin' })).status).toBe(400);
  });

  it('suspending a school cuts off its users immediately and is audited; reactivation restores', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.get('/school')).status).toBe(200);
    expect((await platform.patch(`/platform/schools/${A.schoolId}/status`, { status: 'suspended' })).status).toBe(200);
    const r = await admin.get('/school');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SCHOOL_SUSPENDED');
    const login = await new Client(h.app).login(A.users.admin.email);
    expect(login.status).toBe(403);
    expect((await platform.patch(`/platform/schools/${A.schoolId}/status`, { status: 'active' })).status).toBe(200);
    expect((await admin.get('/school')).status).toBe(200);
    const { rows } = await h.control.query(`SELECT action FROM platform_audit_events WHERE school_id = $1 AND action = 'school.status'`, [A.schoolId]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('platform audit is append-only', async () => {
    await expect(h.control.query(`UPDATE platform_audit_events SET action = 'x'`)).rejects.toThrow(/permission denied|append-only/);
    await expect(h.control.query(`DELETE FROM platform_audit_events`)).rejects.toThrow(/permission denied|append-only/);
  });

  it('branding: platform admin and school admin can set it, with validation; public endpoint exposes only public fields', async () => {
    const ok = { display_name: 'Greenfield School', logo_url: 'https://cdn.example.test/logo.png', primary_color: '#0B6B4F', accent_color: '#08523c' };
    const r = await platform.req('PUT', `/platform/schools/${A.schoolId}/branding`, ok);
    expect(r.status).toBe(200);
    expect(r.body.primary_color).toBe('#0b6b4f');
    for (const bad of [
      { ...ok, primary_color: '#ffff00' },
      { ...ok, primary_color: 'red' },
      { ...ok, logo_url: 'javascript:alert(1)' },
      { ...ok, logo_url: 'http://insecure.example.test/x.png' },
      { ...ok, display_name: 'x' },
    ]) {
      expect((await platform.req('PUT', `/platform/schools/${A.schoolId}/branding`, bad)).status).toBe(400);
    }
    const low = await platform.req('PUT', `/platform/schools/${A.schoolId}/branding`, { ...ok, accent_color: '#ffff00' });
    expect(low.body.error.code).toBe('LOW_CONTRAST');

    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.req('PUT', '/school/branding', { ...ok, display_name: 'Greenfield Updated' })).status).toBe(200);
    expect((await admin.req('PUT', '/school/branding', { ...ok, school_id: 'ignored', display_name: 'Greenfield Updated 2' })).status).toBe(200);
    const teacher = await loginAs(h, A.users.teacher.email);
    expect((await teacher.req('PUT', '/school/branding', ok)).status).toBe(403);

    const pub = await new Client(h.app).get(`/public/branding/${A.code}`);
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual({
      slug: A.code,
      display_name: 'Greenfield Updated 2',
      logo_url: 'https://cdn.example.test/logo.png',
      primary_color: '#0b6b4f',
      accent_color: '#08523c',
    });
    expect((await new Client(h.app).get('/public/branding/no-such-school')).status).toBe(404);
    // A school admin of A can only ever change A: another school's branding is untouched.
    const B = await seed(h, 'pl-b');
    expect((await new Client(h.app).get(`/public/branding/${B.code}`)).body.display_name).toBe('School pl-b');
  });

  it('releases and build profiles; public app-config reports whether an installed version is supported', async () => {
    expect((await platform.post('/platform/releases', { version: '1.4.0', min_supported_version: '1.2.0', notes: 'test' })).status).toBe(201);
    expect((await platform.post('/platform/releases', { version: '1.4.0', min_supported_version: '1.2.0' })).status).toBe(409);
    const ok = await new Client(h.app).get(`/public/app-config/${A.code}?version=1.3.0`);
    expect(ok.body).toMatchObject({ latest_version: '1.4.0', min_supported_version: '1.2.0', update_required: false });
    expect((await new Client(h.app).get(`/public/app-config/${A.code}?version=1.1.9`)).body.update_required).toBe(true);
    const bp = await platform.req('PUT', `/platform/schools/${A.schoolId}/build-profiles/android`, {
      app_id: 'com.petra.shikkhaos.greenfield',
      app_name: 'Greenfield',
    });
    expect(bp.status).toBe(200);
    expect((await platform.req('PUT', `/platform/schools/${A.schoolId}/build-profiles/android`, { app_id: 'Bad App Id', app_name: 'G' })).status).toBe(400);
  });

  it('school admin manages members; passwords never appear in responses or audit', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    const pw = 'a-very-secret-pw-1';
    const r = await admin.post('/school/members', { email: 'newteacher@pl.example.test', full_name: 'New Teacher', initial_password: pw, role: 'teacher' });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.body)).not.toContain(pw);
    expect(JSON.stringify((await admin.get('/school/members')).body)).not.toMatch(/password|argon2/i);
    const audit = await h.owner.query(`SELECT metadata::text AS m FROM audit_events WHERE school_id = $1`, [A.schoolId]);
    expect(audit.rows.some((x) => x.m.includes(pw))).toBe(false);
    expect((await admin.post('/school/members', { email: 'newteacher@pl.example.test', full_name: 'Dup', initial_password: pw, role: 'teacher' })).status).toBe(
      409,
    );
    expect((await admin.post('/school/members', { email: 'weak@pl.example.test', full_name: 'W', initial_password: 'short', role: 'teacher' })).status).toBe(
      400,
    );
  });

  it('school profile edits are validated; exam creation and grading policy validation still hold', async () => {
    const admin = await loginAs(h, A.users.admin.email);
    expect((await admin.patch('/school', { logo_url: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await admin.patch('/school', { logo_url: 'https://cdn.example.test/logo.png', phone: '+880000000000', settings: { default_language: 'en' } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ default_language: 'en' });
    const ctrl = await loginAs(h, A.users.controller.email);
    const base = { name: 'Validation', academic_year_id: A.yearId, class_id: A.classId };
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 0 }] })).status).toBe(400);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10, pass_marks: 11 }] })).status).toBe(400);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10 }] })).status).toBe(201);
    expect((await ctrl.post('/exams', { ...base, subjects: [{ subject_id: A.subjectIds.math, max_marks: 10 }] })).status).toBe(409);
    expect((await admin.post('/school/grading-policies', { name: 'bad', bands: [{ min_percent: 50, grade: 'A' }] })).status).toBe(400);
    expect((await admin.post('/school/grading-policies', { name: 'school-defined', bands: [{ min_percent: 0, grade: 'X' }] })).status).toBe(201);
  });
});
