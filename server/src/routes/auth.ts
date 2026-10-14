import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { SESSION_COOKIE, authOf, authenticate, authz, parse } from '../context.js';
import { withContext } from '../db.js';
import { AppError, forbidden } from '../errors.js';
import { burnPasswordCheck, hashToken, newSessionToken, verifyPassword } from '../passwords.js';

const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config, pool } = app.deps;

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: '/',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });

  const sessionInfo = (a: ReturnType<typeof authOf>) => ({
    user: { id: a.userId, email: a.email, full_name: a.fullName, language: a.language, is_platform_admin: a.isPlatformAdmin },
    active_school_id: a.schoolId,
    roles: a.roles,
    permissions: [...a.permissions].sort(),
    memberships: a.memberships,
  });

  app.post('/auth/login', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const found = (await pool.query(`SELECT * FROM auth_user_by_email($1)`, [body.email])).rows[0];
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
    const tokenHash = hashToken(token);
    await withContext(pool, { userId: found.id }, async (tx) => {
      await tx.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [found.id]);
      const ms = await tx.query(
        `SELECT m.school_id FROM school_memberships m JOIN schools s ON s.id = m.school_id
          WHERE m.user_id = $1 AND m.status = 'active' AND s.status = 'active' GROUP BY m.school_id`,
        [found.id],
      );
      const active = ms.rows.length === 1 ? ms.rows[0].school_id : null;
      await tx.query(
        `INSERT INTO sessions (token_hash, user_id, active_school_id, expires_at, user_agent)
         VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5)`,
        [tokenHash, found.id, active, config.SESSION_TTL_HOURS, (req.headers['user-agent'] ?? '').slice(0, 200)],
      );
    });
    setCookie(reply, token);
    // Re-read through the standard path so the response reflects server-side truth.
    req.cookies[SESSION_COOKIE] = token;
    const auth = await authenticate(app, req);
    if (auth.schoolId) {
      await withContext(pool, { userId: auth.userId, schoolId: auth.schoolId }, (tx) =>
        audit(tx, { schoolId: auth.schoolId, actorUserId: auth.userId, action: 'auth.login', entityType: 'session', entityId: auth.sessionId }),
      );
    }
    return sessionInfo(auth);
  });

  app.post('/auth/logout', { preHandler: authz(app, { anySession: true }) }, async (req, reply) => {
    const a = authOf(req);
    await withContext(pool, { userId: a.userId, sessionHash: a.tokenHash }, (tx) => tx.query('DELETE FROM sessions WHERE id = $1', [a.sessionId]));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: authz(app, { anySession: true }) }, async (req) => sessionInfo(authOf(req)));

  // Switching school: the target must be one of the caller's own active memberships.
  app.post('/auth/switch-school', { preHandler: authz(app, { anySession: true }) }, async (req) => {
    const a = authOf(req);
    const { school_id } = parse(z.object({ school_id: z.string().uuid() }), req.body);
    if (!a.memberships.some((m) => m.school_id === school_id)) throw forbidden('You are not a member of that school', 'NOT_A_MEMBER');
    await withContext(pool, { userId: a.userId }, (tx) => tx.query('UPDATE sessions SET active_school_id = $1 WHERE id = $2', [school_id, a.sessionId]));
    return sessionInfo(await authenticate(app, req));
  });

  app.patch('/auth/me', { preHandler: authz(app, { anySession: true }) }, async (req) => {
    const a = authOf(req);
    const body = parse(z.object({ language: z.enum(['bn', 'en']) }), req.body);
    await withContext(pool, { userId: a.userId }, (tx) => tx.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [body.language, a.userId]));
    return { ok: true };
  });
}
