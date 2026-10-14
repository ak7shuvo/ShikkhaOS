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
import { exportSchool, finalizeOffboarding, resetSchoolAccountPassword, restoreDump, startOffboarding } from '../operations.js';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../passwords.js';
import { checkSchoolHealth, migrateSchool, provisionSchool, reencryptAllSecrets, rotateSchoolSecret, urlForDb, type ProvisionDeps } from '../provisioning.js';
import { registerSchool } from '../registry.js';
import { SecretBox, generateMasterKey, loadMasterKeys } from '../secrets.js';
import { seedSchool } from '../seed-data.js';
import { importPlatformAdmins, migrateSharedToDedicated, rollbackToShared, type MigrationDeps } from '../shared-migration.js';
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
    'commands: register provision migrate health rotate-secret reencrypt-secrets sweep export restore offboard-start offboard-finalize admin-reset migrate-to-dedicated rollback-to-shared import-platform-admins platform-admin-create build-profile seed-demo generate-master-key',
  );

const config = loadConfig();
const control = createPool(config.CONTROL_DATABASE_URL);
const adminUrl = process.env.PROVISIONER_DATABASE_URL ?? die('PROVISIONER_DATABASE_URL is required');
const secrets = new SecretBox(loadMasterKeys(config));
const deps: ProvisionDeps = { control, secrets, adminUrl };
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
      if (bad) process.exitCode = 2;
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
      console.log(`Re-encrypted ${(await reencryptAllSecrets(control, secrets)).updated} credential(s) with key "${secrets.currentKeyId}".`);
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
      console.log(r.ok ? `Restored into "${target}" and verified against the manifest.` : `Restored but MISMATCHED tables: ${r.mismatches.join(', ')}`);
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
