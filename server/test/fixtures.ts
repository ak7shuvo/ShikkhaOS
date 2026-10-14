import pg from 'pg';
import { createPool, type Db } from '../src/db.js';
import { provisionSchool, type ProvisionDeps, type ProvisionResult } from '../src/provisioning.js';
import { registerSchool } from '../src/registry.js';
import { SecretBox, loadMasterKeys } from '../src/secrets.js';
import { loadConfig } from '../src/config.js';
import { todayIn } from '../src/entitlements.js';
import { uniqueCode } from './helpers.js';
import { MARKER_DB, urlWithDb } from './safety.js';

export function masterKeyEnv() {
  return { PETRA_MASTER_KEY: process.env.PETRA_MASTER_KEY!, PETRA_MASTER_KEY_ID: 'k1' };
}
export const testSecretBox = () => new SecretBox(loadMasterKeys(masterKeyEnv()));
export const adminUrl = () => process.env.TEST_PROVISIONER_DATABASE_URL!;
export const today = () =>
  todayIn(loadConfig({ NODE_ENV: 'test', CONTROL_DATABASE_URL: 'postgres://x:y@h/d', ...masterKeyEnv() } as NodeJS.ProcessEnv).BILLING_TIMEZONE);

export interface ControlFixture {
  control: Db;
  deps: ProvisionDeps;
  admin: pg.Client;
  close(): Promise<void>;
}

export async function controlFixture(over: Partial<ProvisionDeps> = {}): Promise<ControlFixture> {
  const control = createPool(process.env.TEST_CONTROL_DATABASE_URL!);
  const deps: ProvisionDeps = { control, secrets: testSecretBox(), adminUrl: adminUrl(), ...over };
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  return {
    control,
    deps,
    admin,
    close: async () => {
      await admin.end();
      await control.end();
    },
  };
}

export async function registerNew(f: ControlFixture, prefix: string, extra: Partial<{ adminEmail: string }> = {}) {
  const slug = uniqueCode(prefix).toLowerCase();
  const { id } = await registerSchool(f.control, {
    slug,
    name: `School ${slug}`,
    adminEmail: extra.adminEmail ?? `admin@${slug}.example.test`,
    adminName: 'Admin',
    createdBy: null,
    today: today(),
    trialDays: 30,
  });
  return { id, slug };
}

export async function provisionNew(f: ControlFixture, prefix: string): Promise<{ id: string; slug: string; result: ProvisionResult }> {
  const r = await registerNew(f, prefix);
  return { ...r, result: await provisionSchool(f.deps, r.id) };
}

/**
 * Scratch (restore-drill) database names are test-only and recorded in the marker ledger so that the guarded
 * global setup can positively attribute — and later clean up — exactly these databases.
 */
export async function scratchDbName(tag: string): Promise<string> {
  if (!/^[a-z0-9]{1,8}$/.test(tag)) throw new Error('invalid scratch tag');
  const name = `petra_test_scratch_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const c = new pg.Client({ connectionString: urlWithDb(adminUrl(), MARKER_DB) });
  await c.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS created_objects (kind text NOT NULL, name text PRIMARY KEY)');
    await c.query(`INSERT INTO created_objects (kind, name) VALUES ('database', $1)`, [name]);
  } finally {
    await c.end();
  }
  return name;
}
