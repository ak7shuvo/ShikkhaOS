#!/usr/bin/env node
// Builds the desktop shell around the UNCHANGED web UI for ONE school-branded profile (or a generic build).
//
//   node scripts/build.mjs prepare [--profile <dir>] [--platform linux] [--api <https://api-origin>] [--allow-insecure-loopback]
//   node scripts/build.mjs package [--profile <dir>] [--platform linux] ...same options... [--dir]
//
// <dir> is the output of `npm run petra -- build-profile <slug> <api-url> <out>` (profile.json, non-secret). Nothing secret is read or
// written: the app authenticates through the normal login API. `package` runs `prepare` first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');

const argv = process.argv.slice(2);
const command = argv.shift();
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const die = (msg) => {
  console.error(`build: ${msg}`);
  process.exit(1);
};

if (!['prepare', 'package'].includes(command ?? ''))
  die('usage: build.mjs <prepare|package> [--profile dir] [--platform linux] [--api https://origin] [--allow-insecure-loopback]');
const platform = opt('platform') ?? 'linux';
if (platform !== 'linux') die(`platform "${platform}" is not supported yet (Windows and Android are on the roadmap, see docs/DESKTOP.md)`);

// 1. Compile the TypeScript main process (also gives us the validator used at run time).
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) die(`${cmd} ${args.slice(0, 2).join(' ')} failed`);
};
run('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: root });
const { parseAppConfig } = await import(path.join(root, 'dist', 'app-config.js'));

// 2. Resolve the school configuration from the build-profile output (or a generic build).
let cfg;
let identity; // { productName, appId, artifactBase }
const profileDir = opt('profile');
if (profileDir) {
  const profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf8'));
  if (profile.format !== 1) die('unsupported profile.json format');
  const entry = (profile.platforms ?? []).find((p) => p.platform === platform);
  if (!entry) die(`profile has no "${platform}" build profile (app_id/app_name); register one with the platform API first`);
  cfg = {
    format: 1,
    slug: profile.slug,
    display_name: profile.display_name,
    api_base_url: opt('api') ?? profile.api_base_url,
    allow_insecure_loopback: flag('allow-insecure-loopback'),
  };
  identity = { productName: entry.app_name, appId: entry.app_id, artifactBase: `shikkhaos-${profile.slug}` };
} else {
  const api = opt('api') ?? process.env.DESKTOP_API_BASE_URL;
  if (!api) die('generic build needs --api <origin> (or DESKTOP_API_BASE_URL), or pass --profile <dir>');
  cfg = { format: 1, slug: null, display_name: 'ShikkhaOS', api_base_url: api, allow_insecure_loopback: flag('allow-insecure-loopback') };
  identity = { productName: 'ShikkhaOS', appId: 'com.petra.shikkhaos.desktop', artifactBase: 'shikkhaos-desktop' };
}
const config = parseAppConfig(cfg); // https only; plain http solely for explicit loopback TEST builds
if (config.allow_insecure_loopback && !flag('allow-insecure-loopback')) die('insecure loopback must be requested explicitly');
if (config.allow_insecure_loopback && command === 'package' && process.env.SHIKKHAOS_RELEASE === '1') die('release builds must not allow insecure loopback');

// 3. Build the SAME web UI. API calls stay relative (/api/...); the desktop main process forwards them. No VITE_API_BASE_URL.
const webOut = path.join(root, 'build', 'web');
fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const viteEnv = { ...process.env };
delete viteEnv.VITE_API_BASE_URL;
if (config.slug) viteEnv.VITE_SCHOOL_SLUG = config.slug;
else delete viteEnv.VITE_SCHOOL_SLUG;
viteEnv.VITE_APP_NAME = config.display_name;
run('npx', ['vite', 'build', '--outDir', webOut, '--emptyOutDir'], { cwd: path.join(repo, 'web'), env: viteEnv });
fs.writeFileSync(path.join(root, 'build', 'app-config.json'), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(root, 'build', 'identity.json'), JSON.stringify(identity, null, 2));
console.log(`prepared "${identity.productName}" (${config.slug ?? 'generic'}) -> ${path.relative(repo, path.join(root, 'build'))}`);

if (command === 'prepare') process.exit(0);

// 4. Package (Linux: AppImage + tar.gz; --dir builds only the unpacked app for quick verification).
const { build, Platform } = await import('electron-builder');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const result = await build({
  projectDir: root,
  targets: Platform.LINUX.createTarget(flag('dir') ? ['dir'] : ['AppImage', 'tar.gz']),
  config: {
    publish: null, // no update feed yet (see docs/DESKTOP.md roadmap): nothing is published or advertised
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.artifactBase,
    artifactName: `${identity.artifactBase}-${pkg.version}-linux-\${arch}.\${ext}`,
    directories: { output: path.join(root, 'release'), buildResources: path.join(root, 'resources') },
    files: ['dist/**', 'build/**', 'preload.cjs', 'package.json'],
    asar: true,
    npmRebuild: false,
    linux: {
      category: 'Education',
      synopsis: 'School management',
      description: `${identity.productName} desktop client`,
      maintainer: 'Petra Software Solution',
    },
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      enableCookieEncryption: true,
    },
  },
});
for (const f of result) console.log(`artifact: ${path.relative(repo, f)}`);
