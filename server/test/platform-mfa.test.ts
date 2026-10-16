import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/passwords.js';
import { generateMasterKey } from '../src/secrets.js';
import { totpAt } from '../src/totp.js';
import { Client, harness, PASSWORD, uniqueCode, type Harness } from './helpers.js';

const NEW_PASSWORD = 'a-much-longer-new-passphrase-42';
let h: Harness; // MFA required (the production default)
let optional: Harness; // MFA not required (development/test default)

beforeAll(async () => {
  h = await harness({ PLATFORM_MFA_REQUIRED: 'true', LOGIN_MAX_FAILURES: '4' });
  optional = await harness();
});
afterAll(async () => {
  await h.close();
  await optional.close();
});

async function newAdmin(hh: Harness, password = PASSWORD) {
  const email = `${uniqueCode('mfa')}@petra.example.test`;
  const id = (
    await hh.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'MFA Test') RETURNING id`, [
      email,
      await hashPassword(password),
    ])
  ).rows[0].id as string;
  return { email, id };
}
const login = (hh: Harness, body: Record<string, unknown>, c = new Client(hh.app)) => c.req('POST', '/platform/auth/login', body).then((r) => ({ ...r, c }));
const code = (hh: Harness, secret: string, offsetSteps = 0) => totpAt(secret, hh.clock.now.getTime() + offsetSteps * 30_000);
const advance = (hh: Harness, seconds: number) => (hh.clock.now = new Date(hh.clock.now.getTime() + seconds * 1000));

/** Enrols MFA for a fresh admin and returns everything a test needs. */
async function enrolled(hh: Harness) {
  const a = await newAdmin(hh);
  const { c } = await login(hh, { email: a.email, password: PASSWORD });
  const en = await c.req('POST', '/platform/auth/mfa/enrol', { current_password: PASSWORD });
  expect(en.status).toBe(200);
  const secret = en.body.secret as string;
  const cf = await c.req('POST', '/platform/auth/mfa/confirm', { code: code(hh, secret) });
  expect(cf.status).toBe(200);
  return { ...a, secret, recovery: cf.body.recovery_codes as string[], c };
}

describe('MFA not required (development/test default)', () => {
  it('password-only administrators keep working and are not forced to enrol', async () => {
    const a = await newAdmin(optional);
    const r = await login(optional, { email: a.email, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.mfa).toEqual({ enabled: false, state: 'ok' });
    expect((await r.c.get('/platform/schools')).status).toBe(200);
  });
});

describe('MFA required: enrolment', () => {
  it('a password-only session can do nothing but identify itself, enrol and sign out', async () => {
    const a = await newAdmin(h);
    const { c, body } = await login(h, { email: a.email, password: PASSWORD });
    expect(body.mfa).toEqual({ enabled: false, state: 'enrolment_required' });
    expect((await c.get('/platform/auth/me')).body.mfa).toEqual({ enabled: false, required: true, state: 'enrolment_required' });
    for (const url of ['/platform/schools', '/platform/audit', '/platform/releases']) {
      const r = await c.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('MFA_ENROLMENT_REQUIRED');
    }
    expect((await c.post('/platform/auth/change-password', { current_password: PASSWORD, new_password: NEW_PASSWORD })).status).toBe(403);
    expect((await c.post('/platform/auth/mfa/recovery-codes', { current_password: PASSWORD, mfa_code: '123456' })).status).toBe(403);
    expect((await c.post('/platform/auth/logout')).status).toBe(200);
  });

  it('enrolment needs the password again, then proof that the authenticator works', async () => {
    const a = await newAdmin(h);
    const { c } = await login(h, { email: a.email, password: PASSWORD });
    expect((await c.req('POST', '/platform/auth/mfa/enrol', {})).status).toBe(400);
    const wrong = await c.req('POST', '/platform/auth/mfa/enrol', { current_password: 'not-the-password-1' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    expect((await c.post('/platform/auth/mfa/confirm', { code: '123456' })).body.error.code).toBe('NO_PENDING_ENROLMENT');

    const en = await c.req('POST', '/platform/auth/mfa/enrol', { current_password: PASSWORD });
    expect(en.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(en.body.otpauth_uri).toContain(`secret=${en.body.secret}`);
    expect(en.body.otpauth_uri).toContain(encodeURIComponent(a.email));
    // not active yet
    expect((await c.get('/platform/schools')).status).toBe(403);
    const bad = await c.post('/platform/auth/mfa/confirm', { code: code(h, en.body.secret, 5) });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_MFA_CODE');

    const ok = await c.post('/platform/auth/mfa/confirm', { code: code(h, en.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.enabled).toBe(true);
    expect(ok.body.recovery_codes).toHaveLength(10);
    for (const rc of ok.body.recovery_codes) expect(rc).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect((await c.get('/platform/schools')).status).toBe(200); // this session is now fully verified
    expect((await c.get('/platform/auth/me')).body.mfa).toEqual({ enabled: true, required: true, state: 'ok' });
    expect((await c.req('POST', '/platform/auth/mfa/enrol', { current_password: PASSWORD })).status).toBe(409); // cannot re-enrol over an active factor
    expect((await c.post('/platform/auth/mfa/confirm', { code: code(h, en.body.secret) })).status).toBe(409);
  });

  it('stores the secret encrypted and the recovery codes only as hashes; never leaks either into the audit trail', async () => {
    const e = await enrolled(h);
    const row = (
      await h.control.query(`SELECT mfa_secret_enc, mfa_pending_secret_enc, mfa_enabled_at, mfa_last_step FROM platform_admins WHERE id = $1`, [e.id])
    ).rows[0];
    expect(row.mfa_secret_enc).toMatch(/^v1\./);
    expect(row.mfa_secret_enc).not.toContain(e.secret);
    expect(row.mfa_pending_secret_enc).toBeNull();
    expect(row.mfa_enabled_at).not.toBeNull();
    const hashes = (await h.control.query(`SELECT code_hash FROM platform_recovery_codes WHERE admin_id = $1`, [e.id])).rows.map((r) => r.code_hash as string);
    expect(hashes).toHaveLength(10);
    for (const rc of e.recovery) expect(hashes.join(' ')).not.toContain(rc.replace('-', ''));
    const audit = JSON.stringify((await h.control.query(`SELECT action, metadata FROM platform_audit_events WHERE actor_id = $1`, [e.id])).rows);
    expect(audit).toContain('platform.mfa_enrolled');
    expect(audit).not.toContain(e.secret);
    for (const rc of e.recovery) expect(audit).not.toContain(rc);
  });

  it('activating MFA ends every other session of that administrator', async () => {
    const a = await newAdmin(h);
    const other = (await login(h, { email: a.email, password: PASSWORD })).c;
    const { c } = await login(h, { email: a.email, password: PASSWORD });
    const en = await c.req('POST', '/platform/auth/mfa/enrol', { current_password: PASSWORD });
    await c.post('/platform/auth/mfa/confirm', { code: code(h, en.body.secret) });
    expect((await other.get('/platform/auth/me')).status).toBe(401);
    expect((await c.get('/platform/auth/me')).status).toBe(200);
  });
});

describe('MFA required: sign-in', () => {
  it('needs a code after the password; a wrong or missing code never creates a session', async () => {
    const e = await enrolled(h);
    advance(h, 60);
    const none = await login(h, { email: e.email, password: PASSWORD });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('MFA_REQUIRED');
    expect(none.headers['set-cookie']).toBeUndefined();
    const wrong = await login(h, { email: e.email, password: PASSWORD, mfa_code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_MFA_CODE');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: 'abcdef' })).status).toBe(400);
    expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: '123456', recovery_code: 'ABCDE-FGHIJ' })).status).toBe(400);
    // a correct code with a wrong password is just a failed login (no MFA oracle)
    const bad = await login(h, { email: e.email, password: 'wrong-password-12', mfa_code: code(h, e.secret) });
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const ok = await login(h, { email: e.email, password: PASSWORD, mfa_code: code(h, e.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.mfa).toEqual({ enabled: true, state: 'ok' });
    expect((await ok.c.get('/platform/schools')).status).toBe(200);
  });

  it('a TOTP code is single-use: replaying it (even inside its window) fails, the next step works', async () => {
    const e = await enrolled(h);
    advance(h, 60);
    const used = code(h, e.secret);
    expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: used })).status).toBe(200);
    const replay = await login(h, { email: e.email, password: PASSWORD, mfa_code: used });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');
    advance(h, 30);
    expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: code(h, e.secret) })).status).toBe(200);
  });

  it('two concurrent logins with the same code: exactly one succeeds', async () => {
    const e = await enrolled(h);
    advance(h, 90);
    const c1 = code(h, e.secret);
    const rs = await Promise.all([
      login(h, { email: e.email, password: PASSWORD, mfa_code: c1 }),
      login(h, { email: e.email, password: PASSWORD, mfa_code: c1 }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('recovery codes work exactly once, are case/dash tolerant, and every use is audited', async () => {
    const e = await enrolled(h);
    const rc = e.recovery[0]!;
    const ok = await login(h, { email: e.email, password: PASSWORD, recovery_code: rc.toLowerCase().replace('-', ' ') });
    expect(ok.status).toBe(200);
    expect((await ok.c.get('/platform/schools')).status).toBe(200);
    const again = await login(h, { email: e.email, password: PASSWORD, recovery_code: rc });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('INVALID_MFA_CODE');
    expect((await login(h, { email: e.email, password: PASSWORD, recovery_code: e.recovery[1]! })).status).toBe(200); // a different one still works
    const used = (await h.control.query(`SELECT count(*)::int AS n FROM platform_recovery_codes WHERE admin_id = $1 AND used_at IS NOT NULL`, [e.id])).rows[0]
      .n;
    expect(used).toBe(2);
    const audit = (await h.control.query(`SELECT metadata FROM platform_audit_events WHERE actor_id = $1 AND action = 'platform.login'`, [e.id])).rows.map(
      (r) => r.metadata,
    );
    expect(audit.filter((m) => m.recovery_code === true)).toHaveLength(2);
  });

  it('wrong second factors count towards the lockout; a locked account refuses even valid credentials', async () => {
    const e = await enrolled(h);
    advance(h, 60);
    for (let i = 0; i < 4; i++) expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: '111111' })).status).toBe(401);
    const locked = await login(h, { email: e.email, password: PASSWORD, mfa_code: code(h, e.secret) });
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');
    await h.control.query(`UPDATE platform_admins SET locked_until = NULL, failed_login_count = 0 WHERE id = $1`, [e.id]);
    expect((await login(h, { email: e.email, password: PASSWORD, mfa_code: code(h, e.secret) })).status).toBe(200);
  });
});

describe('platform password change and recovery-code rotation', () => {
  it('changes the password after re-authentication, ends other sessions, and rejects weak / unchanged / wrong-current input', async () => {
    const e = await enrolled(h);
    const other = (await login(h, { email: e.email, password: PASSWORD, recovery_code: e.recovery[0]! })).c;
    const { c } = e;
    expect((await c.post('/platform/auth/change-password', { current_password: PASSWORD, new_password: 'short-pw-11' })).status).toBe(400); // < 12
    expect((await c.post('/platform/auth/change-password', { current_password: PASSWORD, new_password: PASSWORD })).status).toBe(400);
    const wrong = await c.post('/platform/auth/change-password', { current_password: 'not-the-password-1', new_password: NEW_PASSWORD });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    expect((await h.control.query(`SELECT failed_login_count FROM platform_admins WHERE id = $1`, [e.id])).rows[0].failed_login_count).toBe(1);

    expect((await c.post('/platform/auth/change-password', { current_password: PASSWORD, new_password: NEW_PASSWORD })).status).toBe(200);
    expect((await other.get('/platform/auth/me')).status).toBe(401); // other session revoked
    expect((await c.get('/platform/auth/me')).status).toBe(200); // this one stays
    expect((await login(h, { email: e.email, password: PASSWORD, recovery_code: e.recovery[2]! })).status).toBe(401); // old password is dead
    expect((await login(h, { email: e.email, password: NEW_PASSWORD, recovery_code: e.recovery[2]! })).status).toBe(200);
    const row = (await h.control.query(`SELECT password_changed_at FROM platform_admins WHERE id = $1`, [e.id])).rows[0];
    expect(row.password_changed_at).not.toBeNull();
    const audit = JSON.stringify((await h.control.query(`SELECT action, metadata FROM platform_audit_events WHERE actor_id = $1`, [e.id])).rows);
    expect(audit).toContain('platform.password_changed');
    expect(audit).not.toContain(NEW_PASSWORD);
  });

  it('repeated wrong current passwords lock the account (a stolen session cannot grind the password)', async () => {
    const e = await enrolled(h);
    for (let i = 0; i < 4; i++) await e.c.post('/platform/auth/change-password', { current_password: 'guess-number-' + i + '-x', new_password: NEW_PASSWORD });
    const r = await e.c.post('/platform/auth/change-password', { current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('regenerating recovery codes needs password + a fresh TOTP code and retires the old codes', async () => {
    const e = await enrolled(h);
    advance(h, 60);
    expect((await e.c.post('/platform/auth/mfa/recovery-codes', { current_password: PASSWORD, mfa_code: '000000' })).status).toBe(401);
    const used = code(h, e.secret);
    const ok = await e.c.post('/platform/auth/mfa/recovery-codes', { current_password: PASSWORD, mfa_code: used });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect((await e.c.post('/platform/auth/mfa/recovery-codes', { current_password: PASSWORD, mfa_code: used })).status).toBe(401); // same code cannot be reused
    expect((await login(h, { email: e.email, password: PASSWORD, recovery_code: e.recovery[0]! })).status).toBe(401); // old set retired
    expect((await login(h, { email: e.email, password: PASSWORD, recovery_code: ok.body.recovery_codes[0] })).status).toBe(200);
  });
});

describe('configuration and cookie properties', () => {
  it('MFA is required by default in production, cannot be switched off there, and is optional elsewhere', () => {
    const base = {
      CONTROL_DATABASE_URL: 'postgres://u:p@db.internal.example:5432/c',
      PETRA_MASTER_KEY: generateMasterKey(),
      ALLOWED_ORIGINS: 'https://app.example.test',
      TRUST_PROXY: '1',
      CONTROL_DB_SSL: 'true',
      SCHOOL_DB_SSL: 'true',
    };
    expect(loadConfig({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv).PLATFORM_MFA_REQUIRED).toBe(true);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PLATFORM_MFA_REQUIRED: 'false' } as NodeJS.ProcessEnv)).toThrow(
      /PLATFORM_MFA_REQUIRED must not be false/,
    );
    expect(loadConfig({ ...base, NODE_ENV: 'development' } as NodeJS.ProcessEnv).PLATFORM_MFA_REQUIRED).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'development', PLATFORM_MFA_REQUIRED: 'true' } as NodeJS.ProcessEnv).PLATFORM_MFA_REQUIRED).toBe(true);
  });

  it('the session cookie is unchanged: HttpOnly, SameSite=Strict, scoped to /api/platform, and never set for a failed second factor', async () => {
    const e = await enrolled(h);
    advance(h, 60);
    const ok = await login(h, { email: e.email, password: PASSWORD, mfa_code: code(h, e.secret) });
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/psid=/);
    expect(cookie).toMatch(/Path=\/api\/platform/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});
