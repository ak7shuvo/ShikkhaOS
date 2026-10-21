import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, harness, loginAs, seed, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let S: SeededSchool;
let DOMAIN: string;

beforeAll(async () => {
  h = await harness();
  S = await seed(h, 'fpc');
  DOMAIN = S.users.admin.email.split('@')[1]!;
});
afterAll(() => h.close());

describe('forced first-login password change (L-3)', () => {
  const email = () => `newhire@${DOMAIN}`;
  const INITIAL = 'initial-password-1';

  it('members created by an administrator must change the initial password before using the API', async () => {
    const admin = await loginAs(h, S.users.admin.email);
    expect((await admin.post('/school/members', { email: email(), full_name: 'New Hire', initial_password: INITIAL, role: 'teacher' })).status).toBe(201);

    const c = new Client(h.app);
    const login = await c.login(email(), INITIAL);
    expect(login.status).toBe(200);
    expect(login.body.user.credential_change_required).toBe(true);

    // everything except session endpoints is refused
    for (const url of ['/school', '/students', '/exams']) {
      const r = await c.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await c.get('/auth/me')).body.user.credential_change_required).toBe(true);

    // the same value is not a change
    const same = await c.post('/auth/change-password', { current_password: INITIAL, new_password: INITIAL });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');

    expect((await c.post('/auth/change-password', { current_password: INITIAL, new_password: 'chosen-by-the-user-1' })).status).toBe(200);
    const me = await c.get('/auth/me');
    expect(me.body.user.credential_change_required).toBe(false);
    expect((await c.get('/exams')).status).toBe(200);
  });

  it('a forced session can still log out', async () => {
    const admin = await loginAs(h, S.users.admin.email);
    const e = `other@${DOMAIN}`;
    await admin.post('/school/members', { email: e, full_name: 'Other', initial_password: INITIAL, role: 'teacher' });
    const c = new Client(h.app);
    await c.login(e, INITIAL);
    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('guardian accounts created with the guardian record are also forced', async () => {
    const admin = await loginAs(h, S.users.admin.email);
    const e = `parent@${DOMAIN}`;
    const r = await admin.post('/guardians', { full_name: 'Parent', account: { email: e, initial_password: INITIAL } });
    expect(r.status).toBe(201);
    const { rows } = await h.owner.query('SELECT must_change_password FROM users WHERE email = $1', [e]);
    expect(rows[0].must_change_password).toBe(true);
  });

  it('seeded and self-chosen accounts are not forced', async () => {
    const c = await loginAs(h, S.users.teacher.email);
    expect((await c.get('/auth/me')).body.user.credential_change_required).toBe(false);
  });
});
