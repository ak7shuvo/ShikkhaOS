import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
export function pgEnv(url: string, base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; args: string[] } {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...base, PGPASSWORD: decodeURIComponent(u.password) };
  if (base.NODE_ENV === 'production') {
    // libpq defaults to opportunistic TLS (`prefer`); production dumps/restores must verify certificate and host name.
    env.PGSSLMODE = 'verify-full';
    if (base.DB_SSL_CA_FILE && !base.PGSSLROOTCERT) env.PGSSLROOTCERT = base.DB_SSL_CA_FILE;
  }
  return {
    env,
    args: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)],
  };
}

export interface ExportManifest {
  format: 2;
  school_id: string;
  slug: string;
  database: string;
  created_at: string;
  schema_version: string | null;
  dump_file: string;
  dump_sha256: string;
  table_counts: Record<string, number>;
  /** md5 over the sorted canonical JSON text of every row, per table, taken in the SAME snapshot as the dump. */
  table_digests: Record<string, string>;
  /** HMAC-SHA256 over the canonical manifest, present when PETRA_BACKUP_SIGNING_KEY was configured at export time. */
  signature?: { alg: 'hmac-sha256'; value: string };
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Manifest signing: HMAC-SHA256 with a key (PETRA_BACKUP_SIGNING_KEY) that must be stored SEPARATELY from the backups.
 * It makes the manifest (and, through dump_sha256/table_digests, the dump) tamper-EVIDENT for anyone who can modify
 * backup storage but does not hold the key. It is a shared-secret MAC, not a public-key signature: whoever holds the
 * key can forge manifests, and there is no non-repudiation. Without a configured key manifests are unsigned and only
 * protect against accidental corruption.
 */
const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};
const manifestMac = (m: ExportManifest, key: Buffer): string => {
  const { signature: _s, ...rest } = m;
  return createHmac('sha256', key).update(canonicalJson(rest)).digest('hex');
};
export const signManifest = (m: Omit<ExportManifest, 'signature'>, key: Buffer): ExportManifest => ({
  ...m,
  signature: { alg: 'hmac-sha256', value: manifestMac(m as ExportManifest, key) },
});

function verifyManifest(m: ExportManifest, key: Buffer | undefined): 'verified' | 'unsigned' {
  if (m.format !== 2 || typeof m.table_digests !== 'object' || !m.table_counts)
    throw new Error('unsupported or incomplete manifest (format 2 with table digests required)');
  if (key) {
    if (!m.signature || m.signature.alg !== 'hmac-sha256') throw new Error('manifest is not signed but a backup signing key is configured; refusing');
    const want = Buffer.from(manifestMac(m, key), 'hex');
    const got = Buffer.from(String(m.signature.value), 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error('manifest signature is invalid (tampered manifest or wrong signing key)');
    return 'verified';
  }
  if (m.signature) throw new Error('manifest is signed but no backup signing key is configured; cannot verify it');
  return 'unsigned';
}

interface TableStat {
  count: number;
  digest: string;
}

/** Row count and content digest for every public table, read through `c` (so a caller can pin a snapshot). */
async function tableStats(c: pg.Client): Promise<Record<string, TableStat>> {
  const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string);
  const out: Record<string, TableStat> = {};
  for (const t of tables) {
    const r = (await c.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)), '') AS d FROM "${t}" x`))
      .rows[0];
    out[t] = { count: r.n, digest: r.d };
  }
  return out;
}

/** Full logical backup/export of one school database with an integrity manifest. Uses the privileged connection (operator only). */
export async function exportSchool(
  d: ProvisionDeps,
  schoolId: string,
  outDir: string,
  now = new Date(),
): Promise<{ manifestPath: string; manifest: ExportManifest }> {
  const e = await loadEntry(d, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_name) throw new Error('only dedicated school databases can be exported with this procedure');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dump = path.join(outDir, `${e.slug}-${stamp}.dump`);
  const url = urlForDb(d.adminUrl, e.db_name);
  const { env, args } = pgEnv(url);

  // One REPEATABLE READ snapshot is shared by the digest computation and pg_dump, so digests describe exactly the dumped data.
  const snap = new pg.Client({ connectionString: url });
  await snap.connect();
  let stats: Record<string, TableStat>;
  try {
    await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotId = (await snap.query('SELECT pg_export_snapshot() AS s')).rows[0].s as string;
    stats = await tableStats(snap);
    await run('pg_dump', [...args, '--format=custom', '--no-owner', `--snapshot=${snapshotId}`, '-f', dump, e.db_name], { env });
  } catch (err) {
    fs.rmSync(dump, { force: true });
    throw err;
  } finally {
    await snap.query('ROLLBACK').catch(() => undefined);
    await snap.end().catch(() => undefined);
  }
  fs.chmodSync(dump, 0o600);
  const base: Omit<ExportManifest, 'signature'> = {
    format: 2,
    school_id: e.id,
    slug: e.slug,
    database: e.db_name,
    created_at: now.toISOString(),
    schema_version: e.schema_version,
    dump_file: path.basename(dump),
    dump_sha256: sha256(dump),
    table_counts: Object.fromEntries(Object.entries(stats).map(([t, s]) => [t, s.count])),
    table_digests: Object.fromEntries(Object.entries(stats).map(([t, s]) => [t, s.digest])),
  };
  const manifest: ExportManifest = d.backupSigningKey ? signManifest(base, d.backupSigningKey) : base;
  const manifestPath = `${dump}.manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await platformAudit(d.control, {
    actorId: null,
    schoolId,
    action: 'school.exported',
    entityType: 'school',
    entityId: schoolId,
    metadata: { dump_sha256: manifest.dump_sha256, signed: Boolean(manifest.signature) },
  });
  return { manifestPath, manifest };
}

