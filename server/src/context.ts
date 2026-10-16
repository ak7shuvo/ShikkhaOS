import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import type { Config } from './config.js';
import { withContext, type Db, type Tx } from './db.js';
import type { EntitlementService } from './entitlement-service.js';
import { READ_ONLY_SAFE_METHODS, type Entitlement } from './entitlements.js';
import { AppError, badRequest, forbidden, unauthorized } from './errors.js';
import { hashToken } from './passwords.js';
import { permissionsFor, type RolePermissionMap } from './rbac.js';
import type { RegistryEntry, TenantRouter } from './tenancy.js';

export const SESSION_COOKIE = 'sid';
export const PLATFORM_COOKIE = 'psid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
  language: string;
  sessionId: string;
  tokenHash: string;
  /** School this session belongs to: the registry row that authenticated the session, never client input. */
  schoolId: string | null;
  entry: RegistryEntry;
  /** Connection pool of THIS school's database (dedicated) or the shared database (legacy mode). */
  pool: Db;
  entitlement: Entitlement;
  roles: string[];
  permissions: Set<string>;
  memberships: { school_id: string; role: string; school_name: string }[];
  /** Initial/reset password still in use: only logout, /auth/me and change-password are allowed until it is replaced. */
  mustChangePassword: boolean;
}

export interface PlatformAuth {
  adminId: string;
  email: string;
  fullName: string;
  sessionId: string;
  tokenHash: string;
}

export interface AppDeps {
  config: Config;
  control: Db;
  router: TenantRouter;
  entitlements: EntitlementService;
  rolePermissions: (entry: RegistryEntry, pool: Db) => Promise<RolePermissionMap>;
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    platformAuth: PlatformAuth | null;
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

/** Cookie value is `<school id>.<random token>`. The school id is only a routing hint: the session must exist in that school's database. */
export const makeCookieValue = (schoolId: string, token: string) => `${schoolId}.${token}`;
export function splitCookie(v: string | undefined): { schoolId: string; token: string } | null {
  if (!v) return null;
  const i = v.indexOf('.');
  if (i !== 36) return null;
  const schoolId = v.slice(0, 36);
  const token = v.slice(37);
  if (!UUID_RE.test(schoolId) || token.length < 20) return null;
  return { schoolId, token };
}

/** Resolve the session cookie into an AuthContext, or throw 401. */
export async function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<AuthContext> {
  const { router, entitlements, config } = app.deps;
  const c = splitCookie(req.cookies[SESSION_COOKIE]);
  if (!c) throw unauthorized();
  const entry = await router.byId(c.schoolId);
  if (!entry) throw unauthorized();
  router.assertRoutable(entry); // suspended / offboarded / not ready → typed error handled globally
  const pool = await router.poolFor(entry);
  const tokenHash = hashToken(c.token);
  const s = (await router.guard(entry, () => pool.query(`SELECT * FROM auth_session_by_hash($1)`, [tokenHash]))).rows[0];
  const idleMs = config.SESSION_IDLE_MINUTES * 60_000;
  if (!s || new Date(s.expires_at) <= new Date() || s.user_status !== 'active') throw unauthorized('Session invalid or expired');
  if (Date.now() - new Date(s.last_seen_at).getTime() > idleMs) throw unauthorized('Session expired due to inactivity');
  // A token is only valid inside the school that issued it.
  if (s.active_school_id !== entry.id) throw unauthorized('Session invalid or expired');

  const result = await withContext(pool, { userId: s.user_id, schoolId: entry.id, sessionHash: tokenHash }, async (tx) => {
    const m = await tx.query(
      `SELECT m.school_id, m.role, sc.name AS school_name, sc.status AS school_status
         FROM school_memberships m JOIN schools sc ON sc.id = m.school_id
        WHERE m.user_id = $1 AND m.school_id = $2 AND m.status = 'active'`,
      [s.user_id, entry.id],
    );
    await tx.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [s.session_id]);
    return m.rows;
  });
  const usable = result.filter((r) => r.school_status === 'active');
  const roles = usable.map((r) => r.role as string);
  const permissions = permissionsFor(await app.deps.rolePermissions(entry, pool), roles);
  return {
    userId: s.user_id,
    email: s.email,
    fullName: s.full_name,
    language: s.preferred_language,
    sessionId: s.session_id,
    tokenHash,
    schoolId: usable.length ? entry.id : null,
    entry,
    pool,
    entitlement: await entitlements.get(entry.id),
    roles,
    permissions,
    memberships: usable.map((r) => ({ school_id: r.school_id, role: r.role, school_name: r.school_name })),
    mustChangePassword: s.must_change_password === true,
  };
}

