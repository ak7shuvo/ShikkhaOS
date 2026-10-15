// Starts the API for the browser smoke test with an EXPLICIT, minimal environment. Nothing is inherited from the caller except
// PATH/HOME, so a developer's CONTROL_DATABASE_URL / SHARED_DATABASE_URL / PROVISIONER_DATABASE_URL (e.g. from the repository .env)
// can never reach this process. It only receives the TEST control-plane URL, which Playwright's config has already validated.
import { spawn } from 'node:child_process';
import path from 'node:path';

const need = (k) => process.env[k] || (console.error(`${k} is required`), process.exit(1));
const origin = 'http://127.0.0.1:5173';
const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  CONTROL_DATABASE_URL: need('TEST_CONTROL_DATABASE_URL'),
  PETRA_MASTER_KEY: need('PETRA_MASTER_KEY'),
  PETRA_MASTER_KEY_ID: process.env.PETRA_MASTER_KEY_ID ?? 'k1',
  ALLOWED_ORIGINS: origin,
  ENTITLEMENT_CACHE_SECONDS: '0',
  LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
};
const entry = path.resolve(import.meta.dirname, '../server/src/index.ts');
const child = spawn(process.execPath, ['--import', 'tsx', entry], { env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
