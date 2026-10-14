import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { SESSION_COOKIE, type AppDeps } from './context.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { loadRolePermissions } from './rbac.js';
import { academicRoutes } from './routes/academic.js';
import { authRoutes } from './routes/auth.js';
import { guardianRoutes } from './routes/guardian.js';
import { platformRoutes } from './routes/platform.js';
import { resultRoutes } from './routes/results.js';
import { schoolRoutes } from './routes/school.js';

export async function buildApp(config: Config, pool: Db): Promise<FastifyInstance> {
  const app = Fastify({
    // Never log bodies, cookies or auth headers.
    logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: false,
    bodyLimit: 1_000_000,
  });
  const deps: AppDeps = { config, pool, rolePermissions: await loadRolePermissions(pool) };
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });

  // CSRF defence: SameSite=Strict cookie + reject unsafe requests from foreign origins.
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
  await app.register(schoolRoutes, { prefix: '/api' });
  await app.register(academicRoutes, { prefix: '/api' });
  await app.register(resultRoutes, { prefix: '/api' });
  await app.register(guardianRoutes, { prefix: '/api' });
  return app;
}

export { SESSION_COOKIE };
