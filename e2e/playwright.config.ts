import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { validateTestEnvironment } from '../server/test/safety.js';

// Local runs read the repository .env (never overrides variables that are already set, e.g. in CI).
const envFile = path.resolve(import.meta.dirname, '../.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// The same guard as the server integration tests: refuses to run unless the configured databases belong to a verified disposable cluster.
validateTestEnvironment(process.env);

const API_PORT = 3000;
const WEB_PORT = 5173;
const origin = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: origin, locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // start-api.mjs builds an explicit minimal environment (only the TEST control-plane URL) and never reuses a running server.
      command: 'node start-api.mjs',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: '../web',
      url: origin,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
