import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { CONTROL_MIGRATIONS_DIR, migrate, setupRole } from '../src/migrate.js';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set (see .env.example). A real PostgreSQL is required; tests do not mock the database.`);
  return v;
};
const pw = (url: string) => decodeURIComponent(new URL(url).password);

async function recreateSchema(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

async function ensureDb(adminUrl: string, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

/** Recreates the disposable test databases from the real migrations and removes leftover per-school databases/roles. */
export default async function setup(): Promise<void> {
  const envFile = path.resolve(import.meta.dirname, '../../.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PETRA_MASTER_KEY) process.env.PETRA_MASTER_KEY = randomBytes(32).toString('base64');
  const sharedOwner = need('TEST_MIGRATION_DATABASE_URL');
  const sharedApp = need('TEST_DATABASE_URL');
  const ctlOwner = need('TEST_CONTROL_MIGRATION_DATABASE_URL');
  const ctlApp = need('TEST_CONTROL_DATABASE_URL');
  const admin = need('TEST_PROVISIONER_DATABASE_URL');

  // Orphaned dedicated school databases/roles from previous runs.
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  for (const r of (await a.query(`SELECT datname FROM pg_database WHERE datname ~ '^sk_[a-f0-9]{12}$'`)).rows) await a.query(`DROP DATABASE "${r.datname}" WITH (FORCE)`);
  for (const r of (await a.query(`SELECT rolname FROM pg_roles WHERE rolname ~ '^sk_[a-f0-9]{12}_app$'`)).rows) await a.query(`DROP ROLE "${r.rolname}"`);
  await a.end();

  await ensureDb(admin, new URL(ctlOwner).pathname.slice(1));
  await setupRole(admin, 'shikkha_app', pw(sharedApp));
  await setupRole(admin, 'petra_control_app', pw(ctlApp));
  await recreateSchema(sharedOwner);
  await migrate(sharedOwner);
  await recreateSchema(ctlOwner);
  await migrate(ctlOwner, { dir: CONTROL_MIGRATIONS_DIR, lockKey: 727002 });
}
