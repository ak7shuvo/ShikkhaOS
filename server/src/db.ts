import pg from 'pg';

// numeric -> JS number (marks have max 2 decimals, well inside double precision).
pg.types.setTypeParser(1700, (v) => Number(v));
// date -> plain 'YYYY-MM-DD' string (avoid timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Per-request database context. Values come from server-side session/membership only. */
export interface DbContext {
  userId?: string;
  schoolId?: string;
  platform?: boolean;
  sessionHash?: string;
}

export function createPool(url: string, ssl: false | pg.PoolConfig['ssl'] = false): Db {
  return new pg.Pool({ connectionString: url, max: 10, ...(ssl ? { ssl } : {}) });
}

/**
 * Runs `fn` in a transaction with the RLS context set via transaction-local
 * settings (set_config(..., true)), so nothing leaks to other pooled requests.
 */
export async function withContext<T>(pool: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.school_id', $2, true),
              set_config('app.platform', $3, true), set_config('app.session_hash', $4, true)`,
      [ctx.userId ?? '', ctx.schoolId ?? '', ctx.platform ? 'on' : '', ctx.sessionHash ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Refuse to run the API with a role that would bypass row-level security. */
export async function assertRestrictedRole(pool: Db): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
    `SELECT r.rolsuper, r.rolbypassrls, current_user FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) throw new Error('Cannot determine database role');
  if (r.rolsuper || r.rolbypassrls) {
    throw new Error(`DATABASE_URL role "${r.current_user}" bypasses row-level security. Use the restricted shikkha_app role.`);
  }
}
