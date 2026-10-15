/**
 * Prepares the DISPOSABLE test cluster for the browser smoke test: validates the destructive-test guard (server/test/safety.ts),
 * recreates the test control-plane database, provisions one school on its own database and puts its subscription 3 days past the
 * end date (grace period). Writes the non-production credentials to e2e/.state/school.json (mode 0600). Never prints them.
 * Refuses to run unless PETRA_TEST_CLUSTER=disposable, the cluster marker matches and every URL is loopback/test-named.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPool } from '../server/src/db.js';
import { addDays, todayIn } from '../server/src/entitlements.js';
import { provisionSchool } from '../server/src/provisioning.js';
import { registerSchool } from '../server/src/registry.js';
import { SecretBox, loadMasterKeys } from '../server/src/secrets.js';
import { runSetup } from '../server/test/global-setup.js';
import { validateTestEnvironment } from '../server/test/safety.js';

const env = process.env;
if (!env.PETRA_MASTER_KEY) throw new Error('PETRA_MASTER_KEY is required (a throw-away test key; the API server started by Playwright must use the same one)');
validateTestEnvironment(env); // throws before anything touches a database
await runSetup(env); // re-verifies the cluster marker, then recreates the TEST databases only

const control = createPool(env.TEST_CONTROL_DATABASE_URL!);
try {
  const secrets = new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: env.PETRA_MASTER_KEY, PETRA_MASTER_KEY_ID: env.PETRA_MASTER_KEY_ID ?? 'k1' }));
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const today = todayIn('Asia/Dhaka');
  const email = `admin@${slug}.example.test`;
  const { id } = await registerSchool(control, {
    slug,
    name: `E2E School ${slug}`,
    adminEmail: email,
    adminName: 'E2E Admin',
    createdBy: null,
    today,
    trialDays: 30,
  });
  const r = await provisionSchool({ control, secrets, adminUrl: env.TEST_PROVISIONER_DATABASE_URL! }, id);
  if (!r.adminInitialPassword) throw new Error('provisioning did not return the initial admin password');
  // 3 days after the paid period: grace (full access + renewal warning).
  await control.query(`UPDATE subscriptions SET status = 'active', period_start = $2, period_end = $3 WHERE school_id = $1`, [
    id,
    addDays(today, -33),
    addDays(today, -3),
  ]);

  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${r.adminInitialPassword}`); // keep Playwright call logs from ever echoing it
  const dir = path.resolve(import.meta.dirname, '.state');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'school.json'), JSON.stringify({ slug, email, password: r.adminInitialPassword }), { mode: 0o600 });
  console.log(`e2e school "${slug}" prepared on the disposable cluster (credentials written to e2e/.state/school.json)`);
} finally {
  await control.end();
}
