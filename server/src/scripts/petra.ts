/**
 * Petra operator CLI. Runs on an operations host that holds the privileged PROVISIONER_DATABASE_URL.
 * The API server never has this credential. Usage: npm run petra -- <command> [args]
 */
import path from 'node:path';
import pg from 'pg';
import { writeBuildProfile } from '../build-profile.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { todayIn } from '../entitlements.js';
import { tlsOptions } from '../tls.js';
import { exportSchool, finalizeOffboarding, resetSchoolAccountPassword, restoreDump, startOffboarding } from '../operations.js';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../passwords.js';
import { DEFAULT_MAINTENANCE_DBS, checkDatabaseAcls, hardenDatabaseAccess, type AclSpec } from '../db-access.js';
import { checkSchoolHealth, migrateSchool, provisionSchool, reencryptAllSecrets, rotateSchoolSecret, urlForDb, type ProvisionDeps } from '../provisioning.js';
import { registerSchool } from '../registry.js';
import { SecretBox, generateMasterKey, loadMasterKeys } from '../secrets.js';
import { seedSchool } from '../seed-data.js';
import {
  importPlatformAdmins,
  inspectMaintenance,
  migrateSharedToDedicated,
  recoverMaintenance,
  rollbackToShared,
  type MigrationDeps,
  type RecoveryAction,
} from '../shared-migration.js';
import { sweepSubscriptions } from '../subscriptions.js';
import { REGISTRY_COLUMNS, type RegistryEntry } from '../tenancy.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(`--${n}`);
const positional = rest.filter((a) => !a.startsWith('--'));
function die(m: string): never {
  console.error(m);
  process.exit(1);
}

if (cmd === 'generate-master-key') {
  console.log(generateMasterKey());
  console.log(
    'Store this value in your secret manager as PETRA_MASTER_KEY. It is not saved anywhere else; losing it makes stored school credentials unrecoverable.',
  );
  process.exit(0);
}
if (!cmd || cmd === 'help')
  die(
    'commands: register provision migrate health rotate-secret reencrypt-secrets sweep export restore offboard-start offboard-finalize admin-reset migrate-to-dedicated rollback-to-shared import-platform-admins platform-admin-create build-profile seed-demo generate-master-key generate-signing-key harden-db-access migration-inspect migration-recover',
  );

const config = loadConfig();
const control = createPool(config.CONTROL_DATABASE_URL, tlsOptions(config.CONTROL_DB_SSL, config.DB_SSL_CA_FILE));
const adminUrl = process.env.PROVISIONER_DATABASE_URL ?? die('PROVISIONER_DATABASE_URL is required');
const secrets = new SecretBox(loadMasterKeys(config));
const signingKey = process.env.PETRA_BACKUP_SIGNING_KEY ? Buffer.from(process.env.PETRA_BACKUP_SIGNING_KEY, 'base64') : undefined;
if (signingKey && signingKey.length !== 32) die('PETRA_BACKUP_SIGNING_KEY must be base64 of exactly 32 bytes');
const deps: ProvisionDeps = { control, secrets, adminUrl, backupSigningKey: signingKey };

