import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHOOL_MIGRATIONS_DIR = path.resolve(here, '../migrations');
export const CONTROL_MIGRATIONS_DIR = path.resolve(here, '../control-migrations');

/** Role name placeholder used inside school migrations; replaced per database at apply time. */
export const APP_ROLE_PLACEHOLDER = 'shikkha_app';
const ROLE_RE = /^[a-z][a-z0-9_]{2,62}$/;

export interface MigrateOptions {
  dir?: string;
  /** Application role the migrations grant privileges to (school DBs use a per-school role). */
  appRole?: string;
  lockKey?: number;
}

export function migrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export async function appliedMigrations(url: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const t = await c.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    if (!t.rows[0].t) return [];
    return (await c.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  } finally {
    await c.end();
  }
}

export async function migrate(url: string, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? SCHOOL_MIGRATIONS_DIR;
  const appRole = opts.appRole ?? APP_ROLE_PLACEHOLDER;
  if (!ROLE_RE.test(appRole)) throw new Error('invalid application role name');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock($1)', [opts.lockKey ?? 727001]);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of migrationFiles(dir)) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(new RegExp(`\\b${APP_ROLE_PLACEHOLDER}\\b`, 'g'), appRole);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock($1)', [opts.lockKey ?? 727001]);
  } finally {
    await client.end();
  }
  return applied;
}

/** Creates or updates a restricted login role (never superuser, never BYPASSRLS). Requires an admin connection. */
export async function setupRole(url: string, role: string, password: string): Promise<void> {
  if (!ROLE_RE.test(role)) throw new Error('invalid role name');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount;
    const pw = (await client.query('SELECT quote_literal($1) AS q', [password])).rows[0].q as string;
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pw}`);
  } finally {
    await client.end();
  }
}
