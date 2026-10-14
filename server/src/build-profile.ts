import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';

/**
 * Writes NON-SECRET build configuration for a school-branded client from the control plane.
 * This prepares configuration only; it does not build or sign any EXE/Linux/APK artifact.
 */
export async function writeBuildProfile(control: Db, slug: string, outRoot: string, apiBaseUrl: string): Promise<{ dir: string; files: string[] }> {
  if (!/^https:\/\//.test(apiBaseUrl)) throw new Error('API base URL must be https://');
  const s = (
    await control.query(
      `SELECT s.id, s.slug, b.display_name, b.logo_url, b.primary_color, b.accent_color FROM schools s JOIN school_branding b ON b.school_id = s.id WHERE s.slug = $1`,
      [slug],
    )
  ).rows[0];
  if (!s) throw new Error('unknown school');
  const profiles = (await control.query(`SELECT platform, app_id, app_name FROM school_build_profiles WHERE school_id = $1`, [s.id])).rows as { platform: string; app_id: string; app_name: string }[];
  const rel = (await control.query(`SELECT version, min_supported_version FROM app_releases WHERE channel = 'stable' ORDER BY created_at DESC LIMIT 1`)).rows[0] ?? null;
  const dir = path.join(outRoot, s.slug);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (name: string, content: string) => {
    fs.writeFileSync(path.join(dir, name), content);
    files.push(name);
  };
  write('profile.json', JSON.stringify({ format: 1, slug: s.slug, display_name: s.display_name, logo_url: s.logo_url, primary_color: s.primary_color, accent_color: s.accent_color, api_base_url: apiBaseUrl, release: rel, platforms: profiles }, null, 2));
  write('web.env', `VITE_SCHOOL_SLUG=${s.slug}\nVITE_APP_NAME=${JSON.stringify(s.display_name)}\nVITE_API_BASE_URL=${apiBaseUrl}\n`);
  const android = profiles.find((p) => p.platform === 'android');
  if (android) write('capacitor.config.json', JSON.stringify({ appId: android.app_id, appName: android.app_name, webDir: '../../web/dist', server: { androidScheme: 'https' } }, null, 2));
  for (const p of profiles.filter((x) => x.platform !== 'android')) write(`tauri.${p.platform}.conf.json`, JSON.stringify({ productName: p.app_name, identifier: p.app_id }, null, 2));
  return { dir, files };
}
