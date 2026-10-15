import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { validateTestEnvironment } from '../server/test/safety.js';

// Same disposable-cluster guard as the server tests and the browser E2E.
const envFile = path.resolve(import.meta.dirname, '../.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
validateTestEnvironment(process.env);

export default defineConfig({
  testDir: 'desktop-tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  webServer: {
    // Only the API: the desktop app serves the web UI itself. start-api.mjs gives it an explicit minimal environment.
    command: 'node start-api.mjs',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