interface GuardOpts {
  /** Permission(s) required (all of them). */
  perm?: string | string[];
  /** Route only needs a valid session (logout, /auth/me, change-password): exempt from subscription enforcement. */
  anySession?: boolean;
}

/** preHandler factory: authenticates, enforces school context, subscription entitlement, permissions. */
export function authz(app: FastifyInstance, opts: GuardOpts = {}) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = await authenticate(app, req);
    req.auth = auth;
    if (opts.anySession) return;
    if (auth.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your initial password before continuing');
    if (!auth.schoolId) throw new AppError(409, 'SCHOOL_CONTEXT_REQUIRED', 'No active membership in this school');
    const e = auth.entitlement;
    if (e.level === 'blocked')
      throw new AppError(403, 'SUBSCRIPTION_BLOCKED', e.warning?.message ?? 'Subscription inactive', { retention_until: e.retention_until });
    if (e.level === 'read_only' && !READ_ONLY_SAFE_METHODS.has(req.method)) {
      throw new AppError(403, 'SUBSCRIPTION_READ_ONLY', e.warning?.message ?? 'Subscription expired: read-only', { read_only_until: e.read_only_until });
    }
    if (e.warning) reply.header('X-Subscription-Warning', e.warning.code);
    const perms = opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : [];
    for (const p of perms) if (!auth.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
  };
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Run `fn` inside a transaction on the caller's school database, scoped by RLS context as defence in depth. */
export function schoolTx<T>(app: FastifyInstance, req: FastifyRequest, fn: (tx: Tx, auth: AuthContext & { schoolId: string }) => Promise<T>): Promise<T> {
  const auth = authOf(req);
  if (!auth.schoolId) throw new AppError(409, 'SCHOOL_CONTEXT_REQUIRED', 'No active membership in this school');
  void app;
  return withContext(auth.pool, { userId: auth.userId, schoolId: auth.schoolId }, (tx) => fn(tx, auth as AuthContext & { schoolId: string }));
}

// ------------------------------------------------------------------------------------ platform (Petra staff)
/** Platform admins authenticate against the control plane only; they have no school database credentials. */
export async function authenticatePlatform(app: FastifyInstance, req: FastifyRequest): Promise<PlatformAuth> {
  const token = req.cookies[PLATFORM_COOKIE];
  if (!token) throw unauthorized();
  const tokenHash = hashToken(token);
  const { control, config } = app.deps;
  const { rows } = await control.query(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, a.id AS admin_id, a.email::text AS email, a.full_name, a.status
       FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const s = rows[0];
  if (!s || new Date(s.expires_at) <= new Date() || s.status !== 'active') throw unauthorized('Session invalid or expired');
  if (Date.now() - new Date(s.last_seen_at).getTime() > config.SESSION_IDLE_MINUTES * 60_000) throw unauthorized('Session expired due to inactivity');
  await control.query(`UPDATE platform_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [s.session_id]);
  return { adminId: s.admin_id, email: s.email, fullName: s.full_name, sessionId: s.session_id, tokenHash };
}

export function platformAuthz(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    req.platformAuth = await authenticatePlatform(app, req);
  };
}

export function platformOf(req: FastifyRequest): PlatformAuth {
  if (!req.platformAuth) throw unauthorized();
  return req.platformAuth;
}
