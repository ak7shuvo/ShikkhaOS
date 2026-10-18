#!/usr/bin/env node
// Writes a build-profile-shaped profile.json (non-secret) for the DISPOSABLE e2e school created by e2e/prepare.ts, so the desktop
// smoke test exercises the same profile -> branded build path as a real school. Usage: test-profile.mjs <out-dir> <api-origin>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [out, api] = process.argv.slice(2);
if (!out || !api) {
  console.error('usage: test-profile.mjs <out-dir> <api-origin>');
  process.exit(1);
}
const state = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e/.state/school.json');
const { slug } = JSON.parse(fs.readFileSync(state, 'utf8')); // only the slug is used; the password is never read into the profile
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, 'profile.json'),
  JSON.stringify(
    {
      format: 1,
      slug,
      display_name: `E2E School ${slug}`,
      logo_url: null,
      primary_color: '#0b6b4f',
      accent_color: null,
      api_base_url: api,
      release: null,
      platforms: [{ platform: 'linux', app_id: 'org.example.e2e.desktop', app_name: `E2E School ${slug}` }],
    },
    null,
    2,
  ),
);
console.log(`test profile for ${slug} written to ${out}`);