export interface RestoreResult {
  ok: boolean;
  /** Tables whose row count or content digest differ from the manifest (or that are missing/unexpected). */
  mismatches: string[];
  placeholder_role_created: string | null;
  /** True when a failed verification dropped the scratch database this call had created. */
  cleaned_up: boolean;
  signature: 'verified' | 'unsigned';
}

/**
 * Restores a dump into a NEW database and verifies it against the manifest: signature (when a key is configured),
 * dump checksum, then row counts AND content digests of every table.
 * Restoring over an existing database is refused. If the restore or its verification fails, the scratch database
 * (and a placeholder role) created by THIS call are dropped again, so a failed attempt never leaves debris and can
 * be retried with the same name; a pre-existing database is never touched. Restoring over a live school is not offered:
 * restore to a scratch database, verify, then swap during a maintenance window (docs/SCHOOL_PROVISIONING.md).
 */
export async function restoreDump(d: ProvisionDeps, manifestPath: string, targetDb: string, opts: { keepOnFailure?: boolean } = {}): Promise<RestoreResult> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(targetDb)) throw new Error('invalid target database name');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExportManifest;
  const signature = verifyManifest(manifest, d.backupSigningKey);
  const dump = path.join(path.dirname(manifestPath), manifest.dump_file);
  if (sha256(dump) !== manifest.dump_sha256) throw new Error('dump file does not match its manifest checksum (corrupted or tampered)');

  let created = false;
  let placeholder: string | null = null;
  const cleanup = async (): Promise<boolean> => {
    if (!created || opts.keepOnFailure) return false;
    const admin = new pg.Client({ connectionString: d.adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
      if (placeholder) await admin.query(`DROP ROLE IF EXISTS "${placeholder}"`);
      return true;
    } finally {
      await admin.end();
    }
  };

  const admin = new pg.Client({ connectionString: d.adminUrl });
  await admin.connect();
  try {
    if ((await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [targetDb])).rowCount)
      throw new Error('target database already exists; refusing to restore over it'); // not ours: nothing to clean up
    await admin.query(`CREATE DATABASE "${targetDb}"`);
    created = true;
    await admin.query(`REVOKE ALL ON DATABASE "${targetDb}" FROM PUBLIC`); // restored data is personal data: nobody may connect by default
    // The dump carries GRANTs to the school's login role. If that role no longer exists (e.g. after offboarding),
    // a NOLOGIN placeholder lets the restore complete faithfully; it can never connect.
    const role = `${manifest.database}_app`;
    if (/^sk_[a-f0-9]{12}_app$/.test(role) && !(await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      placeholder = role;
    }
  } catch (err) {
    await admin.end().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw err;
  }
  await admin.end();

  try {
    const { env, args } = pgEnv(urlForDb(d.adminUrl, targetDb));
    await run('pg_restore', [...args, '--no-owner', '--exit-on-error', '-d', targetDb, dump], { env });
    const c = new pg.Client({ connectionString: urlForDb(d.adminUrl, targetDb) });
    await c.connect();
    let got: Record<string, TableStat>;
    try {
      got = await tableStats(c);
    } finally {
      await c.end();
    }
    const mismatches = new Set<string>();
    for (const [t, n] of Object.entries(manifest.table_counts)) if (got[t]?.count !== n || got[t]?.digest !== manifest.table_digests[t]) mismatches.add(t);
    for (const t of Object.keys(got)) if (!(t in manifest.table_counts)) mismatches.add(t);
    if (mismatches.size) {
      const cleaned = await cleanup().catch(() => false);
      return { ok: false, mismatches: [...mismatches].sort(), placeholder_role_created: cleaned ? null : placeholder, cleaned_up: cleaned, signature };
    }
    return { ok: true, mismatches: [], placeholder_role_created: placeholder, cleaned_up: false, signature };
  } catch (err) {
    await cleanup().catch(() => undefined); // partial restore: remove what this call created, then report the real error
    throw err;
  }
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
  await d.control.query(`INSERT INTO subscription_events (school_id, event, actor_id, note) VALUES ($1,'offboarding_started',$2,$3)`, [
    schoolId,
    actorId,
    reason,
  ]);
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
  const sub = (
    await d.control.query(`SELECT status, period_end, grace_days, readonly_days, retention_days, legal_hold FROM subscriptions WHERE school_id = $1`, [
      schoolId,
    ])
  ).rows[0] as SubscriptionRow | undefined;
  if (!sub) throw new Error('no subscription on record; refusing to delete');
  // `today` is supplied by the CLI from the real clock; refuse a date from the future so a caller cannot fast-forward retention.
  if (o.today > addDays(new Date().toISOString().slice(0, 10), 1)) throw new Error('today must not be in the future');
  const ent = entitlementOf(sub, o.today); // retention is clamped to MIN_RETENTION_DAYS inside entitlementOf
  if (sub.legal_hold) throw new Error('legal hold is set; deletion is not permitted');
  if (!ent.deletion_allowed_from || o.today < ent.deletion_allowed_from)
    throw new Error(`retention window has not elapsed; deletion allowed from ${ent.deletion_allowed_from}`);

  // Final export, verified by an actual restore into a scratch database. The scratch name is derived from this school's
  // database, so a leftover from an earlier failed attempt is ours to remove: that keeps the whole procedure retryable.
  const scratch = `verify_${dbNameFor(schoolId)}`.slice(0, 40);
  await dropScratchDatabase(d, scratch);
  const { manifestPath, manifest } = await exportSchool(d, schoolId, o.exportDir);
  await d.testHooks?.afterExport?.(manifestPath);
  let verify: RestoreResult;
  try {
    verify = await restoreDump(d, manifestPath, scratch); // cleans up after itself on failure or mismatch
  } finally {
    await dropScratchDatabase(d, scratch).catch(() => undefined);
  }
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
  await d.control.query(`INSERT INTO subscription_events (school_id, event, actor_id, note) VALUES ($1,'offboarded',$2,$3)`, [
    schoolId,
    o.actorId,
    `database deleted; export sha256 ${manifest.dump_sha256}`,
  ]);
  await platformAudit(d.control, {
    actorId: o.actorId,
    schoolId,
    action: 'school.offboarded',
    entityType: 'school',
    entityId: schoolId,
    metadata: { export_sha256: manifest.dump_sha256, retention_until: ent.retention_until, manifest_signed: Boolean(manifest.signature) },
  });
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
    const u = await c.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE email = $1 RETURNING id`, [
      email,
      await hashPassword(password),
    ]);
    if (!u.rowCount) throw new Error('no such account in this school');
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [u.rows[0].id]);
  } finally {
    await c.end();
  }
  await platformAudit(d.control, { actorId: null, schoolId, action: 'school.account_password_reset', entityType: 'user', metadata: { by: 'operator' } });
  return { password };
}

/** Clears every login lock (per-address and account-wide) for one account, e.g. after a targeted lock-out. Audited in the control plane. */
export async function unlockSchoolAccount(d: ProvisionDeps, schoolId: string, email: string): Promise<void> {
  const e = await loadEntry(d, schoolId);
  if (e.db_mode !== 'dedicated' || !e.db_name) throw new Error('dedicated database required');
  const c = new pg.Client({ connectionString: urlForDb(d.adminUrl, e.db_name) });
  await c.connect();
  try {
    const u = await c.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1 RETURNING id`, [email]);
    if (!u.rowCount) throw new Error('no such account in this school');
    await c.query(`DELETE FROM login_attempts WHERE user_id = $1`, [u.rows[0].id]);
  } finally {
    await c.end();
  }
  await platformAudit(d.control, { actorId: null, schoolId, action: 'school.account_unlocked', entityType: 'user', metadata: { by: 'operator' } });
}
