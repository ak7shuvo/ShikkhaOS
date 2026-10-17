import { randomUUID } from 'node:crypto';
import type { TlsOptions } from './tls.js';
import pg from 'pg';
import { type Db } from './db.js';
import { APP_ROLE_PLACEHOLDER, SCHOOL_MIGRATIONS_DIR, appliedMigrations, migrate, migrationFiles } from './migrate.js';
import { hashPassword } from './passwords.js';
import { generateDbPassword, type SecretBox } from './secrets.js';
import { platformAudit } from './registry.js';
import { REGISTRY_COLUMNS, type RegistryEntry } from './tenancy.js';

export const STEPS = ['requested', 'db_created', 'role_created', 'migrated', 'seeded', 'active'] as const;
export type Step = (typeof STEPS)[number];
const ord = (s: string) => STEPS.indexOf(s as Step);

export interface ProvisionDeps {
  control: Db;
  secrets: SecretBox;
  /** Privileged connection URL (CREATEDB + CREATEROLE) to the maintenance database. Used ONLY by provisioning tooling. */
  adminUrl: string;
  /** Test hook: runs after each step is committed; throw to simulate a crash. */
  afterStep?: (step: Step) => void | Promise<void>;
  /** Hostname/port the API runtime must use to reach school databases (defaults to the admin connection's). */
  runtimeHost?: string;
  runtimePort?: number;
  schoolMigrationsDir?: string;
  /** TLS options for health-check connections made AS a school role (same verified-TLS settings as the API's school pools). */
  schoolSsl?: false | TlsOptions;
  /** HMAC key for backup manifests (PETRA_BACKUP_SIGNING_KEY). Keep it separate from the backups and from the master key. */
  backupSigningKey?: Buffer;
  /** Test-only hooks. */
  testHooks?: { afterExport?: (manifestPath: string) => void | Promise<void> };
}

export class ProvisioningBusyError extends Error {}

export const dbNameFor = (id: string) => `sk_${id.replace(/-/g, '').slice(0, 12)}`;
export const roleNameFor = (id: string) => `${dbNameFor(id)}_app`;

export function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const ident = (s: string) => {
  if (!/^sk_[a-f0-9]{12}(_app)?$/.test(s)) throw new Error('refusing to use an unexpected identifier');
  return `"${s}"`;
};

async function loadEntry(control: Db, id: string): Promise<RegistryEntry> {
  const { rows } = await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error('school not found');
  return rows[0] as RegistryEntry;
}

export interface ProvisionResult {
  schoolId: string;
  step: Step;
  /** Shown once. Only present when the first admin account was created by this run. */
  adminInitialPassword?: string;
}

/**
 * Idempotent, resumable provisioning of a school's dedicated database.
 *   requested → db_created → role_created → migrated → seeded → active
 * Every action checks real state before acting, the step column only ever advances, and
 * a per-school advisory lock prevents concurrent runs. Re-running after a crash resumes safely.
 */
export async function provisionSchool(d: ProvisionDeps, schoolId: string, opts: { seed?: boolean; actorId?: string | null } = {}): Promise<ProvisionResult> {
  const seed = opts.seed ?? true;
  const lock = await d.control.connect();
  try {
    const got = (await lock.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`provision:${schoolId}`])).rows[0].ok;
    if (!got) throw new ProvisioningBusyError('another provisioning run holds the lock for this school');
    return await run(d, schoolId, seed, opts.actorId ?? null);
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`provision:${schoolId}`]).catch(() => undefined);
    lock.release();
  }
}

