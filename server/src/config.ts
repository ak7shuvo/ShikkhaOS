import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  // Runtime connection: must be the restricted, RLS-enforced role (shikkha_app).
  DATABASE_URL: z.string().url(),
  // Owner connection used only by migrate/setup/seed scripts.
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),
  COOKIE_SECURE: bool.optional(),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(10),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(600),
});

export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const c = parsed.data;
  const cookieSecure = c.COOKIE_SECURE ?? c.NODE_ENV === 'production';
  if (c.NODE_ENV === 'production') {
    if (!cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (c.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      throw new Error('ALLOWED_ORIGINS must be https:// origins in production');
    }
  }
  return { ...c, COOKIE_SECURE: cookieSecure };
}
