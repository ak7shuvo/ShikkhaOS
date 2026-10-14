import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrate, setupRole } from '../src/migrate.js';

/** Recreates the disposable test database schema from the real migrations. */
export default async function setup(): Promise<void> {
  const envFile = path.resolve(import.meta.dirname, '../../.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const owner = process.env.TEST_MIGRATION_DATABASE_URL;
  const appUrl = process.env.TEST_DATABASE_URL;
  if (!owner || !appUrl) {
    throw new Error(
      'TEST_MIGRATION_DATABASE_URL and TEST_DATABASE_URL must be set (see .env.example). A real PostgreSQL is required; tests do not mock the database.',
    );
  }
  const appPassword = decodeURIComponent(new URL(appUrl).password);
  await setupRole(owner, appPassword);
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(owner);
}