async function run(d: ProvisionDeps, schoolId: string, seed: boolean, actorId: string | null): Promise<ProvisionResult> {
  let e = await loadEntry(d.control, schoolId);
  if (e.db_mode === 'dedicated' && e.status === 'active' && e.provisioning_step === 'active') return { schoolId, step: 'active' };
  if (!['requested', 'provisioning', 'failed', 'active'].includes(e.status)) throw new Error(`school status "${e.status}" cannot be provisioned`);

  const dbName = dbNameFor(schoolId);
  const roleName = roleNameFor(schoolId);
  const adminHost = new URL(d.adminUrl);
  const host = d.runtimeHost ?? adminHost.hostname;
  const port = d.runtimePort ?? Number(adminHost.port || 5432);
  let secret: string | null = null;
  let adminInitialPassword: string | undefined;

  // Shared-mode schools are provisioned only to prepare a migration target; they stay db_mode='shared' and active.
  const keepStatus = e.db_mode === 'shared';
  if (!keepStatus) await d.control.query(`UPDATE schools SET status = 'provisioning', provisioning_error = NULL WHERE id = $1`, [schoolId]);

  const advance = async (step: Step) => {
    if (ord(step) > ord(e.provisioning_step)) {
      await d.control.query(`UPDATE schools SET provisioning_step = $2 WHERE id = $1`, [schoolId, step]);
      e = { ...e, provisioning_step: step };
    }
    await d.afterStep?.(step);
  };

  const redact = (m: string) => (secret ? m.split(secret).join('***') : m);
  try {
    const admin = new pg.Client({ connectionString: d.adminUrl });
    await admin.connect();
    try {
      // ---- 1. database -------------------------------------------------------------------------
      await d.control.query(`UPDATE schools SET db_host = $2, db_port = $3, db_name = $4, db_role = $5 WHERE id = $1`, [
        schoolId,
        host,
        port,
        dbName,
        roleName,
      ]);
      const exists = (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName])).rowCount;
      if (!exists) await admin.query(`CREATE DATABASE ${ident(dbName)}`);
      await admin.query(`REVOKE ALL ON DATABASE ${ident(dbName)} FROM PUBLIC`); // nobody but explicit grantees may connect
      await advance('db_created');

      // ---- 2. role + credential ----------------------------------------------------------------
      // The credential is generated and stored (encrypted) BEFORE the role is touched, so a crash can never lose it.
      e = await loadEntry(d.control, schoolId);
      if (!e.db_secret_enc) {
        secret = generateDbPassword();
        await d.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1 AND db_secret_enc IS NULL`, [schoolId, d.secrets.encrypt(secret, schoolId)]);
        e = await loadEntry(d.control, schoolId);
      }
      secret = d.secrets.decrypt(e.db_secret_enc!, schoolId);
      const pw = (await admin.query('SELECT quote_literal($1) AS q', [secret])).rows[0].q as string;
      const roleExists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName])).rowCount;
      await admin.query(
        `${roleExists ? 'ALTER' : 'CREATE'} ROLE ${ident(roleName)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20 PASSWORD ${pw}`,
      );
      await admin.query(`ALTER ROLE ${ident(roleName)} SET statement_timeout = '30s'`);
      await admin.query(`ALTER ROLE ${ident(roleName)} SET idle_in_transaction_session_timeout = '60s'`);
      await admin.query(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(roleName)}`);
      await advance('role_created');
    } finally {
      await admin.end();
    }

    // ---- 3. schema -----------------------------------------------------------------------------
    const dbUrl = urlForDb(d.adminUrl, dbName);
    await migrate(dbUrl, { dir: d.schoolMigrationsDir ?? SCHOOL_MIGRATIONS_DIR, appRole: roleName, lockKey: 727003 });
    const sdb = new pg.Client({ connectionString: dbUrl });
    await sdb.connect();
    try {
      await sdb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await sdb.query(`GRANT USAGE ON SCHEMA public TO ${ident(roleName)}`);
      await advance('migrated');

      // ---- 4. initial data -----------------------------------------------------------------------
      if (seed) {
        await sdb.query(`INSERT INTO schools (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [schoolId, e.slug, e.name]);
        if (e.admin_email) {
          const has = (await sdb.query(`SELECT 1 FROM users WHERE email = $1`, [e.admin_email])).rowCount;
          if (!has) {
            adminInitialPassword = generateDbPassword().slice(0, 20);
            const uid = randomUUID();
            await sdb.query(`INSERT INTO users (id, email, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,$4,true)`, [
              uid,
              e.admin_email,
              await hashPassword(adminInitialPassword),
              e.admin_name ?? 'School Admin',
            ]);
            await sdb.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,'school_admin')`, [schoolId, uid]);
          }
        }
      }
      await advance('seeded');
    } finally {
      await sdb.end();
    }

    // ---- 5. health check then activate ---------------------------------------------------------
    const health = await checkSchoolHealth(d, await loadEntry(d.control, schoolId), { requireSchoolRow: seed });
    if (!health.ok)
      throw new Error(
        `health check failed: ${health.checks
          .filter((c) => !c.ok)
          .map((c) => c.name)
          .join(', ')}`,
      );
    await d.control.query(
      `UPDATE schools SET schema_version = $2, provisioning_error = NULL, provisioning_step = 'active', status = CASE WHEN db_mode = 'dedicated' THEN 'active' ELSE status END WHERE id = $1`,
      [schoolId, health.schema_version],
    );
    await platformAudit(d.control, {
      actorId,
      schoolId,
      action: 'school.provisioned',
      entityType: 'school',
      entityId: schoolId,
      metadata: { db_name: dbName, schema_version: health.schema_version },
    });
    await d.afterStep?.('active');
    return { schoolId, step: 'active', adminInitialPassword };
  } catch (err) {
    const msg = redact((err as Error).message).slice(0, 500);
    if (!keepStatus)
      await d.control.query(`UPDATE schools SET status = 'failed', provisioning_error = $2 WHERE id = $1`, [schoolId, msg]).catch(() => undefined);
    else await d.control.query(`UPDATE schools SET provisioning_error = $2 WHERE id = $1`, [schoolId, msg]).catch(() => undefined);
    throw new Error(msg);
  }
}

