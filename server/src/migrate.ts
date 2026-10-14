import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migrate(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727001)');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    await client.end();
  }
  return applied;
}

/** Creates the restricted runtime role if missing. Requires an owner/admin connection. */
export async function setupRole(url: string, appPassword: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname='shikkha_app'`)).rowCount;
    const pw = (await client.query('SELECT quote_literal($1) AS q', [appPassword])).rows[0].q as string;
    if (!exists) {
      await client.query(`CREATE ROLE shikkha_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pw}`);
    } else {
      await client.query(`ALTER ROLE shikkha_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    }
  } finally {
    await client.end();
  }
}
