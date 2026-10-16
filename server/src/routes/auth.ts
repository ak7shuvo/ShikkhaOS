import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { SESSION_COOKIE, authOf, authenticate, authz, makeCookieValue, parse, splitCookie } from '../context.js';
import { withContext } from '../db.js';
import { AppError } from '../errors.js';
import { PASSWORD_MIN_LENGTH, burnPasswordCheck, hashPassword, hashToken, newSessionToken, verifyPassword } from '../passwords.js';
import { SLUG_RE } from '../registry.js';
import { TenantUnavailableError } from '../tenancy.js';

/** Per-school accounts: the school is chosen by slug and resolved through the registry; the account is looked up ONLY in that school's database. */
const loginBody = z.object({ school: z.string().regex(SLUG_RE).max(41), email: z.string().email().max(254), password: z.string().min(1).max(256) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config, router, entitlements, control } = app.deps;

  const setCookie = (reply: FastifyReply, schoolId: string, token: string) =>
    reply.setCookie(SESSION_COOKIE, makeCookieValue(schoolId, token), {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: '/',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });

  const sessionInfo = async (a: ReturnType<typeof authOf>) => {
    const b =
      (await control.query(`SELECT display_name, logo_url, primary_color, accent_color FROM school_branding WHERE school_id = $1`, [a.entry.id])).rows[0] ??
      null;
    return {
      user: { id: a.userId, email: a.email, full_name: a.fullName, language: a.language, credential_change_required: a.mustChangePassword },
      school: { id: a.entry.id, slug: a.entry.slug, name: a.entry.name },
      active_school_id: a.schoolId,
      roles: a.roles,
      permissions: [...a.permissions].sort(),
      memberships: a.memberships,
      entitlement: {
        level: a.entitlement.level,
        status: a.entitlement.status,
        warning: a.entitlement.warning,
        full_access_until: a.entitlement.full_access_until,
        read_only_until: a.entitlement.read_only_until,
        retention_until: a.entitlement.retention_until,
      },
      branding: b,
    };
  };

  app.post('/auth/login', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid school, email or password');

    // Slug → registry (trusted) → this school's own database. Unknown/unready schools look identical to a bad password.
    const entry = await router.bySlug(body.school);
    if (!entry || ['requested', 'provisioning', 'failed', 'archived'].includes(entry.status)) {
      await burnPasswordCheck(body.password);
      throw fail();
    }
    if (entry.status === 'maintenance') throw new AppError(503, 'SCHOOL_MAINTENANCE', 'This school is undergoing maintenance; please try again shortly');
    let pool;
    try {
      pool = await router.poolFor(entry);
    } catch (e) {
      if (e instanceof TenantUnavailableError) throw new AppError(503, e.code, 'This school is temporarily unavailable');
      throw e;
    }
    const found = (await router.guard(entry, () => pool.query(`SELECT * FROM auth_user_by_email($1)`, [body.email]))).rows[0];
    if (!found) {
      await burnPasswordCheck(body.password);
      throw fail();
    }
    const locked = found.locked_until && new Date(found.locked_until) > new Date();
    const ok = await verifyPassword(found.password_hash, body.password);
    if (locked || found.status !== 'active' || !ok) {
      if (!ok && !locked && found.status === 'active') {
        await withContext(pool, { userId: found.id }, (tx) =>
          tx.query(
            `UPDATE users SET failed_login_count = failed_login_count + 1,
               locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
             WHERE id = $1`,
            [found.id, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
          ),
        );
      }
      throw fail();
    }

    const token = newSessionToken();
    const member = await withContext(pool, { userId: found.id, schoolId: entry.id }, async (tx) => {
      // In legacy shared mode the same email may exist for several schools: require an active membership in THIS school.
      const ms = await tx.query(
        `SELECT 1 FROM school_memberships m JOIN schools s ON s.id = m.school_id WHERE m.user_id = $1 AND m.school_id = $2 AND m.status = 'active' AND s.status = 'active'`,
        [found.id, entry.id],
      );
      if (!ms.rows[0]) return false;
      await tx.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [found.id]);
      await tx.query(
        `INSERT INTO sessions (token_hash, user_id, active_school_id, expires_at, user_agent)
         VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5)`,
        [hashToken(token), found.id, entry.id, config.SESSION_TTL_HOURS, (req.headers['user-agent'] ?? '').slice(0, 200)],
      );
      // Bound concurrent sessions: drop the oldest beyond the cap.
      await tx.query(`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC OFFSET $2)`, [
        found.id,
        config.MAX_SESSIONS_PER_USER,
      ]);
      return true;
    });
    if (!member) throw fail();

    const ent = await entitlements.get(entry.id);
    if (ent.level === 'blocked') {
      // Credentials were correct, so it is safe to explain why access is closed.
      await withContext(pool, { userId: found.id, schoolId: entry.id }, (tx) => tx.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]));
      throw new AppError(403, 'SUBSCRIPTION_BLOCKED', ent.warning?.message ?? 'Subscription inactive', { retention_until: ent.retention_until });
    }
    if (entry.status === 'suspended' || entry.status === 'offboarding') {
      await withContext(pool, { userId: found.id, schoolId: entry.id }, (tx) => tx.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]));
      throw new AppError(403, entry.status === 'suspended' ? 'SCHOOL_SUSPENDED' : 'SCHOOL_OFFBOARDED', 'This school account is not active');
    }
    setCookie(reply, entry.id, token);
    req.cookies[SESSION_COOKIE] = makeCookieValue(entry.id, token);
    const auth = await authenticate(app, req);
    await withContext(pool, { userId: auth.userId, schoolId: entry.id }, (tx) =>
      audit(tx, { schoolId: entry.id, actorUserId: auth.userId, action: 'auth.login', entityType: 'session', entityId: auth.sessionId }),
    );
    return sessionInfo(auth);
  });

  // Logout must work in every school/subscription state (suspended, maintenance, offboarding, read-only, blocked), otherwise users
  // cannot end their own session. It therefore bypasses authz(): the only power it grants is deleting the session whose token the
  // caller presents, inside the school database that issued it (the cookie's school id is a routing hint; the token hash must exist
  // there with a matching active_school_id). The cookie is always cleared; `revoked` says whether a server-side session was removed.
  app.post('/auth/logout', async (req, reply) => {
    const c = splitCookie(req.cookies[SESSION_COOKIE]);
    let revoked = false;
    if (c) {
      try {
        const entry = await router.byId(c.schoolId);
        if (entry && ['active', 'maintenance', 'suspended', 'offboarding'].includes(entry.status)) {
          const pool = await router.poolFor(entry);
          const hash = hashToken(c.token);
          revoked = await router.guard(entry, () =>
            withContext(
              pool,
              { sessionHash: hash },
              async (tx) => ((await tx.query('DELETE FROM sessions WHERE token_hash = $1 AND active_school_id = $2', [hash, entry.id])).rowCount ?? 0) > 0,
            ),
          );
        }
      } catch {
        /* school database unavailable: the cookie is still cleared; the session expires on its own */
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, revoked };
  });

  app.get('/auth/me', { preHandler: authz(app, { anySession: true }) }, async (req) => sessionInfo(authOf(req)));

  // A school write (preference), so it follows the subscription state like every other school write (403 in read-only/blocked).
  app.patch('/auth/me', { preHandler: authz(app) }, async (req) => {
    const a = authOf(req);
    const body = parse(z.object({ language: z.enum(['bn', 'en']) }), req.body);
    await withContext(a.pool, { userId: a.userId }, (tx) => tx.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [body.language, a.userId]));
    return { ok: true };
  });

  // Deliberate exception: allowed in every subscription state so a user can always replace a possibly compromised password
  // (it also revokes their other sessions). It still verifies the current password and enforces the minimum length.
  app.post('/auth/change-password', { preHandler: authz(app, { anySession: true }) }, async (req) => {
    const a = authOf(req);
    const b = parse(z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(PASSWORD_MIN_LENGTH).max(256) }), req.body);
    const stored = (await a.pool.query(`SELECT * FROM auth_user_by_email($1)`, [a.email])).rows[0];
    if (!stored) throw new AppError(403, 'WRONG_PASSWORD', 'Current password is incorrect');
    // Same lockout as login: a thief of a live session must not be able to guess the current password at leisure.
    if (stored.locked_until && new Date(stored.locked_until) > new Date())
      throw new AppError(403, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later');
    if (!(await verifyPassword(stored.password_hash, b.current_password))) {
      await withContext(a.pool, { userId: a.userId }, (tx) =>
        tx.query(
          `UPDATE users SET failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
           WHERE id = $1`,
          [a.userId, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
        ),
      );
      throw new AppError(403, 'WRONG_PASSWORD', 'Current password is incorrect');
    }
    if (b.new_password === b.current_password) throw new AppError(400, 'PASSWORD_UNCHANGED', 'The new password must differ from the current one');
    const h = await hashPassword(b.new_password);
    await withContext(a.pool, { userId: a.userId, schoolId: a.entry.id }, async (tx) => {
      await tx.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, must_change_password = false WHERE id = $1`, [
        a.userId,
        h,
      ]);
      await tx.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]); // revoke every other session
      await audit(tx, { schoolId: a.entry.id, actorUserId: a.userId, action: 'auth.password_changed', entityType: 'user', entityId: a.userId });
    });
    return { ok: true };
  });
}
