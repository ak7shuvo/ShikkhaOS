import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, harness, loginAs, PASSWORD, seed, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let S: SeededSchool;
let DOMAIN: string;

beforeAll(async () => {
  h = await harness({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '15' });
  S = await seed(h, 'hard');
  DOMAIN = S.users.admin.email.split('@')[1]!;
});
afterAll(() => h.close());

async function membershipId(userId: string): Promise<string> {
  const { rows } = await h.owner.query('SELECT id FROM school_memberships WHERE user_id = $1', [userId]);
  return rows[0].id;
}

describe('change-password attempt counter (L-1)', () => {
  it('locks after repeated wrong current passwords and blocks even the correct one', async () => {
    const c = await loginAs(h, S.users.teacher.email);
    const bad = { current_password: 'wrong-wrong-1', new_password: 'another-long-password' };
    for (let i = 0; i < 3; i++) expect((await c.post('/auth/change-password', bad)).body.error.code).toBe('WRONG_PASSWORD');
    const r = await c.post('/auth/change-password', { current_password: PASSWORD, new_password: 'another-long-password' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
    // the lock also applies to login
    expect((await new Client(h.app).login(S.users.teacher.email)).status).toBe(401);
  });

  it('a successful change resets the failure counter', async () => {
    const c = await loginAs(h, S.users.guardian.email);
    const bad = { current_password: 'wrong-wrong-1', new_password: 'another-long-password' };
    for (let i = 0; i < 2; i++) await c.post('/auth/change-password', bad);
    expect((await c.post('/auth/change-password', { current_password: PASSWORD, new_password: 'another-long-password' })).status).toBe(200);
    const { rows } = await h.owner.query('SELECT failed_login_count FROM users WHERE id = $1', [S.users.guardian.id]);
    expect(rows[0].failed_login_count).toBe(0);
  });
});

describe('last administrator and self guard (L-2)', () => {
  it('refuses to suspend or remove the only school_admin, and one admin cannot change themself', async () => {
    const admin = await loginAs(h, S.users.admin.email);
    const own = await membershipId(S.users.admin.id);
    for (const status of ['suspended', 'removed']) {
      const r = await admin.req('PATCH', `/school/members/${own}`, { status });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('CANNOT_CHANGE_SELF');
    }
    expect((await admin.req('PATCH', `/school/members/${own}`, { status: 'active' })).status).toBe(200);
  });

  it('with two admins: cannot touch self, can suspend the other, then the remaining one is protected', async () => {
    const email = `second.admin@${DOMAIN}`;
    const admin = await loginAs(h, S.users.admin.email);
    const created = await admin.post('/school/members', { email, full_name: 'Second Admin', initial_password: 'long-enough-password', role: 'school_admin' });
    expect(created.status).toBe(201);
    const second = new Client(h.app);
    expect((await second.login(email, 'long-enough-password')).status).toBe(200);
    const firstId = await membershipId(S.users.admin.id);
    const secondId = created.body.id as string;
    // second admin suspends the first; now second is the last admin
    expect((await second.req('PATCH', `/school/members/${firstId}`, { status: 'suspended' })).status).toBe(200);
    const r = await second.req('PATCH', `/school/members/${secondId}`, { status: 'removed' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CANNOT_CHANGE_SELF');
  });

  it('concurrent cross-demotion of two admins leaves exactly one active administrator', async () => {
    const e1 = `race.one@${DOMAIN}`;
    const e2 = `race.two@${DOMAIN}`;
    const root = new Client(h.app);
    expect((await root.login(`second.admin@${DOMAIN}`, 'long-enough-password')).status).toBe(200);
    const m1 = (await root.post('/school/members', { email: e1, full_name: 'Race One', initial_password: 'long-enough-password', role: 'school_admin' })).body
      .id as string;
    const m2 = (await root.post('/school/members', { email: e2, full_name: 'Race Two', initial_password: 'long-enough-password', role: 'school_admin' })).body
      .id as string;
    // suspend the unrelated admins so only the race pair remains
    await h.owner.query(`UPDATE school_memberships SET status = 'suspended' WHERE role = 'school_admin' AND id NOT IN ($1,$2)`, [m1, m2]);
    const c1 = new Client(h.app);
    const c2 = new Client(h.app);
    await c1.login(e1, 'long-enough-password');
    await c2.login(e2, 'long-enough-password');
    const res = await Promise.all([
      c1.req('PATCH', `/school/members/${m2}`, { status: 'suspended' }),
      c2.req('PATCH', `/school/members/${m1}`, { status: 'suspended' }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await h.owner.query("SELECT count(*)::int AS n FROM school_memberships WHERE role = 'school_admin' AND status = 'active'");
    expect(rows[0].n).toBe(1);
  });

  it('non-admin memberships are unaffected', async () => {
    const admin = new Client(h.app);
    await h.owner.query(`UPDATE school_memberships SET status = 'active' WHERE role = 'school_admin'`);
    expect((await admin.login(S.users.admin.email)).status).toBe(200);
    const id = await membershipId(S.users.teacher2.id);
    expect((await admin.req('PATCH', `/school/members/${id}`, { status: 'suspended' })).status).toBe(200);
  });
});
