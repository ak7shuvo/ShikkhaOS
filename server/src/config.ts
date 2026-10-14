import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  // Control-plane database (registry, subscriptions, platform admins). Restricted role petra_control_app.
  CONTROL_DATABASE_URL: z.string().url(),
  // Legacy shared school database (Phase 1 layout). Optional: only needed while any school is db_mode='shared'.
  SHARED_DATABASE_URL: z.string().url().optional(),
  // Encryption of per-school DB credentials stored in the registry (AES-256-GCM). base64 of 32 random bytes.
  PETRA_MASTER_KEY: z.string().min(1),
  PETRA_MASTER_KEY_ID: z.string().regex(/^[a-z0-9_-]{1,20}$/).default('k1'),
  PETRA_MASTER_KEY_PREVIOUS: z.string().optional(),
  PETRA_MASTER_KEY_PREVIOUS_ID: z.string().regex(/^[a-z0-9_-]{1,20}$/).optional(),
  // '' = do not trust X-Forwarded-*; a number = trusted proxy hop count; otherwise comma-separated proxy IPs/CIDRs.
  TRUST_PROXY: z.string().default(''),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
  MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(50).default(5),
  ENTITLEMENT_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(10),
  MAX_SCHOOL_POOLS: z.coerce.number().int().min(1).max(200).default(25),
  SCHOOL_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  BILLING_TIMEZONE: z.string().default('Asia/Dhaka'),
  // true = TLS to school databases (certificate verification follows Node defaults). Off by default for local development only.
  SCHOOL_DB_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(30),
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

export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE' | 'TRUST_PROXY'> & { COOKIE_SECURE: boolean; TRUST_PROXY: boolean | number | string[] };

/** Maps the TRUST_PROXY string to Fastify's `trustProxy` option. */
export function parseTrustProxy(v: string): boolean | number | string[] {
  const t = v.trim();
  if (t === '') return false;
  if (/^\d+$/.test(t)) return Number(t);
  return t.split(',').map((x) => x.trim()).filter(Boolean);
}

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
    if (c.TRUST_PROXY.trim() === '') {
      // Not fatal in code (a deployment may terminate TLS directly), but make the choice explicit.
      console.warn('[config] TRUST_PROXY is empty: client IPs (rate limiting) are taken from the TCP peer. Set it when behind a reverse proxy.');
    }
    if (c.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      throw new Error('ALLOWED_ORIGINS must be https:// origins in production');
    }
  }
  return { ...c, COOKIE_SECURE: cookieSecure, TRUST_PROXY: parseTrustProxy(c.TRUST_PROXY) };
}
