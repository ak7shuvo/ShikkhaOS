import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import type { Config } from './config.js';
import { withContext, type Db, type Tx } from './db.js';
import { AppError, badRequest, forbidden, unauthorized } from './errors.js';
import { hashToken } from './passwords.js';
import { permissionsFor, type RolePermissionMap } from './rbac.js';

export const SESSION_COOKIE = 'sid';

export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
  language: string;
  isPlatformAdmin: boolean;
  sessionId: string;
  tokenHash: string;
  /** Active school, derived from server-side membership — never from client input. */
  schoolId: string | null;
  roles: string[];
  permissions: Set<string>;
  memberships: { school_id: string; role: string; school_name: string }[];
}

export interface AppDeps {
  config: Config;
  pool: Db;
  rolePermissions: RolePermissionMap;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'VALIDATION_ERROR',
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Resolve the session cookie into an AuthContext, or throw 401. */
export async function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<AuthContext> {
  const { pool, rolePermissions } = app.deps;
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw unauthorized();
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(`SELECT * FROM auth_session_by_hash($1)`, [tokenHash]);
  const s = rows[0];
  if (!s || new Date(s.expires_at) <= new Date() || s.user_status !== 'active') throw unauthorized('Session invalid or expired');

  // Load memberships under the user's own context; verify active school server-side.
  const result = await withContext(pool, { userId: s.user_id, schoolId: s.active_school_id ?? undefined, sessionHash: tokenHash }, async (tx) => {
    const m = await tx.query(
      `SELECT m.school_id, m.role, sc.name AS school_name, sc.status AS school_status
         FROM school_memberships m JOIN schools sc ON sc.id = m.school_id
        WHERE m.user_id = $1 AND m.status = 'active'`,
      [s.user_id],
    );
    await tx.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [s.session_id]);
    return m.rows;
  });
  const usable = result.filter((r) => r.school_status === 'active');
  let schoolId: string | null = null;
  if (s.active_school_id && usable.some((r) => r.school_id === s.active_school_id)) schoolId = s.active_school_id;
  const roles = schoolId ? usable.filter((r) => r.school_id === schoolId).map((r) => r.role as string) : [];
  const permissions = permissionsFor(rolePermissions, roles);
  if (s.is_platform_admin) for (const p of rolePermissions.get('platform_super_admin') ?? []) permissions.add(p);
  return {
    userId: s.user_id,
    email: s.email,
    fullName: s.full_name,
    language: s.preferred_language,
    isPlatformAdmin: s.is_platform_admin,
    sessionId: s.session_id,
    tokenHash,
    schoolId,
    roles,
    permissions,
    memberships: usable.map((r) => ({ school_id: r.school_id, role: r.role, school_name: r.school_name })),
  };
}

interface GuardOpts {
  /** Permission(s) required (all of them). */
  perm?: string | string[];
  /** Route operates on platform data (no school context). */
  platform?: boolean;
  /** Route only needs a valid session. */
  anySession?: boolean;
}

/** preHandler factory: authenticates, enforces school context, license, permissions. */
export function authz(app: FastifyInstance, opts: GuardOpts = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const auth = await authenticate(app, req);
    req.auth = auth;
    if (opts.anySession) return;
    const perms = opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : [];
    if (opts.platform) {
      if (!auth.isPlatformAdmin) throw forbidden('Platform administrator required');
    } else {
      if (!auth.schoolId) throw new AppError(409, 'SCHOOL_CONTEXT_REQUIRED', 'Select a school first');
      await assertLicense(app.deps.pool, auth);
    }
    for (const p of perms) if (!auth.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
  };
}

async function assertLicense(pool: Db, auth: AuthContext): Promise<void> {
  const row = await withContext(pool, { userId: auth.userId, schoolId: auth.schoolId! }, async (tx) => {
    const r = await tx.query(`SELECT status, ends_on, (ends_on IS NOT NULL AND ends_on < current_date) AS past_end FROM school_licenses WHERE school_id = $1`, [
      auth.schoolId,
    ]);
    return r.rows[0];
  });
  if (!row || !['trial', 'active'].includes(row.status) || row.past_end) {
    throw new AppError(403, 'LICENSE_INACTIVE', 'This school licence is not active');
  }
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Run `fn` inside a transaction scoped to the caller's school (RLS enforced). */
export function schoolTx<T>(app: FastifyInstance, req: FastifyRequest, fn: (tx: Tx, auth: AuthContext & { schoolId: string }) => Promise<T>): Promise<T> {
  const auth = authOf(req);
  if (!auth.schoolId) throw new AppError(409, 'SCHOOL_CONTEXT_REQUIRED', 'Select a school first');
  return withContext(app.deps.pool, { userId: auth.userId, schoolId: auth.schoolId }, (tx) => fn(tx, auth as AuthContext & { schoolId: string }));
}

/** Run `fn` with platform scope (no school context; only platform-level tables visible). */
export function platformTx<T>(app: FastifyInstance, req: FastifyRequest, fn: (tx: Tx, auth: AuthContext) => Promise<T>): Promise<T> {
  const auth = authOf(req);
  if (!auth.isPlatformAdmin) throw forbidden('Platform administrator required');
  return withContext(app.deps.pool, { userId: auth.userId, platform: true }, (tx) => fn(tx, auth));
}
