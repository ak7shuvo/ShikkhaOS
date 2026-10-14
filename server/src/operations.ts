import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { addDays, entitlementOf, type SubscriptionRow } from './entitlements.js';
import { dbNameFor, roleNameFor, urlForDb, type ProvisionDeps } from './provisioning.js';
import { platformAudit } from './registry.js';
import { REGISTRY_COLUMNS, type RegistryEntry } from './tenancy.js';
import { generateDbPassword } from './secrets.js';
import { hashPassword } from './passwords.js';

const run = promisify(execFile);

async function loadEntry(d: ProvisionDeps, id: string): Promise<RegistryEntry> {
  const { rows } = await d.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error('school not found');
  return rows[0] as RegistryEntry;
}

/** pg_* tools get the password via the environment, never on the command line. */
function pgEnv(url: string): { env: NodeJS.ProcessEnv; args: string[] } {
  const u = new URL(url);
  return {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
    args: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)],
  };
}

export interface ExportManifest {
  format: 1;
  school_id: string;
  slug: string;
  database: string;
  created_at: string;
  schema_version: string | null;
  dump_file: string;
  dump_sha256: string;
  table_counts: Record<string, number>;
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function tableCounts(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string);
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = (await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
    return out;
  } finally {
    await c.end();
  }
}