export interface HealthReport {
  ok: boolean;
  schema_version: string | null;
  pending_migrations: string[];
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** Connects with the school's OWN runtime credential (as the API would) and verifies isolation basics. */
export async function checkSchoolHealth(
  d: Pick<ProvisionDeps, 'control' | 'secrets' | 'adminUrl' | 'schoolMigrationsDir' | 'schoolSsl'>,
  e: RegistryEntry,
  opts: { requireSchoolRow?: boolean } = {},
): Promise<HealthReport> {
  const checks: HealthReport['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  let schemaVersion: string | null = null;
  let pending: string[] = [];
  if (!e.db_name || !e.db_role || !e.db_secret_enc) {
    return { ok: false, schema_version: null, pending_migrations: [], checks: [{ name: 'dedicated_database_configured', ok: false }] };
  }
  const c = new pg.Client({
    host: e.db_host!,
    port: e.db_port!,
    database: e.db_name,
    user: e.db_role,
    password: d.secrets.decrypt(e.db_secret_enc, e.id),
    connectionTimeoutMillis: 5000,
    ...(d.schoolSsl ? { ssl: d.schoolSsl } : {}),
  });
  try {
    const t0 = Date.now();
    await c.connect();
    add('connect_as_school_role', true, `${Date.now() - t0}ms`);
    const who = (
      await c.query(
        `SELECT current_database() AS d, current_user AS u, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0];
    add('lands_on_registered_database', who.d === e.db_name && who.u === e.db_role);
    add('role_is_restricted', !who.rolsuper && !who.rolbypassrls && !who.rolcreatedb && !who.rolcreaterole);
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.school_id', $1, true)`, [e.id]);
    const rows = (await c.query(`SELECT id FROM schools`)).rows;
    await c.query('COMMIT');
    add('single_school_row_matches_registry', opts.requireSchoolRow === false ? true : rows.length === 1 && rows[0].id === e.id, `rows=${rows.length}`);
    // The school role may open a session on its own database and on NO other (control plane, shared legacy database,
    // other schools, postgres, template1, backup/scratch databases).
    const other = (
      await c.query(
        `SELECT datname FROM pg_database WHERE datallowconn AND datname <> $1 AND has_database_privilege(current_user, datname, 'CONNECT') ORDER BY 1`,
        [e.db_name],
      )
    ).rows.map((r) => r.datname as string);
    add(
      'no_connect_privilege_on_other_databases',
      other.length === 0,
      other.length ? `connectable: ${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''} (run: npm run petra -- harden-db-access)` : undefined,
    );
  } catch (err) {
    add('connect_as_school_role', false, (err as Error).message.slice(0, 120));
  } finally {
    await c.end().catch(() => undefined);
  }
  try {
    const applied = await appliedMigrations(urlForDb(d.adminUrl, e.db_name));
    pending = migrationFiles(d.schoolMigrationsDir ?? SCHOOL_MIGRATIONS_DIR).filter((f) => !applied.includes(f));
    schemaVersion = applied.at(-1) ?? null;
    add('migrations_current', pending.length === 0, pending.join(',') || undefined);
  } catch (err) {
    add('migrations_current', false, (err as Error).message.slice(0, 120));
  }
  return { ok: checks.every((x) => x.ok), schema_version: schemaVersion, pending_migrations: pending, checks };
}

/** Applies pending migrations to one dedicated school database using the privileged connection. */
export async function migrateSchool(d: ProvisionDeps, schoolId: string): Promise<string[]> {
  const e = await loadEntry(d.control, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_name || !e.db_role) throw new Error('school has no dedicated database');
  const applied = await migrate(urlForDb(d.adminUrl, e.db_name), { dir: d.schoolMigrationsDir ?? SCHOOL_MIGRATIONS_DIR, appRole: e.db_role, lockKey: 727003 });
  if (applied.length)
    await d.control.query(`UPDATE schools SET schema_version = $2 WHERE id = $1`, [
      schoolId,
      (await appliedMigrations(urlForDb(d.adminUrl, e.db_name))).at(-1),
    ]);
  return applied;
}

/**
 * Credential rotation with a pending slot so a crash between ALTER ROLE and the registry update is recoverable:
 * the router falls back to the pending secret when the current one is rejected.
 */
export async function rotateSchoolSecret(d: ProvisionDeps, schoolId: string, hooks: { afterPending?: () => void | Promise<void> } = {}): Promise<void> {
  let e = await loadEntry(d.control, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_role || !e.db_name) throw new Error('school has no dedicated database');
  if (!e.db_secret_pending_enc) {
    await d.control.query(`UPDATE schools SET db_secret_pending_enc = $2 WHERE id = $1`, [schoolId, d.secrets.encrypt(generateDbPassword(), schoolId)]);
    e = await loadEntry(d.control, schoolId);
  }
  await hooks.afterPending?.();
  const pending = d.secrets.decrypt(e.db_secret_pending_enc!, schoolId);
  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  try {
    const pw = (await admin.query('SELECT quote_literal($1) AS q', [pending])).rows[0].q as string;
    await admin.query(`ALTER ROLE ${ident(e.db_role!)} PASSWORD ${pw}`);
  } finally {
    await admin.end();
  }
  await d.control.query(`UPDATE schools SET db_secret_enc = db_secret_pending_enc, db_secret_pending_enc = NULL WHERE id = $1`, [schoolId]);
  await platformAudit(d.control, { actorId: null, schoolId, action: 'school.db_secret_rotated', entityType: 'school', entityId: schoolId });
}

/**
 * Re-encrypts stored credentials (current and pending slot) with the current master key. Safe to repeat and safe to interrupt:
 * every row is an independent compare-and-swap (the UPDATE only applies if the row still holds the ciphertext that was read, so a
 * concurrent credential rotation is never overwritten — such rows are counted as `skipped` and picked up by the next run), a
 * mixed state stays decryptable as long as the previous key is configured, and a ciphertext that cannot be decrypted aborts the run
 * before that row is touched. `schoolIds` limits the run (used by tests); the CLI processes every school.
 */
export async function reencryptAllSecrets(control: Db, secrets: SecretBox, opts: { schoolIds?: string[] } = {}): Promise<{ updated: number; skipped: number }> {
  const { rows } = await control.query(
    `SELECT id, db_secret_enc, db_secret_pending_enc FROM schools WHERE db_secret_enc IS NOT NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY id`,
    [opts.schoolIds ?? null],
  );
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const cur = secrets.reencrypt(r.db_secret_enc, r.id);
    const pend = r.db_secret_pending_enc ? secrets.reencrypt(r.db_secret_pending_enc, r.id) : null;
    if (cur === r.db_secret_enc && pend === r.db_secret_pending_enc) continue;
    const u = await control.query(
      `UPDATE schools SET db_secret_enc = $2, db_secret_pending_enc = $3
        WHERE id = $1 AND db_secret_enc = $4 AND db_secret_pending_enc IS NOT DISTINCT FROM $5`,
      [r.id, cur, pend, r.db_secret_enc, r.db_secret_pending_enc],
    );
    if (u.rowCount) updated++;
    else skipped++;
  }
  return { updated, skipped };
}

export { APP_ROLE_PLACEHOLDER };
