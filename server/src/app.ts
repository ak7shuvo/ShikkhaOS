import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import type { AppDeps } from './context.js';
import { SESSION_COOKIE } from './context.js';
import type { Db } from './db.js';
import { EntitlementService } from './entitlement-service.js';
import { AppError } from './errors.js';
import { loadRolePermissions, type RolePermissionMap } from './rbac.js';
import { academicRoutes } from './routes/academic.js';
import { authRoutes } from './routes/auth.js';
import { guardianRoutes } from './routes/guardian.js';
import { platformRoutes } from './routes/platform.js';
import { publicRoutes } from './routes/public.js';
import { resultRoutes } from './routes/results.js';
import { schoolRoutes } from './routes/school.js';
import { TenantRouter, TenantUnavailableError } from './tenancy.js';
import { SecretBox, loadMasterKeys } from './secrets.js';
import { runtimeDbTls } from './tls.js';

/** Trust exactly `n` proxies counted from the TCP peer: the first address beyond them is the client. */
const hops = (n: number) => (_addr: string, i: number) => i < n;

export interface AppOptions {
  /** Pool for the legacy shared school database; only needed while a school has db_mode='shared'. */
  sharedPool?: Db;
  now?: () => Date;
}

export async function buildApp(config: Config, control: Db, opts: AppOptions = {}): Promise<FastifyInstance> {
  const serverOptions: FastifyServerOptions = {
    // Never log bodies, cookies or auth headers.
    logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    // Only honour X-Forwarded-* from explicitly trusted proxies (TRUST_PROXY); default is the TCP peer.
    trustProxy: typeof config.TRUST_PROXY === 'number' ? hops(config.TRUST_PROXY) : config.TRUST_PROXY,
    bodyLimit: 1_000_000,
  };
  const app = Fastify(serverOptions);
  const now = opts.now ?? (() => new Date());
  const secrets = new SecretBox(loadMasterKeys(config));
  const router = new TenantRouter(control, secrets, {
    sharedPool: opts.sharedPool,
    maxPools: config.MAX_SCHOOL_POOLS,
    poolMax: config.SCHOOL_POOL_MAX,
    cacheMs: config.ENTITLEMENT_CACHE_SECONDS * 1000,
    ssl: runtimeDbTls(config).school,
  });
  const entitlements = new EntitlementService(control, { cacheMs: config.ENTITLEMENT_CACHE_SECONDS * 1000, timezone: config.BILLING_TIMEZONE, now });
  const rpCache = new Map<string, RolePermissionMap>();
  const deps: AppDeps = {
    config,
    control,
    router,
    entitlements,
    now,
    rolePermissions: async (entry, pool) => {
      const key = `${entry.id}:${entry.schema_version}`;
      let m = rpCache.get(key);
      if (!m) {
        m = await loadRolePermissions(pool);
        rpCache.set(key, m);
      }
      return m;
    },
  };
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);
  app.decorateRequest('platformAuth', null);
  app.addHook('onClose', async () => router.close());

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  // CSRF defence: SameSite=Strict cookie + reject unsafe-method requests from foreign origins.
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !config.ALLOWED_ORIGINS.includes(origin)) throw new AppError(403, 'BAD_ORIGIN', 'Origin not allowed');
  });
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof TenantUnavailableError) {
      const status = err.code === 'SCHOOL_SUSPENDED' || err.code === 'SCHOOL_OFFBOARDED' ? 403 : 503;
      if (status === 503) req.log.error({ code: err.code }, 'tenant unavailable');
      return reply.status(status).send({ error: { code: err.code, message: err.message } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    // PostgreSQL check_violation / RLS violations surface as safe generic errors.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23514' || pgCode === '42501') {
      return reply.status(409).send({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Operation rejected by database rules' } });
    }
    if (pgCode === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'Record already exists' } });
    if (pgCode === '23503') return reply.status(409).send({ error: { code: 'INVALID_REFERENCE', message: 'Referenced record does not exist in this school' } });
    req.log.error({ err: { message: err.message, code: pgCode } }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(platformRoutes, { prefix: '/api' });
  await app.register(publicRoutes, { prefix: '/api' });
  await app.register(schoolRoutes, { prefix: '/api' });
  await app.register(academicRoutes, { prefix: '/api' });
  await app.register(resultRoutes, { prefix: '/api' });
  await app.register(guardianRoutes, { prefix: '/api' });
  return app;
}

export { SESSION_COOKIE };