const dbNameOf = (url: string | undefined) => (url ? decodeURIComponent(new URL(url).pathname.slice(1)) : undefined);
/** Which databases are protected from application roles. Maintenance databases can be skipped with --skip-maintenance. */
async function aclSpec(): Promise<AclSpec> {
  const schools = (await control.query(`SELECT db_name, db_role FROM schools WHERE db_name IS NOT NULL AND db_role IS NOT NULL AND status NOT IN ('archived')`))
    .rows;
  return {
    controlDb: dbNameOf(config.CONTROL_DATABASE_URL),
    sharedDb: dbNameOf(config.SHARED_DATABASE_URL),
    maintenanceDbs: flag('skip-maintenance') ? [] : DEFAULT_MAINTENANCE_DBS,
    operatorRoles: (process.env.PETRA_OPERATOR_ROLES ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    schools,
  };
}
async function hardenOrFail(): Promise<void> {
  const r = await hardenDatabaseAccess(adminUrl, await aclSpec());
  for (const f of r.failed)
    console.error(`ACL NOT APPLIED on "${f.database}": ${f.error}\n  A database owner/superuser must run:\n    ${f.sql.join(';\n    ')};`);
  if (r.failed.length) throw new Error('database access control could not be fully applied');
}
const today = todayIn(config.BILLING_TIMEZONE);

async function school(ref: string | undefined): Promise<RegistryEntry> {
  if (!ref) die('school slug required');
  const { rows } = await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE slug = $1`, [ref]);
  return (rows[0] as RegistryEntry | undefined) ?? die(`no school with slug "${ref}"`);
}
const sharedOwner = () => process.env.MIGRATION_DATABASE_URL ?? die('MIGRATION_DATABASE_URL (shared database owner) is required for this command');
const mdeps = (): MigrationDeps => ({ ...deps, sharedOwnerUrl: sharedOwner(), quiesceMs: (config.ENTITLEMENT_CACHE_SECONDS + 2) * 1000 });

try {
  switch (cmd) {
    case 'register': {
      const [slug, name, adminEmail, adminName, plan] = positional;
      if (!slug || !name || !adminEmail || !adminName) die('usage: register <slug> <name> <admin-email> <admin-name> [monthly|annual]');
      const r = await registerSchool(control, {
        slug,
        name,
        adminEmail,
        adminName,
        createdBy: null,
        today,
        trialDays: config.TRIAL_DAYS,
        plan: plan ?? 'monthly',
      });
      console.log(`Registered ${slug} (${r.id}). Next: npm run petra -- provision ${slug}`);
      break;
    }
    case 'provision': {
      const e = await school(positional[0]);
      if (!flag('skip-acl')) await hardenOrFail(); // idempotent; provisioning's health check fails closed if cluster-level ACLs are missing
      const r = await provisionSchool(deps, e.id);
      console.log(`${e.slug}: ${r.step}`);
      if (r.adminInitialPassword)
        console.log(`First admin ${e.admin_email} initial password (shown ONCE, change it after first login): ${r.adminInitialPassword}`);
      break;
    }
    case 'migrate': {
      const list = flag('all')
        ? (await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE db_mode = 'dedicated' AND status IN ('active','suspended') ORDER BY slug`)).rows
        : [await school(positional[0])];
      for (const e of list as RegistryEntry[]) console.log(`${e.slug}: ${(await migrateSchool(deps, e.id)).join(', ') || 'up to date'}`);
      break;
    }
    case 'health': {
      const list = flag('all')
        ? (await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE db_mode = 'dedicated' AND status IN ('active','suspended') ORDER BY slug`)).rows
        : [await school(positional[0])];
      let bad = 0;
      for (const e of list as RegistryEntry[]) {
        const h = await checkSchoolHealth(deps, e);
        console.log(`${h.ok ? 'OK  ' : 'FAIL'} ${e.slug} schema=${h.schema_version ?? '-'}${h.ok ? '' : ' ' + JSON.stringify(h.checks.filter((c) => !c.ok))}`);
        if (!h.ok) bad++;
      }
      const acl = await checkDatabaseAcls(adminUrl, await aclSpec());
      console.log(
        `${acl.ok ? 'OK  ' : 'FAIL'} cluster-acl ${acl.findings.map((f) => `${f.database}:${f.public_connect ? 'PUBLIC-CONNECT' : 'closed'}`).join(' ')}${acl.ok ? '' : ' (run: npm run petra -- harden-db-access)'}`,
      );
      if (bad || !acl.ok) process.exitCode = 2;
      break;
    }
    case 'harden-db-access': {
      await hardenOrFail();
      const acl = await checkDatabaseAcls(adminUrl, await aclSpec());
      console.log(
        acl.ok
          ? 'PUBLIC CONNECT is revoked on every protected database.'
          : `STILL OPEN: ${acl.findings
              .filter((f) => !f.ok)
              .map((f) => f.database)
              .join(', ')}`,
      );
      if (!acl.ok) process.exitCode = 2;
      break;
    }
    case 'rotate-secret': {
      const e = await school(positional[0]);
      await rotateSchoolSecret(deps, e.id);
      console.log(
        `${e.slug}: database credential rotated. API instances pick it up within ${config.ENTITLEMENT_CACHE_SECONDS}s (pending-secret fallback covers the gap).`,
      );
      break;
    }
    case 'reencrypt-secrets':
      {
        const r = await reencryptAllSecrets(control, secrets);
        console.log(`Re-encrypted ${r.updated} school(s) with key "${secrets.currentKeyId}"; ${r.skipped} skipped (changed concurrently — run again).`);
        if (r.skipped) process.exitCode = 2;
      }
      break;
    case 'sweep': {
      const r = await sweepSubscriptions(control, today);
      console.log(`Checked ${r.checked}; ${r.changed.length} status change(s) recorded.`);
      break;
    }
    case 'export': {
      const e = await school(positional[0]);
      const r = await exportSchool(deps, e.id, path.resolve(positional[1] ?? die('usage: export <slug> <output-dir>')));
      console.log(`Wrote ${r.manifestPath}`);
      break;
    }
    case 'restore': {
      const [manifest, target] = positional;
      if (!manifest || !target) die('usage: restore <manifest.json> <new-database-name>');
      const r = await restoreDump(deps, path.resolve(manifest), target);
      console.log(
        r.ok
          ? `Restored into "${target}"; row counts and content digests match the manifest (signature: ${r.signature}).`
          : `Restore did NOT verify: mismatched tables ${r.mismatches.join(', ')}. Scratch database ${r.cleaned_up ? 'was dropped' : 'was kept'}.`,
      );
      if (!r.ok) process.exitCode = 2;
      break;
    }
    case 'offboard-start': {
      const e = await school(positional[0]);
      await startOffboarding(deps, e.id, null, positional.slice(1).join(' ') || die('usage: offboard-start <slug> <reason>'));
      console.log(`${e.slug}: now in offboarding (users locked out, data preserved).`);
      break;
    }
    case 'offboard-finalize': {
      const e = await school(positional[0]);
      const confirmIdx = rest.indexOf('--confirm');
      const r = await finalizeOffboarding(deps, e.id, {
        confirmSlug: confirmIdx >= 0 ? (rest[confirmIdx + 1] ?? '') : '',
        exportDir: path.resolve(positional[1] ?? die('usage: offboard-finalize <slug> <export-dir> --confirm <slug>')),
        today,
        actorId: null,
      });
      console.log(`${e.slug}: database deleted. Final export manifest: ${r.manifestPath}`);
      break;
    }
    case 'admin-reset': {
      const e = await school(positional[0]);
      const r = await resetSchoolAccountPassword(deps, e.id, positional[1] ?? die('usage: admin-reset <slug> <email>'));
      console.log(`New password for ${positional[1]} (shown ONCE): ${r.password}`);
      break;
    }
    case 'migrate-to-dedicated': {
      const e = await school(positional[0]);
      const r = await migrateSharedToDedicated(mdeps(), e.id, { resetTarget: flag('reset-target') });
      console.log(`${e.slug}: migrated. Tables verified: ${r.tables.length}, users: ${r.users}. Shared copy retained for rollback.`);
      break;
    }
    case 'migration-inspect': {
      const e = await school(positional[0]);
      console.log(JSON.stringify(await inspectMaintenance(mdeps(), e.id), null, 2));
      break;
    }
    case 'migration-recover': {
      const e = await school(positional[0]);
      const action = positional[1] as RecoveryAction | undefined;
      if (!action || !['reopen-shared', 'complete-cutover', 'reopen-dedicated'].includes(action))
        die('usage: migration-recover <slug> <reopen-shared|complete-cutover|reopen-dedicated>  (run migration-inspect first)');
      const r = await recoverMaintenance(mdeps(), e.id, action);
      console.log(`${e.slug}: ${action} done. ${r.reason}`);
      break;
    }
    case 'rollback-to-shared': {
      const e = await school(positional[0]);
      const r = await rollbackToShared(mdeps(), e.id, { acceptDataLoss: flag('accept-data-loss') });
      console.log(`${e.slug}: back on the shared database (${r.writes_since_cutover} write(s) discarded).`);
      break;
    }
    case 'import-platform-admins':
      console.log(`Imported ${(await importPlatformAdmins(control, sharedOwner())).imported} platform admin(s).`);
      break;
    case 'platform-admin-create': {
      const email = process.env.PLATFORM_ADMIN_EMAIL;
      const pw = process.env.PLATFORM_ADMIN_PASSWORD;
      if (!email || !pw || pw.length < PASSWORD_MIN_LENGTH)
        die(`PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (min ${PASSWORD_MIN_LENGTH} chars) are required`);
      await control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'Platform Administrator')`, [
        email,
        await hashPassword(pw!),
      ]);
      console.log(`Platform admin ${email} created.`);
      break;
    }
    case 'build-profile': {
      const [slug, api, out] = positional;
      const r = await writeBuildProfile(
        control,
        slug ?? die('usage: build-profile <slug> <https-api-base-url> [out-dir]'),
        path.resolve(out ?? 'builds'),
        api ?? die('api base url required'),
      );
      console.log(`Wrote ${r.files.join(', ')} to ${r.dir}. (Configuration only — no EXE/APK is built by this command.)`);
      break;
    }
    case 'seed-demo': {
      if (config.NODE_ENV === 'production') die('Refusing to seed demo data when NODE_ENV=production.');
      const password = process.env.DEV_SEED_PASSWORD;
      if (!password || password.length < 10) die('DEV_SEED_PASSWORD (min 10 chars) is required');
      const existing = (await control.query(`SELECT id FROM schools WHERE slug = 'demo-school'`)).rows[0];
      if (existing) {
        console.log('demo-school already exists; nothing to do.');
        break;
      }
      const { id } = await registerSchool(control, {
        slug: 'demo-school',
        name: 'Demo School',
        adminEmail: null,
        adminName: null,
        createdBy: null,
        today,
        trialDays: 365,
      });
      await provisionSchool(deps, id);
      const c = new pg.Client({ connectionString: urlForDb(adminUrl, `sk_${id.replace(/-/g, '').slice(0, 12)}`) });
      await c.connect();
      let s;
      try {
        s = await seedSchool(c as unknown as pg.PoolClient, { code: 'demo-school', name: 'Demo School', password: password!, existingSchoolId: id });
      } finally {
        await c.end();
      }
      console.log('Seeded demo-school (dedicated database). Log in with school slug "demo-school" and password = DEV_SEED_PASSWORD:');
      for (const [role, u] of Object.entries(s.users)) console.log(`  ${role.padEnd(10)} ${u.email}`);
      break;
    }
    default:
      die(`unknown command "${cmd}"`);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await control.end();
}
