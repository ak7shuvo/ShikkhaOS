import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, harness, loginAs, PASSWORD, seed, setSubscription, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let A: SeededSchool;

beforeAll(async () => {
  h = await harness({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '15' });
  A = await seed(h, 'auth');
});
afterAll(() => h.close());

describe('authentication', () => {
  it('rejects unauthenticated access to protected routes', async () => {
    for (const url of ['/school', '/students', '/result-sheets', '/guardian/students', '/platform/schools', '/auth/me']) {
      const r = await new Client(h.app).get(url);
      expect(r.status, url).toBe(401);
    }
  });

  it('logs in with valid credentials, sets an HttpOnly SameSite=Strict cookie, never returns the hash', async () => {
    const c = new Client(h.app);
    const r = await c.login(A.users.admin.email);
    expect(r.status).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(r.body)).not.toMatch(/password|argon2/i);
    expect(r.body.active_school_id).toBe(A.schoolId);
    expect(r.body.roles).toEqual(['school_admin']);
  });

  it('passwords are stored as argon2id hashes', async () => {
    const { rows } = await h.owner.query('SELECT password_hash FROM users WHERE id = $1', [A.users.admin.id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('gives the same generic error for wrong password and unknown user', async () => {
    const a = await new Client(h.app).login(A.users.teacher.email, 'wrong-password-1');
    const b = await new Client(h.app).login('nobody@nowhere.example.test', 'wrong-password-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const email = A.users.teacher2.email;
    for (let i = 0; i < 3; i++) expect((await new Client(h.app).login(email, 'bad-password-xx')).status).toBe(401);
    const locked = await new Client(h.app).login(email, PASSWORD);
    expect(locked.status).toBe(401);
    await h.owner.query(`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = $1`, [email]);
    expect((await new Client(h.app).login(email, PASSWORD)).status).toBe(401); // the per-address lock is separate
    await h.owner.query(`DELETE FROM login_attempts WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
    expect((await new Client(h.app).login(email, PASSWORD)).status).toBe(200);
  });

  it('validates the login body', async () => {
    const r = await new Client(h.app).req('POST', '/auth/login', { email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logout invalidates the server-side session', async () => {
    const c = await loginAs(h, A.users.principal.email);
    const saved = c.cookie;
    expect((await c.get('/auth/me')).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(200);
    const replay = new Client(h.app);
    replay.cookie = saved;
    expect((await replay.get('/auth/me')).status).toBe(401);
  });

  it('rejects forged or expired session tokens', async () => {
    const forged = new Client(h.app);
    forged.cookie = 'sid=not-a-real-token';
    expect((await forged.get('/auth/me')).status).toBe(401);
    const c = await loginAs(h, A.users.principal.email);
    await h.owner.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [A.users.principal.id]);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const c = await loginAs(h, A.users.controller.email);
    const value = c.cookie.split('=')[1]!;
    expect(value.startsWith(`${A.schoolId}.`)).toBe(true);
    const token = value.slice(37);
    const { rows } = await h.owner.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', [token]);
    expect(rows[0].n).toBe(0);
  });

  it('disabled users and removed memberships lose access immediately', async () => {
    const c = await loginAs(h, A.users.teacher.email);
    expect((await c.get('/exams')).status).toBe(200);
    await h.owner.query(`UPDATE school_memberships SET status = 'suspended' WHERE user_id = $1`, [A.users.teacher.id]);
    const r = await c.get('/exams');
    expect([403, 409]).toContain(r.status);
    await h.owner.query(`UPDATE school_memberships SET status = 'active' WHERE user_id = $1`, [A.users.teacher.id]);
    await h.owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [A.users.teacher.id]);
    expect((await c.get('/exams')).status).toBe(401);
    expect((await new Client(h.app).login(A.users.teacher.email)).status).toBe(401);
    await h.owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [A.users.teacher.id]);
  });

  it('blocks access when the school row is suspended or the subscription is blocked', async () => {
    const c = await loginAs(h, A.users.admin.email);
    await setSubscription(h, A.schoolId, { status: 'suspended' });
    const lic = await c.get('/school');
    expect(lic.status).toBe(403);
    expect(lic.body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    await setSubscription(h, A.schoolId, { status: 'active' });
    expect((await c.get('/school')).status).toBe(200);
    await h.owner.query(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [A.schoolId]);
    expect((await c.get('/school')).status).toBe(409);
    await h.owner.query(`UPDATE schools SET status = 'active' WHERE id = $1`, [A.schoolId]);
  });

  it('rejects state-changing requests from foreign origins (CSRF)', async () => {
    const c = await loginAs(h, A.users.admin.email);
    const r = await c.req('POST', '/classes', { name: 'X' }, { origin: 'https://evil.example.test' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BAD_ORIGIN');
  });

  it('a user belonging to two schools (shared mode) can only log in to a school where they hold an active membership', async () => {
    const other = await seed(h, 'auth-multi');
    const email = A.users.principal.email;
    // Not a member of `other`: the same credentials must not open it.
    expect((await new Client(h.app).login(email, PASSWORD, other.code)).status).toBe(401);
    await h.owner.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,'teacher')`, [other.schoolId, A.users.principal.id]);
    const c = new Client(h.app);
    const r = await c.login(email, PASSWORD, other.code);
    expect(r.status).toBe(200);
    // Roles are per school: teacher in `other`, never the principal role from A.
    expect(r.body.roles).toEqual(['teacher']);
    expect(r.body.school.id).toBe(other.schoolId);
    const mine = await loginAs(h, email);
    expect((await mine.get('/auth/me')).body.roles).toEqual(['principal']);
  });

  it('a session cookie is only valid in the school that issued it (forged school prefix)', async () => {
    const other = await seed(h, 'auth-forge');
    const c = await loginAs(h, A.users.admin.email);
    const token = c.cookie.split('=')[1]!.slice(37);
    const forged = new Client(h.app);
    forged.cookie = `sid=${other.schoolId}.${token}`;
    expect((await forged.get('/auth/me')).status).toBe(401);
    expect((await forged.get('/students')).status).toBe(401);
    const unknownSchool = new Client(h.app);
    unknownSchool.cookie = `sid=00000000-0000-4000-8000-000000000000.${token}`;
    expect((await unknownSchool.get('/auth/me')).status).toBe(401);
  });

  it('login requires a school slug; unknown or unready schools are indistinguishable from bad credentials', async () => {
    const c = new Client(h.app);
    expect((await c.req('POST', '/auth/login', { email: A.users.admin.email, password: PASSWORD })).status).toBe(400);
    const wrongSlug = await c.login(A.users.admin.email, PASSWORD, 'no-such-school');
    const wrongPw = await c.login(A.users.admin.email, 'wrong-password-1');
    expect(wrongSlug.status).toBe(401);
    expect(wrongSlug.body).toEqual({ error: { ...wrongPw.body.error } });
    await h.control.query(`UPDATE schools SET status = 'provisioning' WHERE id = $1`, [A.schoolId]);
    expect((await c.login(A.users.admin.email)).status).toBe(401);
    await h.control.query(`UPDATE schools SET status = 'active' WHERE id = $1`, [A.schoolId]);
  });

  it('idle sessions expire, and the session cap evicts the oldest', async () => {
    const idle = await harness({ SESSION_IDLE_MINUTES: '5', MAX_SESSIONS_PER_USER: '2' });
    try {
      const S = await seed(idle, 'auth-idle');
      const first = await loginAs(idle, S.users.admin.email);
      await loginAs(idle, S.users.admin.email);
      await loginAs(idle, S.users.admin.email);
      expect((await first.get('/auth/me')).status).toBe(401); // evicted by the third login (cap 2)
      const c = await loginAs(idle, S.users.teacher.email);
      expect((await c.get('/auth/me')).status).toBe(200);
      await idle.owner.query(`UPDATE sessions SET last_seen_at = now() - interval '6 minutes' WHERE user_id = $1`, [S.users.teacher.id]);
      const r = await c.get('/auth/me');
      expect(r.status).toBe(401);
    } finally {
      await idle.close();
    }
  });

  it('change-password verifies the current password, applies immediately and revokes other sessions', async () => {
    const a = await loginAs(h, A.users.guardian2.email);
    const b = await loginAs(h, A.users.guardian2.email);
    expect((await a.post('/auth/change-password', { current_password: 'wrong-wrong-1', new_password: 'another-long-password' })).status).toBe(403);
    expect((await a.post('/auth/change-password', { current_password: PASSWORD, new_password: 'short' })).status).toBe(400);
    expect((await a.post('/auth/change-password', { current_password: PASSWORD, new_password: 'another-long-password' })).status).toBe(200);
    expect((await b.get('/auth/me')).status).toBe(401);
    expect((await a.get('/auth/me')).status).toBe(200);
    expect((await new Client(h.app).login(A.users.guardian2.email, PASSWORD)).status).toBe(401);
    expect((await new Client(h.app).login(A.users.guardian2.email, 'another-long-password')).status).toBe(200);
  });
});

describe('login rate limiting', () => {
  it('returns 429 after too many attempts per minute', async () => {
    const lim = await harness({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await new Client(lim.app).login('xx@yy.example.test', 'whatever-123')).status);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await lim.close();
    }
  });
});
