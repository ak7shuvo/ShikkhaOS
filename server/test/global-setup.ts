import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { DEFAULT_MAINTENANCE_DBS, hardenDatabaseAccess } from '../src/db-access.js';
import { CONTROL_MIGRATIONS_DIR, migrate, setupRole } from '../src/migrate.js';
import { MARKER_DB, assertClusterMarker, planCleanup, validateTestEnvironment, UnsafeTestEnvironmentError, type ValidatedTestEnv } from './safety.js';

const pw = (url: string) => decodeURIComponent(new URL(url).password);
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Drops ONLY objects attributable to this test environment (see planCleanup). Exported for the guard tests. */
export async function cleanupOwnedObjects(
  v: Pick<ValidatedTestEnv, 'adminUrl' | 'markerUrl' | 'controlOwner'>,
): Promise<{ databases: string[]; roles: string[] }> {
  const registry = await withClient(v.controlOwner, async (c) => {
    const t = await c.query(`SELECT to_regclass('public.schools') AS t`).catch(() => ({ rows: [{ t: null }] }));
    return t.rows[0]!.t ? (await c.query('SELECT db_name, db_role FROM schools')).rows : [];
  }).catch((e: { code?: string }) => {
    if (e.code === '3D000') return []; // control test database does not exist yet
    throw e;
  });
  const ledger = await withClient(v.markerUrl, async (c) => {
    await c.query('CREATE TABLE IF NOT EXISTS created_objects (kind text NOT NULL, name text PRIMARY KEY)');
    return (await c.query('SELECT kind, name FROM created_objects')).rows;
  });
  const plan = planCleanup({ registry, ledger }); // throws before any destructive statement
  await withClient(v.adminUrl, async (a) => {
    for (const d of plan.databases) await a.query(`DROP DATABASE IF EXISTS ${qi(d)} WITH (FORCE)`);
    for (const r of plan.roles) await a.query(`DROP ROLE IF EXISTS ${qi(r)}`);
  });
  await withClient(v.markerUrl, async (c) => {
    await c.query('DELETE FROM created_objects WHERE name = ANY($1)', [ledger.map((l) => l.name)]);
  });
  return plan;
}

/** Validates the environment, proves the cluster is disposable, then recreates the test databases. */
export async function runSetup(env: NodeJS.ProcessEnv): Promise<void> {
  // 1. Pure validation: no connection, no SQL.
  const v = validateTestEnvironment(env);
  // 2. Read-only cluster identification.
  await withClient(v.markerUrl, (m) => assertClusterMarker(m, v.clusterId)).catch((e) => {
    if (e instanceof UnsafeTestEnvironmentError) throw e;
    throw new UnsafeTestEnvironmentError(`cannot verify the cluster marker database "${MARKER_DB}" (${(e as Error).message})`);
  });
  // 3. Only now: destructive operations, restricted to attributable objects.
  await cleanupOwnedObjects(v);
  await withClient(v.adminUrl, async (a) => {
    for (const name of [v.controlDb, v.sharedDb]) {
      if (!(await a.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await a.query(`CREATE DATABASE ${qi(name)}`);
    }
  });
  await setupRole(v.adminUrl, 'shikkha_app', pw(v.sharedApp));
  await setupRole(v.adminUrl, 'petra_control_app', pw(v.controlApp));
  // Cluster-level access control: nobody but the intended roles may CONNECT to the control/shared/maintenance/marker databases
  // (the schema migrations below re-apply the control/shared part; school databases are hardened by provisioning).
  const acl = await hardenDatabaseAccess(v.adminUrl, { controlDb: v.controlDb, sharedDb: v.sharedDb, maintenanceDbs: [...DEFAULT_MAINTENANCE_DBS, MARKER_DB] });
  if (acl.failed.length) throw new Error(`cannot apply database ACLs on the test cluster: ${acl.failed.map((f) => f.database).join(', ')}`);
  for (const url of [v.sharedOwner, v.controlOwner]) await withClient(url, (c) => c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'));
  await migrate(v.sharedOwner);
  await migrate(v.controlOwner, { dir: CONTROL_MIGRATIONS_DIR, lockKey: 727002 });
}

export default async function setup(): Promise<void> {
  const envFile = path.resolve(import.meta.dirname, '../../.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PETRA_MASTER_KEY) process.env.PETRA_MASTER_KEY = randomBytes(32).toString('base64');
  await runSetup(process.env);
}
