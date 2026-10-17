import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, harness, PASSWORD, seed, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let S: SeededSchool;

beforeAll(async () => {
  h = await harness({ LOGIN_MAX_FAILURES: '3', LOGIN_ACCOUNT_MAX_FAILURES: '10', LOGIN_LOCK_MINUTES: '15', LOGIN_RATE_LIMIT_PER_MINUTE: '1000' });
  S = await seed(h, 'lock');
});
afterAll(() => h.close());

const from = (ip: string) => {
  const c = new Client(h.app);
  c.ip = ip;
  return c;
};

describe('login lockout per (account, source address) — M-2', () => {
  it('an attacker locks only their own address; the owner on another address still signs in', async () => {
    const email = S.users.teacher.email;
    for (let i = 0; i < 3; i++) expect((await from('203.0.113.7').login(email, 'bad-password-xx')).status).toBe(401);
    // the attacker is now locked out, even with the correct password
    expect((await from('203.0.113.7').login(email, PASSWORD)).status).toBe(401);
    // the owner elsewhere is unaffected
    expect((await from('198.51.100.20').login(email, PASSWORD)).status).toBe(200);
  });

  it('a successful login clears only that address’s counter', async () => {
    const email = S.users.teacher2.email;
    const c = from('198.51.100.30');
    for (let i = 0; i < 2; i++) await c.login(email, 'bad-password-xx');
    expect((await c.login(email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 2; i++) await from('198.51.100.30').login(email, 'bad-password-xx');
    expect((await from('198.51.100.30').login(email, PASSWORD)).status).toBe(200); // counter had been reset, 2 < 3
  });

  it('distributed guessing hits the higher account-wide ceiling, which locks everyone out', async () => {
    const email = S.users.guardian.email;
    for (let i = 0; i < 10; i++) await from(`192.0.2.${i + 1}`).login(email, 'bad-password-xx'); // one failure per address
    expect((await from('198.51.100.40').login(email, PASSWORD)).status).toBe(401);
    const { rows } = await h.owner.query('SELECT failed_login_count FROM users WHERE id = $1', [S.users.guardian.id]);
    expect(rows[0].failed_login_count).toBe(10);
  });

  it('unknown e-mail and wrong password stay indistinguishable', async () => {
    const a = await from('198.51.100.50').login(S.users.guardian2.email, 'bad-password-xx');
    const b = await from('198.51.100.50').login('nobody@lock.example.test', 'bad-password-xx');
    expect(a.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('lock rows are keyed by account and address and carry no password material', async () => {
    const { rows } = await h.owner.query("SELECT user_id, ip FROM login_attempts WHERE ip = '203.0.113.7'");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(S.users.teacher.id);
  });
});
