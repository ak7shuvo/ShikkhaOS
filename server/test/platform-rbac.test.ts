import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/passwords.js';
import { generateMasterKey } from '../src/secrets.js';
import { totpAt } from '../src/totp.js';
import { Client, harness, PASSWORD, seed, uniqueCode, type Harness } from './helpers.js';
import type { SeededSchool } from '../src/seed-data.js';

let h: Harness;
let S: SeededSchool;

beforeAll(async () => {
  h = await harness({ PLATFORM_STEPUP_REQUIRED: 'true', PLATFORM_STEPUP_MINUTES: '5' });
  S = await seed(h, 'rbac');
});
afterAll(() => h.close());

async function admin(role: 'owner' | 'operator' | 'viewer') {
  const email = `${uniqueCode(role)}@petra.example.test`;
  await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ($1,$2,'T',$3)`, [
    email,
    await hashPassword(PASSWORD),
    role,
  ]);
  const c = new Client(h.app);
  expect((await c.req('POST', '/platform/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return c;
}
const status = (c: Client, s: 'active' | 'suspended') => c.patch(`/platform/schools/${S.schoolId}/status`, { status: s });
const advance = (seconds: number) => (h.clock.now = new Date(h.clock.now.getTime() + seconds * 1000));

describe('platform roles', () => {
  it('viewer: read-only', async () => {
    const v = await admin('viewer');
    expect((await v.get('/platform/schools')).status).toBe(200);
    expect((await v.get('/platform/audit')).status).toBe(200);
    expect((await v.get('/platform/auth/me')).body.role).toBe('viewer');
    const w = await v.post('/platform/schools', { slug: uniqueCode('vw').toLowerCase(), name: 'No' });
    expect([w.status, w.body.error.code]).toEqual([403, 'INSUFFICIENT_ROLE']);
    expect((await status(v, 'suspended')).body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('operator: may write but not perform destructive actions, even with a fresh step-up', async () => {
    const o = await admin('operator');
    const created = await o.post('/platform/schools', {
      slug: uniqueCode('op').toLowerCase(),
      name: 'Operator School',
      admin_email: 'head@op.example.test',
      admin_name: 'Head',
    });
    expect(created.status).toBe(201);
    expect((await o.post('/platform/auth/step-up', { current_password: PASSWORD })).status).toBe(200);
    const d = await status(o, 'suspended');
    expect([d.status, d.body.error.code]).toEqual([403, 'INSUFFICIENT_ROLE']);
    expect((await o.post(`/platform/schools/${S.schoolId}/subscription/suspend`, { reason: 'no way' })).body.error.code).toBe('INSUFFICIENT_ROLE');
    expect((await o.patch(`/platform/schools/${S.schoolId}/subscription/terms`, { grace_days: 3 })).body.error.code).toBe('INSUFFICIENT_ROLE');
    expect((await o.post(`/platform/schools/${S.schoolId}/subscription/cancel`)).body.error.code).toBe('INSUFFICIENT_ROLE');
    const { rows } = await h.control.query('SELECT status FROM schools WHERE id = $1', [S.schoolId]);
    expect(rows[0].status).toBe('active');
  });

  it('role names are validated by the database', async () => {
    await expect(
      h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name, role) VALUES ('x@y.example.test','h','x','root')`),
    ).rejects.toThrow();
  });
});

describe('step-up for destructive actions', () => {
  it('owner needs a recent step-up; it expires; a wrong password does not grant it', async () => {
    const o = await admin('owner');
    const blocked = await status(o, 'suspended');
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);

    const bad = await o.post('/platform/auth/step-up', { current_password: 'wrong-wrong-wrong' });
    expect(bad.status).toBe(403);
    expect((await status(o, 'suspended')).body.error.code).toBe('STEP_UP_REQUIRED');

    expect((await o.post('/platform/auth/step-up', { current_password: PASSWORD })).status).toBe(200);
    expect((await status(o, 'suspended')).status).toBe(200);
    expect((await status(o, 'active')).status).toBe(200); // still inside the window

    advance(5 * 60 + 1);
    expect((await status(o, 'suspended')).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await h.control.query('SELECT status FROM schools WHERE id = $1', [S.schoolId])).rows[0].status).toBe('active');
    expect((await h.control.query(`SELECT 1 FROM platform_audit_events WHERE action = 'platform.step_up'`)).rowCount).toBeGreaterThanOrEqual(1);
  });

  it('step-up does not carry over to another session', async () => {
    const email = `${uniqueCode('two')}@petra.example.test`;
    await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'T')`, [email, await hashPassword(PASSWORD)]);
    const a = new Client(h.app);
    const b = new Client(h.app);
    await a.req('POST', '/platform/auth/login', { email, password: PASSWORD });
    await b.req('POST', '/platform/auth/login', { email, password: PASSWORD });
    await a.post('/platform/auth/step-up', { current_password: PASSWORD });
    expect((await status(a, 'suspended')).status).toBe(200);
    expect((await status(b, 'active')).body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('with MFA enrolled the step-up needs a fresh TOTP code from a later window (replay-protected)', async () => {
    const hm = await harness({ PLATFORM_STEPUP_REQUIRED: 'true', PLATFORM_MFA_REQUIRED: 'true' });
    try {
      const email = `${uniqueCode('mfa')}@petra.example.test`;
      await hm.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'T')`, [email, await hashPassword(PASSWORD)]);
      const c = new Client(hm.app);
      await c.req('POST', '/platform/auth/login', { email, password: PASSWORD });
      const secret = (await c.req('POST', '/platform/auth/mfa/enrol', { current_password: PASSWORD })).body.secret as string;
      const t0 = hm.clock.now.getTime();
      expect((await c.req('POST', '/platform/auth/mfa/confirm', { code: totpAt(secret, t0) })).status).toBe(200);
      const sid = (await seed(hm, 'rbacm')).schoolId;
      const susp = () => c.patch(`/platform/schools/${sid}/status`, { status: 'suspended' });

      expect((await susp()).body.error.code).toBe('STEP_UP_REQUIRED');
      // the sign-in code is spent: the same window cannot be reused
      expect((await c.post('/platform/auth/step-up', { mfa_code: totpAt(secret, t0) })).body.error.code).toBe('INVALID_MFA_CODE');
      hm.clock.now = new Date(t0 + 31_000);
      expect((await c.post('/platform/auth/step-up', { mfa_code: totpAt(secret, hm.clock.now.getTime()) })).status).toBe(200);
      expect((await susp()).status).toBe(200);
      // password alone is not accepted when MFA is enabled
      expect((await c.post('/platform/auth/step-up', { current_password: PASSWORD })).status).toBe(400);
    } finally {
      await hm.close();
    }
  });
});

describe('configuration', () => {
  it('production refuses PLATFORM_STEPUP_REQUIRED=false and defaults it to on', () => {
    const prod = {
      NODE_ENV: 'production',
      CONTROL_DATABASE_URL: 'postgres://u:p@db.example.org:5432/petra_control',
      PETRA_MASTER_KEY: generateMasterKey(),
      ALLOWED_ORIGINS: 'https://app.example.org',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'none',
      CONTROL_DB_SSL: 'true',
      SCHOOL_DB_SSL: 'true',
      DB_SSL_CA_FILE: '/etc/hosts',
    };
    expect(() => loadConfig({ ...prod, PLATFORM_STEPUP_REQUIRED: 'false' })).toThrow(/PLATFORM_STEPUP_REQUIRED must not be false/);
    expect(loadConfig(prod).PLATFORM_STEPUP_REQUIRED).toBe(true);
  });
});
