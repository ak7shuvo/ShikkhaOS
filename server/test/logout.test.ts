import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/entitlements.js';
import { provisionSchool } from '../src/provisioning.js';
import { controlFixture, registerNew, type ControlFixture } from './fixtures.js';
import { acceptInitialPassword, Client, harness, loginAs, seed, setSubscription, type Harness } from './helpers.js';

let h: Harness;
let f: ControlFixture;

beforeAll(async () => {
  h = await harness();
  f = await controlFixture();
});
afterAll(async () => {
  await f.close();
  await h.close();
});

const setStatus = (id: string, status: string) => f.control.query(`UPDATE schools SET status = $2 WHERE id = $1`, [id, status]);
const clearsCookie = (set: unknown) =>
  /^sid=;/.test(String(Array.isArray(set) ? set[0] : set)) && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(String(Array.isArray(set) ? set[0] : set));

describe('POST /auth/logout works in every school state', () => {
  const states: [string, (id: string) => Promise<void>][] = [
    ['suspended (manual)', async (id) => void (await h.control.query(`UPDATE subscriptions SET status = 'suspended' WHERE school_id = $1`, [id]))],
    [
      'blocked (lapsed past grace and read-only)',
      async (id) => {
        await setSubscription(h, id, { status: 'active', period_start: '2026-01-01', period_end: '2026-03-31', grace_days: 7, readonly_days: 30 });
        h.setToday(addDays('2026-03-31', 38));
      },
    ],
    ['registry status suspended', (id) => setStatus(id, 'suspended').then(() => undefined)],
    ['maintenance', (id) => setStatus(id, 'maintenance').then(() => undefined)],
    ['offboarding', (id) => setStatus(id, 'offboarding').then(() => undefined)],
  ];

  for (const [name, apply] of states) {
    it(`${name}: clears the cookie, deletes the session, and the old cookie is dead afterwards`, async () => {
      const S = await seed(h, 'lo');
      const admin = await loginAs(h, S.users.admin.email);
      const cookie = admin.cookie;
      expect((await admin.get('/auth/me')).status).toBe(200);
      await apply(S.schoolId);

      const res = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173', cookie }, payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, revoked: true });
      expect(clearsCookie(res.headers['set-cookie'])).toBe(true);

      // reopen the school and prove the session really is gone server-side
      h.setToday('2026-03-01');
      await setSubscription(h, S.schoolId, { status: 'active', period_end: '2099-12-31' });
      await h.control.query(`UPDATE subscriptions SET status = 'active' WHERE school_id = $1`, [S.schoolId]);
      await setStatus(S.schoolId, 'active');
      const again = new Client(h.app);
      again.cookie = cookie;
      expect((await again.get('/auth/me')).status).toBe(401);
    });
  }

  it('does not weaken authorization elsewhere: the same suspended/blocked school still refuses every other school endpoint', async () => {
    const S = await seed(h, 'lo2');
    const admin = await loginAs(h, S.users.admin.email);
    await h.control.query(`UPDATE subscriptions SET status = 'suspended' WHERE school_id = $1`, [S.schoolId]);
    expect((await admin.get('/school')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    expect((await admin.get('/classes')).status).toBe(403);
    expect((await admin.post('/classes', { name: 'x' })).status).toBe(403);
    expect((await admin.post('/auth/logout')).status).toBe(200);
    // a different, unauthenticated caller gets nothing for the same school
    const anon = new Client(h.app);
    expect((await anon.get('/classes')).status).toBe(401);
    expect((await anon.post('/auth/change-password', { current: 'a', next: 'b' })).status).toBe(401);
    expect((await anon.post('/auth/logout')).status).toBe(200); // idempotent, reveals nothing
  });
});

describe('logout never revokes someone else’s session or discloses anything', () => {
  it('forged token, garbage cookie, unknown school and missing cookie: always 200, cookie cleared, nothing revoked', async () => {
    const S = await seed(h, 'lo3');
    const victim = await loginAs(h, S.users.admin.email);
    const post = (cookie?: string) =>
      h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173', ...(cookie ? { cookie } : {}) }, payload: {} });
    for (const cookie of [`sid=${S.schoolId}.${'a'.repeat(43)}`, 'sid=garbage', `sid=00000000-0000-0000-0000-000000000000.${'b'.repeat(43)}`, undefined]) {
      const r = await post(cookie);
      expect(r.statusCode, String(cookie)).toBe(200);
      expect(r.json().revoked, String(cookie)).toBe(false);
      expect(clearsCookie(r.headers['set-cookie']), String(cookie)).toBe(true);
    }
    expect((await victim.get('/auth/me')).status).toBe(200); // victim session intact
  });

  it('a valid token presented with another school’s id does not revoke the real session', async () => {
    const A = await seed(h, 'lo4a');
    const B = await seed(h, 'lo4b');
    const a = await loginAs(h, A.users.admin.email);
    const token = a.cookie.split('=')[1]!.split('.')[1]!;
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'http://localhost:5173', cookie: `sid=${B.schoolId}.${token}` },
      payload: {},
    });
    expect(r.json().revoked).toBe(false);
    expect((await a.get('/auth/me')).status).toBe(200);
  });

  it('archived and failed schools: logout still answers 200 and clears the cookie without touching a database', async () => {
    const S = await seed(h, 'lo5');
    const admin = await loginAs(h, S.users.admin.email);
    await setStatus(S.schoolId, 'archived');
    const r = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173', cookie: admin.cookie }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBe(false);
    expect(clearsCookie(r.headers['set-cookie'])).toBe(true);
  });
});

describe('dedicated database schools', () => {
  it('logout deletes the session inside the school database, also while the school is in maintenance', async () => {
    const { id, slug } = await registerNew(f, 'lo-ded');
    const p = await provisionSchool(f.deps, id);
    const admin = new Client(h.app);
    expect((await admin.login(`admin@${slug}.example.test`, p.adminInitialPassword!, slug)).status).toBe(200);
    await acceptInitialPassword(admin, p.adminInitialPassword!);
    const cookie = admin.cookie;
    await setStatus(id, 'maintenance');
    const r = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173', cookie }, payload: {} });
    expect(r.json()).toEqual({ ok: true, revoked: true });
    await setStatus(id, 'active');
    const again = new Client(h.app);
    again.cookie = cookie;
    expect((await again.get('/auth/me')).status).toBe(401);
  });
});