/** Full logical backup/export of one school database with an integrity manifest. Uses the privileged connection (operator only). */
export async function exportSchool(d: ProvisionDeps, schoolId: string, outDir: string, now = new Date()): Promise<{ manifestPath: string; manifest: ExportManifest }> {
  const e = await loadEntry(d, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_name) throw new Error('only dedicated school databases can be exported with this procedure');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dump = path.join(outDir, `${e.slug}-${stamp}.dump`);
  const url = urlForDb(d.adminUrl, e.db_name);
  const { env, args } = pgEnv(url);
  await run('pg_dump', [...args, '--format=custom', '--no-owner', '-f', dump, e.db_name], { env });
  fs.chmodSync(dump, 0o600);
  const manifest: ExportManifest = {
    format: 1,
    school_id: e.id,
    slug: e.slug,
    database: e.db_name,
    created_at: now.toISOString(),
    schema_version: e.schema_version,
    dump_file: path.basename(dump),
    dump_sha256: sha256(dump),
    table_counts: await tableCounts(url),
  };
  const manifestPath = `${dump}.manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await platformAudit(d.control, { actorId: null, schoolId, action: 'school.exported', entityType: 'school', entityId: schoolId, metadata: { dump_sha256: manifest.dump_sha256 } });
  return { manifestPath, manifest };
}

/**
 * Restores a dump into a database NAME OF YOUR CHOICE (created if missing) and verifies it against the manifest.
 * Restoring over a live school database is intentionally not offered here: restore to a scratch database,
 * verify, then swap during a maintenance window (see docs/SCHOOL_PROVISIONING.md).
 */
export async function restoreDump(d: ProvisionDeps, manifestPath: string, targetDb: string): Promise<{ ok: boolean; mismatches: string[]; placeholder_role_created: string | null }> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(targetDb)) throw new Error('invalid target database name');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExportManifest;
  const dump = path.join(path.dirname(manifestPath), manifest.dump_file);
  let placeholder: string | null = null;
  if (sha256(dump) !== manifest.dump_sha256) throw new Error('dump file does not match its manifest checksum (corrupted or tampered)');
  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  try {
    if ((await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [targetDb])).rowCount) throw new Error('target database already exists; refusing to restore over it');
    await admin.query(`CREATE DATABASE "${targetDb}"`);
    // The dump carries GRANTs to the school's login role. If that role no longer exists (e.g. after offboarding),
    // a NOLOGIN placeholder lets the restore complete faithfully; it can never connect.
    const role = `${manifest.database}_app`;
    if (/^sk_[a-f0-9]{12}_app$/.test(role) && !(await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      placeholder = role;
    }
  } finally {
    await admin.end();
  }
  const { env, args } = pgEnv(urlForDb(d.adminUrl, targetDb));
  // Grants to the school role are restored with the dump; that role must exist (it does for the same school).
  await run('pg_restore', [...args, '--no-owner', '--exit-on-error', '-d', targetDb, dump], { env });
  const counts = await tableCounts(urlForDb(d.adminUrl, targetDb));
  const mismatches = Object.entries(manifest.table_counts).filter(([t, n]) => counts[t] !== n).map(([t]) => t);
  return { ok: mismatches.length === 0, mismatches, placeholder_role_created: placeholder };
}

export async function dropScratchDatabase(d: ProvisionDeps, name: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(name) || /^sk_[a-f0-9]{12}$/.test(name)) throw new Error('refusing to drop this database');
  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------------------------- offboarding
/** Step 1: close the school (users locked out, data fully preserved). Reversible by setting the status back to active. */
export async function startOffboarding(d: ProvisionDeps, schoolId: string, actorId: string | null, reason: string): Promise<void> {
  const e = await loadEntry(d, schoolId);
  if (!['active', 'suspended'].includes(e.status)) throw new Error(`cannot start offboarding from "${e.status}"`);
  await d.control.query(`UPDATE schools SET status = 'offboarding' WHERE id = $1`, [schoolId]);
  await d.control.query(`INSERT INTO subscription_events (school_id, event, actor_id, note) VALUES ($1,'offboarding_started',$2,$3)`, [schoolId, actorId, reason]);
  await platformAudit(d.control, { actorId, schoolId, action: 'school.offboarding_started', entityType: 'school', entityId: schoolId, metadata: { reason } });
}

export interface FinalizeOptions {
  confirmSlug: string;
  exportDir: string;
  today: string;
  actorId: string | null;
}

/**
 * Step 2 (destructive, irreversible): drops the school's database and role after
 *  - the school is in 'offboarding' (explicit step 1),
 *  - the retention window after the subscription end has elapsed and no legal hold is set,
 *  - a final export was written AND restore-verified against its manifest,
 *  - the operator typed the slug.
 * A failed payment alone can never reach this code: nothing schedules it.
 */
export async function finalizeOffboarding(d: ProvisionDeps, schoolId: string, o: FinalizeOptions): Promise<{ manifestPath: string }> {
  const e = await loadEntry(d, schoolId);
  if (o.confirmSlug !== e.slug) throw new Error('confirmation slug does not match');
  if (e.status !== 'offboarding') throw new Error('school must be in offboarding status first');
  if (e.db_mode !== 'dedicated' || !e.db_name || !e.db_role) throw new Error('only dedicated databases can be deleted; migrate shared schools first');
  const sub = (await d.control.query(`SELECT status, period_end, grace_days, readonly_days, retention_days, legal_hold FROM subscriptions WHERE school_id = $1`, [schoolId])).rows[0] as SubscriptionRow | undefined;
  if (!sub) throw new Error('no subscription on record; refusing to delete');
  const ent = entitlementOf(sub, o.today);
  if (sub.legal_hold) throw new Error('legal hold is set; deletion is not permitted');
  if (!ent.deletion_allowed_from || o.today < ent.deletion_allowed_from) throw new Error(`retention window has not elapsed; deletion allowed from ${ent.deletion_allowed_from}`);

  // Final export, verified by an actual restore into a scratch database.
  const { manifestPath, manifest } = await exportSchool(d, schoolId, o.exportDir);
  const scratch = `verify_${manifest.database}`.slice(0, 40);
  const verify = await restoreDump(d, manifestPath, scratch);
  await dropScratchDatabase(d, scratch);
  if (!verify.ok) throw new Error(`final export failed verification (${verify.mismatches.join(', ')}); nothing was deleted`);

  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbNameFor(schoolId)}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${roleNameFor(schoolId)}"`);
  } finally {
    await admin.end();
  }
  await d.control.query(`UPDATE schools SET status = 'archived', db_secret_enc = NULL, db_secret_pending_enc = NULL WHERE id = $1`, [schoolId]);
  await d.control.query(`INSERT INTO subscription_events (school_id, event, actor_id, note) VALUES ($1,'offboarded',$2,$3)`, [schoolId, o.actorId, `database deleted; export sha256 ${manifest.dump_sha256}`]);
  await platformAudit(d.control, { actorId: o.actorId, schoolId, action: 'school.offboarded', entityType: 'school', entityId: schoolId, metadata: { export_sha256: manifest.dump_sha256, retention_until: addDays(sub.period_end, sub.retention_days) } });
  return { manifestPath };
}

// ---------------------------------------------------------------------------------------------- support
/** Resets the first-admin (or any named) account of a school when the one-time initial password was lost. Prints a new random password once. */
export async function resetSchoolAccountPassword(d: ProvisionDeps, schoolId: string, email: string): Promise<{ password: string }> {
  const e = await loadEntry(d, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_name) throw new Error('dedicated database required');
  const password = generateDbPassword().slice(0, 20);
  const c = new pg.Client({ connectionString: urlForDb(d.adminUrl, e.db_name) });
  await c.connect();
  try {
    const u = await c.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE email = $1 RETURNING id`, [email, await hashPassword(password)]);
    if (!u.rowCount) throw new Error('no such account in this school');
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [u.rows[0].id]);
  } finally {
    await c.end();
  }
  await platformAudit(d.control, { actorId: null, schoolId, action: 'school.account_password_reset', entityType: 'user', metadata: { by: 'operator' } });
  return { password };
}
