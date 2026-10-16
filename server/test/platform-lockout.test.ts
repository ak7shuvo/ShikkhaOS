import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/passwords.js';
import { Client, harness, PASSWORD, uniqueCode, type Harness } from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await harness({ LOGIN_MAX_FAILURES: '3', PLATFORM_LOGIN_ACCOUNT_MAX_FAILURES: '10', LOGIN_LOCK_MINUTES: '15', LOGIN_RATE_LIMIT_PER_MINUTE: '1000' });
});
afterAll(() => h.close());

async function admin() {
  const email = `${uniqueCode('lk')}@petra.example.test`;
  const id = (
    await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'L') RETURNING id`, [
      email,
      await hashPassword(PASSWORD),
    ])
  ).rows[0].id as string;
  return { email, id };
}
const from = (ip: string) => {
  const c = new Client(h.app);
  c.ip = ip;
  return c;
};
const login = (c: Client, email: string, password: string) => c.req('POST', '/platform/auth/login', { email, password });

describe('platform login lockout per (administrator, source address) — M-2', () => {
  it('an attacker locks only their own address; the owner on another address still signs in', async () => {
    const a = await admin();
    for (let i = 0; i < 3; i++) expect((await login(from('203.0.113.9'), a.email, 'bad-password-xx')).status).toBe(401);
    expect((await login(from('203.0.113.9'), a.email, PASSWORD)).status).toBe(401); // attacker address locked, even with the right password
    expect((await login(from('198.51.100.5'), a.email, PASSWORD)).status).toBe(200); // the owner elsewhere is fine
  });

  it('distributed guessing reaches the higher account-wide ceiling, which locks everyone', async () => {
    const a = await admin();
    for (let i = 0; i < 10; i++) await login(from(`192.0.2.${i + 1}`), a.email, 'bad-password-xx');
    expect((await login(from('198.51.100.77'), a.email, PASSWORD)).status).toBe(401);
    expect((await h.control.query('SELECT failed_login_count FROM platform_admins WHERE id = $1', [a.id])).rows[0].failed_login_count).toBe(10);
  });

  it('failed re-authentication from a signed-in session counts for its own address, not for everyone', async () => {
    const a = await admin();
    const owner = from('198.51.100.5');
    expect((await login(owner, a.email, PASSWORD)).status).toBe(200);
    const bad = () => owner.post('/platform/auth/change-password', { current_password: 'wrong-wrong-wrong', new_password: 'another-long-password-9' });
    for (let i = 0; i < 3; i++) expect((await bad()).body.error.code).toBe('WRONG_PASSWORD');
    expect((await bad()).body.error.code).toBe('ACCOUNT_LOCKED');
    expect((await login(from('203.0.113.50'), a.email, PASSWORD)).status).toBe(200); // another address is not affected
  });

  it('a successful login clears only that address; unknown account and wrong password stay indistinguishable', async () => {
    const a = await admin();
    const c = from('198.51.100.6');
    for (let i = 0; i < 2; i++) await login(c, a.email, 'bad-password-xx');
    expect((await login(c, a.email, PASSWORD)).status).toBe(200);
    expect((await h.control.query('SELECT 1 FROM platform_login_attempts WHERE admin_id = $1 AND ip = $2', [a.id, '198.51.100.6'])).rowCount).toBe(0);
    const bad = await login(from('198.51.100.7'), a.email, 'bad-password-xx');
    const unknown = await login(from('198.51.100.7'), 'nobody@petra.example.test', 'bad-password-xx');
    expect(bad.body).toEqual(unknown.body);
  });
});
