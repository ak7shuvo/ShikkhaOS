import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLATFORM_COOKIE, parse, platformAuthz, platformOf } from '../context.js';
import { AppError } from '../errors.js';
import { PLATFORM_PASSWORD_MIN_LENGTH, burnPasswordCheck, hashPassword, hashToken, newSessionToken, verifyPassword } from '../passwords.js';
import { platformAudit } from '../registry.js';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from '../totp.js';

export const MFA_ISSUER = 'Petra ShikkhaOS';

const aad = (adminId: string) => `platform-mfa:${adminId}`;

/**
 * Platform-administrator authentication: password, TOTP MFA (with single-use recovery codes), enrolment and password change.
 * Every failed secret check (password, TOTP, recovery code) feeds the same per-account lockout counter.
 */
export async function platformAuthRoutes(app: FastifyInstance): Promise<void> {
  const { control, config, secrets, now } = app.deps;
  const limited = { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } };
  const full = { preHandler: platformAuthz(app) };
  const early = { preHandler: platformAuthz(app, { allowIncomplete: true }) };

  const recordFailure = (adminId: string) =>
    control.query(
      `UPDATE platform_admins SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
      [adminId, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
    );

  /** Verifies the current password of a signed-in administrator (re-authentication); failures count towards the lockout. */
  async function reauthenticate(adminId: string, password: string): Promise<void> {
    const a = (await control.query(`SELECT password_hash, locked_until FROM platform_admins WHERE id = $1`, [adminId])).rows[0];
    if (!a) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (a.locked_until && new Date(a.locked_until) > new Date()) throw new AppError(403, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later');
    if (!(await verifyPassword(a.password_hash, password))) {
      await recordFailure(adminId);
      throw new AppError(403, 'WRONG_PASSWORD', 'Current password is incorrect');
    }
  }

  /** Checks a TOTP code against the stored secret and atomically records the step so the code cannot be replayed. */
  async function consumeTotp(adminId: string, secretEnc: string, lastStep: string | null, code: string): Promise<boolean> {
    const secret = secrets.decrypt(secretEnc, aad(adminId));
    const step = verifyTotp(secret, code, now().getTime(), lastStep === null ? null : Number(lastStep));
    if (step === null) return false;
    const r = await control.query(`UPDATE platform_admins SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING 1`, [
      adminId,
      step,
    ]);
    return (r.rowCount ?? 0) > 0; // false = a concurrent request already used this step
  }

  // ------------------------------------------------------------------ login
  app.post('/platform/auth/login', limited, async (req, reply) => {
    const b = parse(
      z.object({
        email: z.string().email().max(254),
        password: z.string().min(1).max(256),
        mfa_code: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
        recovery_code: z.string().min(8).max(32).optional(),
      }),
      req.body,
    );
    if (b.mfa_code && b.recovery_code) throw new AppError(400, 'VALIDATION_ERROR', 'Send either mfa_code or recovery_code');
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const a = (
      await control.query(
        `SELECT id, password_hash, status, locked_until, mfa_secret_enc, mfa_enabled_at, mfa_last_step::text AS mfa_last_step FROM platform_admins WHERE email = $1`,
        [b.email],
      )
    ).rows[0];
    if (!a) {
      await burnPasswordCheck(b.password);
      throw fail();
    }
    const locked = a.locked_until && new Date(a.locked_until) > new Date();
    const ok = await verifyPassword(a.password_hash, b.password);
    if (locked || a.status !== 'active' || !ok) {
      if (!ok && !locked && a.status === 'active') await recordFailure(a.id);
      throw fail();
    }

    // Password accepted. If MFA is enrolled the second factor is mandatory for this session.
    let mfaVerified = false;
    let usedRecovery = false;
    if (a.mfa_enabled_at) {
      if (!b.mfa_code && !b.recovery_code) throw new AppError(401, 'MFA_REQUIRED', 'A verification code is required');
      let good = false;
      if (b.mfa_code) good = await consumeTotp(a.id, a.mfa_secret_enc, a.mfa_last_step, b.mfa_code);
      else {
        const r = await control.query(
          `UPDATE platform_recovery_codes SET used_at = now() WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
          [a.id, hashRecoveryCode(b.recovery_code!)],
        );
        good = (r.rowCount ?? 0) > 0;
        usedRecovery = good;
      }
      if (!good) {
        await recordFailure(a.id);
        throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid verification code');
      }
      mfaVerified = true;
    }

    const token = newSessionToken();
    await control.query(`UPDATE platform_admins SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [a.id]);
    await control.query(
      `INSERT INTO platform_sessions (token_hash, admin_id, expires_at, mfa_verified) VALUES ($1,$2, now() + make_interval(hours => $3), $4)`,
      [hashToken(token), a.id, config.SESSION_TTL_HOURS, mfaVerified],
    );
    await control.query(`DELETE FROM platform_sessions WHERE id IN (SELECT id FROM platform_sessions WHERE admin_id = $1 ORDER BY created_at DESC OFFSET $2)`, [
      a.id,
      config.MAX_SESSIONS_PER_USER,
    ]);
    reply.setCookie(PLATFORM_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: '/api/platform',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });
    await platformAudit(control, {
      actorId: a.id,
      action: 'platform.login',
      entityType: 'session',
      metadata: { mfa: mfaVerified, recovery_code: usedRecovery },
    });
    const mfaState = a.mfa_enabled_at ? 'ok' : config.PLATFORM_MFA_REQUIRED ? 'enrolment_required' : 'ok';
    return { admin: { id: a.id, email: b.email }, mfa: { enabled: Boolean(a.mfa_enabled_at), state: mfaState } };
  });

  app.post('/platform/auth/logout', early, async (req, reply) => {
    await control.query('DELETE FROM platform_sessions WHERE id = $1', [platformOf(req).sessionId]);
    reply.clearCookie(PLATFORM_COOKIE, { path: '/api/platform' });
    return { ok: true };
  });

  app.get('/platform/auth/me', early, async (req) => {
    const p = platformOf(req);
    return {
      admin: { id: p.adminId, email: p.email, full_name: p.fullName },
      mfa: { enabled: p.mfaEnabled, required: config.PLATFORM_MFA_REQUIRED, state: p.mfaState },
    };
  });

  // ------------------------------------------------------------------ MFA enrolment
  // Step 1: re-enter the password (a stolen session alone cannot bind an attacker's authenticator), receive the secret.
  app.post('/platform/auth/mfa/enrol', { ...early, ...limited }, async (req) => {
    const p = platformOf(req);
    if (p.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
    const b = parse(z.object({ current_password: z.string().min(1).max(256) }), req.body);
    await reauthenticate(p.adminId, b.current_password);
    const secret = generateTotpSecret();
    await control.query(`UPDATE platform_admins SET mfa_pending_secret_enc = $2 WHERE id = $1`, [p.adminId, secrets.encrypt(secret, aad(p.adminId))]);
    return { secret, otpauth_uri: otpauthUri(MFA_ISSUER, p.email, secret) };
  });

  // Step 2: prove the authenticator works. Activates MFA, verifies this session, revokes all other sessions, returns recovery codes once.
  app.post('/platform/auth/mfa/confirm', { ...early, ...limited }, async (req) => {
    const p = platformOf(req);
    if (p.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const a = (await control.query(`SELECT mfa_pending_secret_enc, locked_until FROM platform_admins WHERE id = $1`, [p.adminId])).rows[0];
    if (!a?.mfa_pending_secret_enc) throw new AppError(409, 'NO_PENDING_ENROLMENT', 'Start enrolment first');
    if (a.locked_until && new Date(a.locked_until) > new Date()) throw new AppError(403, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later');
    const step = verifyTotp(secrets.decrypt(a.mfa_pending_secret_enc, aad(p.adminId)), b.code, now().getTime(), null);
    if (step === null) {
      await recordFailure(p.adminId);
      throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid verification code');
    }
    const codes = generateRecoveryCodes();
    const c = await control.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query(
        `UPDATE platform_admins SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL, mfa_enabled_at = now(), mfa_last_step = $2
          WHERE id = $1 AND mfa_enabled_at IS NULL AND mfa_pending_secret_enc IS NOT NULL RETURNING 1`,
        [p.adminId, step],
      );
      if (!u.rowCount) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
      for (const code of codes) await c.query(`INSERT INTO platform_recovery_codes (admin_id, code_hash) VALUES ($1,$2)`, [p.adminId, hashRecoveryCode(code)]);
      await c.query(`UPDATE platform_sessions SET mfa_verified = true WHERE id = $1`, [p.sessionId]);
      await c.query(`DELETE FROM platform_sessions WHERE admin_id = $1 AND id <> $2`, [p.adminId, p.sessionId]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await platformAudit(control, { actorId: p.adminId, action: 'platform.mfa_enrolled', entityType: 'platform_admin', entityId: p.adminId });
    return { enabled: true, recovery_codes: codes };
  });

  // Replace the recovery codes (needs password AND a fresh TOTP code). Old unused codes stop working.
  app.post('/platform/auth/mfa/recovery-codes', { ...full, ...limited }, async (req) => {
    const p = platformOf(req);
    if (!p.mfaEnabled) throw new AppError(409, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled');
    const b = parse(z.object({ current_password: z.string().min(1).max(256), mfa_code: z.string().regex(/^\d{6}$/) }), req.body);
    await reauthenticate(p.adminId, b.current_password);
    const a = (await control.query(`SELECT mfa_secret_enc, mfa_last_step::text AS mfa_last_step FROM platform_admins WHERE id = $1`, [p.adminId])).rows[0];
    if (!(await consumeTotp(p.adminId, a.mfa_secret_enc, a.mfa_last_step, b.mfa_code))) {
      await recordFailure(p.adminId);
      throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid verification code');
    }
    const codes = generateRecoveryCodes();
    const c = await control.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE platform_recovery_codes SET used_at = now() WHERE admin_id = $1 AND used_at IS NULL`, [p.adminId]);
      for (const code of codes) await c.query(`INSERT INTO platform_recovery_codes (admin_id, code_hash) VALUES ($1,$2)`, [p.adminId, hashRecoveryCode(code)]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await platformAudit(control, { actorId: p.adminId, action: 'platform.recovery_codes_regenerated', entityType: 'platform_admin', entityId: p.adminId });
    return { recovery_codes: codes };
  });

  // ------------------------------------------------------------------ password change
  app.post('/platform/auth/change-password', { ...full, ...limited }, async (req) => {
    const p = platformOf(req);
    const b = parse(z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(PLATFORM_PASSWORD_MIN_LENGTH).max(256) }), req.body);
    if (b.new_password === b.current_password) throw new AppError(400, 'VALIDATION_ERROR', 'The new password must differ from the current one');
    await reauthenticate(p.adminId, b.current_password);
    const hash = await hashPassword(b.new_password);
    await control.query(`UPDATE platform_admins SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [p.adminId, hash]);
    await control.query(`DELETE FROM platform_sessions WHERE admin_id = $1 AND id <> $2`, [p.adminId, p.sessionId]); // every other session ends
    await platformAudit(control, { actorId: p.adminId, action: 'platform.password_changed', entityType: 'platform_admin', entityId: p.adminId });
    return { ok: true };
  });
}
