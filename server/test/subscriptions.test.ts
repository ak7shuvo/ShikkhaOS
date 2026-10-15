import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/passwords.js';
import { addDays } from '../src/entitlements.js';
import { sweepSubscriptions } from '../src/subscriptions.js';
import { Client, harness, loginAs, PASSWORD, seed, setSubscription, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let platform: Client;
const END = '2026-03-31';
const day = (offset: number) => addDays(END, offset);

beforeAll(async () => {
  h = await harness();
  const email = `sub-root-${Date.now()}@petra.example.test`;
  await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'Root')`, [email, await hashPassword(PASSWORD)]);
  platform = new Client(h.app);
  expect((await platform.req('POST', '/platform/auth/login', { email, password: PASSWORD })).status).toBe(200);
});
afterAll(() => h.close());

async function school(prefix: string): Promise<{ S: SeededSchool; admin: Client }> {
  const S = await seed(h, prefix);
  await setSubscription(h, S.schoolId, { status: 'active', period_start: '2026-01-01', period_end: END, grace_days: 7, readonly_days: 30 });
  h.setToday(day(-1));
  return { S, admin: await loginAs(h, S.users.admin.email) };
}

describe('server-side entitlement enforcement at exact date boundaries', () => {
  it('walks full → grace → read-only → blocked with the documented behaviour at each boundary', async () => {
    const { S, admin } = await school('ent');
    const write = () => admin.post('/classes', { name: `C-${Math.random().toString(36).slice(2, 8)}` });

    // last paid day (period_end): full, no warning
    h.setToday(day(0));
    let r = await admin.get('/school');
    expect(r.status).toBe(200);
    expect(r.headers['x-subscription-warning']).toBeUndefined();
    expect((await write()).status).toBe(201);

    // day +1 and +7: grace — everything still works, with a warning
    for (const d of [1, 7]) {
      h.setToday(day(d));
      r = await admin.get('/school');
      expect(r.status, `day ${d}`).toBe(200);
      expect(r.headers['x-subscription-warning']).toBe('RENEWAL_OVERDUE');
      expect(r.body.subscription).toMatchObject({ level: 'grace', status: 'past_due' });
      expect((await write()).status, `write day ${d}`).toBe(201);
    }

    // day +8 and +37: read-only — reads and export work, writes rejected
    for (const d of [8, 37]) {
      h.setToday(day(d));
      r = await admin.get('/school');
      expect(r.status, `day ${d}`).toBe(200);
      expect(r.headers['x-subscription-warning']).toBe('READ_ONLY');
      const w = await write();
      expect(w.status, `write day ${d}`).toBe(403);
      expect(w.body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
      expect((await admin.get('/school/export')).status).toBe(200);
      expect((await admin.get('/students')).status).toBe(200);
    }

    // day +38: blocked for school users
    h.setToday(day(38));
    for (const url of ['/school', '/students', '/school/export', '/exams']) {
      const b = await admin.get(url);
      expect(b.status, url).toBe(403);
      expect(b.body.error.code).toBe('SUBSCRIPTION_BLOCKED');
      expect(b.body.error.details.retention_until).toBe(day(90));
    }
    expect((await admin.post('/classes', { name: 'nope' })).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    // new logins explain why, only after the credentials were verified
    const login = await new Client(h.app).login(S.users.admin.email);
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    expect((await new Client(h.app).login(S.users.admin.email, 'wrong-pass-123')).status).toBe(401);
  });

  it('session info and password change stay available so users see why and can secure their account', async () => {
    const { S, admin } = await school('ent-me');
    h.setToday(day(100));
    const me = await admin.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.entitlement).toMatchObject({ level: 'blocked', status: 'suspended', retention_until: day(90) });
    expect((await admin.post('/auth/change-password', { current_password: PASSWORD, new_password: 'brand-new-password-1' })).status).toBe(200);
    expect((await admin.post('/auth/logout')).status).toBe(200);
    void S;
  });

  it('read-only mode also blocks workflow actions and marks writes for every role', async () => {
    const { S } = await school('ent-wf');
    const teacher = await loginAs(h, S.users.teacher.email);
    const ctrl = await loginAs(h, S.users.controller.email);
    h.setToday(day(10));
    const open = await teacher.post('/result-sheets', { exam_id: S.examId, subject_id: S.subjectIds.bangla, section_id: S.sectionId });
    expect(open.body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    const sheets = await ctrl.get('/result-sheets');
    expect(sheets.status).toBe(200);
    expect((await ctrl.post(`/result-sheets/00000000-0000-4000-8000-000000000000/publish`)).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
  });

  it('guardians keep read access in read-only mode and lose it when blocked', async () => {
    const { S } = await school('ent-g');
    const g = await loginAs(h, S.users.guardian.email);
    h.setToday(day(20));
    expect((await g.get('/guardian/students')).status).toBe(200);
    h.setToday(day(50));
    expect((await g.get('/guardian/students')).status).toBe(403);
  });

  it('one school’s lapse never affects another school', async () => {
    const a = await school('ent-iso-a');
    const b = await school('ent-iso-b');
    await setSubscription(h, b.S.schoolId, { period_end: '2099-12-31' });
    h.setToday(day(60));
    expect((await a.admin.get('/school')).status).toBe(403);
    expect((await b.admin.get('/school')).status).toBe(200);
  });

  it('a school with no subscription row is blocked (fail closed)', async () => {
    const { S, admin } = await school('ent-none');
    const ctlOwner = new pg.Client({ connectionString: process.env.TEST_CONTROL_MIGRATION_DATABASE_URL! }); // the app role has no DELETE
    await ctlOwner.connect();
    await ctlOwner.query(`DELETE FROM subscriptions WHERE school_id = $1`, [S.schoolId]);
    await ctlOwner.end();
    expect((await admin.get('/school')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
  });

  it('data is preserved indefinitely after blocking: nothing is deleted by the lapse', async () => {
    const { S } = await school('ent-keep');
    const count = async () =>
      (
        await h.owner.query(
          `SELECT (SELECT count(*) FROM students WHERE school_id=$1)::int AS s, (SELECT count(*) FROM users u JOIN school_memberships m ON m.user_id = u.id WHERE m.school_id=$1)::int AS u`,
          [S.schoolId],
        )
      ).rows[0];
    const before = await count();
    h.setToday(day(2000));
    await sweepSubscriptions(h.control, day(2000));
    expect(await count()).toEqual(before);
    expect((await h.control.query(`SELECT 1 FROM schools WHERE id = $1`, [S.schoolId])).rowCount).toBe(1);
  });

  it('the export contains school data, not credentials or sessions', async () => {
    const { S, admin } = await school('ent-exp');
    h.setToday(day(15)); // read-only
    const r = await admin.get('/school/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain(`${S.code}-export.json`);
    expect(r.body.tables.students).toHaveLength(4);
    expect(Object.keys(r.body.tables)).not.toContain('sessions');
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/argon2|password_hash|token_hash/);
    const teacher = await loginAs(h, S.users.teacher.email);
    expect((await teacher.get('/school/export')).status).toBe(403); // teachers lack school.manage
  });
});

describe('subscription lifecycle through the platform API', () => {
  const pay = (id: string, body: Record<string, unknown> = {}) =>
    platform.post(`/platform/schools/${id}/subscription/payments`, {
      plan: 'monthly',
      amount_minor: 500000,
      currency: 'BDT',
      method: 'bank_transfer',
      reference: 'REF-1',
      received_on: '2026-04-02',
      ...body,
    });

  it('a payment during grace renews the same day and restores full access; replaying the reference is idempotent', async () => {
    const { S, admin } = await school('pay');
    h.setToday(day(10)); // read-only
    expect((await admin.post('/classes', { name: 'x' })).status).toBe(403);
    const r = await pay(S.schoolId);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ replayed: false, period_start: day(10), period_end: '2026-05-09' });
    expect((await admin.post('/classes', { name: 'back' })).status).toBe(201);
    const again = await pay(S.schoolId);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const sub = (await platform.get(`/platform/schools/${S.schoolId}/subscription`)).body;
    expect(sub.payments).toHaveLength(1);
    expect(sub.subscription.period_end).toBe(r.body.period_end);
    expect(sub.subscription.entitlement.level).toBe('full');
  });

  it('early renewal extends seamlessly; annual plan adds twelve months', async () => {
    const { S } = await school('pay-early');
    h.setToday(day(-5));
    const r = await pay(S.schoolId, { reference: 'EARLY-1', plan: 'annual' });
    expect(r.body).toMatchObject({ period_start: day(1), period_end: '2027-03-31' });
  });

  it('concurrent identical payments produce exactly one renewal', async () => {
    const { S } = await school('pay-race');
    const rs = await Promise.all([1, 2, 3].map(() => pay(S.schoolId, { reference: 'RACE-1' })));
    expect(rs.map((x) => x.status).sort()).toEqual([200, 200, 201]);
    expect((await h.control.query(`SELECT count(*)::int AS n FROM subscription_payments WHERE school_id = $1`, [S.schoolId])).rows[0].n).toBe(1);
  });

  it('validates payments and refuses unknown schools or plans', async () => {
    const { S } = await school('pay-val');
    expect((await pay(S.schoolId, { currency: 'bdt' })).status).toBe(400);
    expect((await pay(S.schoolId, { plan: 'weekly' })).status).toBe(400);
    expect((await pay(S.schoolId, { amount_minor: -1 })).status).toBe(400);
    expect((await pay('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    await expect(h.control.query(`UPDATE subscription_payments SET amount_minor = 0`)).rejects.toThrow(/permission denied|append-only/);
  });

  it('manual suspension blocks at once, is not lifted by a payment, and reinstatement requires an explicit step', async () => {
    const { S, admin } = await school('pay-susp');
    h.setToday(day(-20));
    expect((await platform.post(`/platform/schools/${S.schoolId}/subscription/suspend`, { reason: 'x' })).status).toBe(400);
    expect((await platform.post(`/platform/schools/${S.schoolId}/subscription/suspend`, { reason: 'Non-compliance notice' })).status).toBe(200);
    expect((await admin.get('/school')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    await pay(S.schoolId, { reference: 'SUSP-1' });
    expect((await admin.get('/school')).status).toBe(403);
    expect((await platform.post(`/platform/schools/${S.schoolId}/subscription/reinstate`, { reason: 'Resolved with school' })).status).toBe(200);
    expect((await admin.get('/school')).status).toBe(200);
    expect((await platform.post(`/platform/schools/${S.schoolId}/subscription/reinstate`, { reason: 'again again' })).status).toBe(409);
  });

  it('cancellation keeps access until the period ends, then follows the normal timeline', async () => {
    const { S, admin } = await school('pay-cancel');
    await platform.post(`/platform/schools/${S.schoolId}/subscription/cancel`);
    h.setToday(day(0));
    expect((await admin.get('/school')).body.subscription.status).toBe('cancelled');
    h.setToday(day(9));
    expect((await admin.post('/classes', { name: 'x' })).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
  });

  it('per-school terms (grace, read-only, retention, legal hold) change the boundaries', async () => {
    const { S, admin } = await school('pay-terms');
    const t = await platform.patch(`/platform/schools/${S.schoolId}/subscription/terms`, { grace_days: 2, readonly_days: 1, legal_hold: true });
    expect(t.body.entitlement.deletion_allowed_from).toBeNull();
    h.setToday(day(3));
    expect((await admin.post('/classes', { name: 'x' })).body.error.code).toBe('SUBSCRIPTION_READ_ONLY');
    h.setToday(day(4));
    expect((await admin.get('/school')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    expect((await platform.patch(`/platform/schools/${S.schoolId}/subscription/terms`, {})).status).toBe(400);
    expect((await platform.patch(`/platform/schools/${S.schoolId}/subscription/terms`, { grace_days: -1 })).status).toBe(400);
  });

  it('the sweeper records derived transitions idempotently and never touches manual suspensions or school data', async () => {
    const { S } = await school('sweep');
    h.setToday(day(1));
    const first = await sweepSubscriptions(h.control, day(1));
    expect(first.changed.find((c) => c.school_id === S.schoolId)).toMatchObject({ from: 'active', to: 'past_due' });
    expect((await sweepSubscriptions(h.control, day(1))).changed.find((c) => c.school_id === S.schoolId)).toBeUndefined();
    const second = await sweepSubscriptions(h.control, day(9));
    expect(second.changed.find((c) => c.school_id === S.schoolId)).toMatchObject({ from: 'past_due', to: 'expired' });
    await sweepSubscriptions(h.control, day(40));
    expect((await h.control.query(`SELECT status FROM subscriptions WHERE school_id = $1`, [S.schoolId])).rows[0].status).toBe('expired'); // 'suspended' is reserved for manual suspension
    // payment after the sweep fully restores access (the stored status is only a report)
    h.setToday(day(41));
    await pay(S.schoolId, { reference: 'SWEEP-1' });
    const admin = await loginAs(h, S.users.admin.email);
    expect((await admin.post('/classes', { name: 'restored' })).status).toBe(201);
    const ev = await h.control.query(`SELECT event FROM subscription_events WHERE school_id = $1`, [S.schoolId]);
    expect(ev.rows.map((e) => e.event)).toEqual(expect.arrayContaining(['trial_started', 'status_derived', 'payment_recorded']));
  });
});

describe('write paths in restricted subscription states (documented exceptions only)', () => {
  const Z = '00000000-0000-4000-8000-000000000000';
  // Every state-changing school route except the documented session/credential exceptions.
  const WRITES: [string, string, unknown][] = [
    ['PATCH', '/auth/me', { language: 'en' }],
    ['POST', '/academic-years', { name: 'x', starts_on: '2026-01-01', ends_on: '2026-12-31' }],
    ['POST', '/classes', { name: 'x' }],
    ['POST', `/classes/${Z}/sections`, { name: 'x' }],
    ['POST', '/subjects', { code: 'X', name: 'x' }],
    ['POST', '/students', { student_code: 'X', full_name: 'x' }],
    ['POST', `/students/${Z}/enrollments`, {}],
    ['POST', '/guardians', { full_name: 'x' }],
    ['POST', `/students/${Z}/guardians`, {}],
    ['POST', `/student-guardians/${Z}/verify`, {}],
    ['POST', `/student-guardians/${Z}/revoke`, {}],
    ['POST', '/teacher-assignments', {}],
    ['POST', '/exams', {}],
    ['POST', '/result-sheets', {}],
    ['PUT', `/result-sheets/${Z}/marks`, {}],
    ['POST', `/result-sheets/${Z}/submit`, {}],
    ['POST', `/result-sheets/${Z}/publish`, {}],
    ['PUT', '/school/branding', {}],
    ['PATCH', '/school', {}],
    ['POST', '/school/members', {}],
    ['PATCH', `/school/members/${Z}`, {}],
    ['POST', '/school/grading-policies', {}],
  ];
  const sweep = async (c: Client) => {
    const seen = new Set<string>();
    for (const [m, u, b] of WRITES) seen.add(`${(await c.req(m as 'POST', u, b)).body?.error?.code}`);
    return [...seen];
  };

  it('every school write route is rejected in read-only and blocked states, for staff and guardians alike', async () => {
    const { S, admin } = await school('wr-sweep');
    const ctrl = await loginAs(h, S.users.controller.email);
    const guardian = await loginAs(h, S.users.guardian.email);
    h.setToday(day(10));
    for (const c of [admin, ctrl, guardian]) expect(await sweep(c)).toEqual(['SUBSCRIPTION_READ_ONLY']);
    h.setToday(day(60));
    for (const c of [admin, ctrl, guardian]) expect(await sweep(c)).toEqual(['SUBSCRIPTION_BLOCKED']);
  });

  it('PATCH /auth/me works in full and grace, is refused in read-only and blocked, and changes nothing when refused', async () => {
    const { S, admin } = await school('wr-lang');
    const lang = async () => (await h.owner.query(`SELECT preferred_language FROM users WHERE id = $1`, [S.users.admin.id])).rows[0].preferred_language;
    h.setToday(day(3)); // grace
    expect((await admin.patch('/auth/me', { language: 'en' })).status).toBe(200);
    expect(await lang()).toBe('en');
    h.setToday(day(10));
    const ro = await admin.patch('/auth/me', { language: 'bn' });
    expect([ro.status, ro.body.error.code]).toEqual([403, 'SUBSCRIPTION_READ_ONLY']);
    h.setToday(day(60));
    const bl = await admin.patch('/auth/me', { language: 'bn' });
    expect([bl.status, bl.body.error.code]).toEqual([403, 'SUBSCRIPTION_BLOCKED']);
    expect(await lang()).toBe('en');
  });

  it('change-password stays available in read-only and blocked states without weakening password rules', async () => {
    const { S, admin } = await school('wr-pw');
    const other = await loginAs(h, S.users.admin.email);
    for (const [label, offset] of [
      ['read-only', 10],
      ['blocked', 60],
    ] as const) {
      h.setToday(day(offset));
      const bad = await admin.post('/auth/change-password', { current_password: 'not-the-password', new_password: 'a-long-enough-password-1' });
      expect([label, bad.status, bad.body.error.code]).toEqual([label, 403, 'WRONG_PASSWORD']);
      const weak = await admin.post('/auth/change-password', { current_password: PASSWORD, new_password: 'short' });
      expect([label, weak.status, weak.body.error.code]).toEqual([label, 400, 'VALIDATION_ERROR']);
    }
    h.setToday(day(10));
    expect((await admin.post('/auth/change-password', { current_password: PASSWORD, new_password: 'a-long-enough-password-1' })).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401); // other sessions revoked
    h.setToday(day(60));
    expect((await admin.post('/auth/change-password', { current_password: 'a-long-enough-password-1', new_password: 'another-long-password-2' })).status).toBe(
      200,
    );
    // the new credential is what works at login (blocked state is reported only after the password verified)
    const r = await new Client(h.app).login(S.users.admin.email, 'another-long-password-2');
    expect([r.status, r.body.error.code]).toEqual([403, 'SUBSCRIPTION_BLOCKED']);
    expect((await new Client(h.app).login(S.users.admin.email, PASSWORD)).status).toBe(401);
  });

  it('export is a GET allowed in read-only mode and appends exactly one audit record; blocked mode refuses and appends nothing', async () => {
    const { S, admin } = await school('wr-exp');
    const audits = async () =>
      (await h.owner.query(`SELECT count(*)::int AS n FROM audit_events WHERE school_id = $1 AND action = 'school.export'`, [S.schoolId])).rows[0].n;
    h.setToday(day(10));
    const before = await audits();
    expect((await admin.get('/school/export')).status).toBe(200);
    expect(await audits()).toBe(before + 1);
    h.setToday(day(60));
    expect((await admin.get('/school/export')).status).toBe(403);
    expect(await audits()).toBe(before + 1);
  });

  it('session bookkeeping still runs: logout works in restricted states', async () => {
    const { admin } = await school('wr-out');
    h.setToday(day(60));
    expect((await admin.get('/auth/me')).status).toBe(200);
    expect((await admin.post('/auth/logout')).status).toBe(200);
    expect((await admin.get('/auth/me')).status).toBe(401);
  });
});
