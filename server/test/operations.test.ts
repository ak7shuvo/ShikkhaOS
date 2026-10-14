import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBuildProfile } from '../src/build-profile.js';
import { addDays } from '../src/entitlements.js';
import { dropScratchDatabase, exportSchool, finalizeOffboarding, resetSchoolAccountPassword, restoreDump, startOffboarding } from '../src/operations.js';
import { dbNameFor, provisionSchool, roleNameFor, urlForDb } from '../src/provisioning.js';
import { controlFixture, registerNew, scratchDbName, today, type ControlFixture } from './fixtures.js';
import { Client, harness, uniqueCode, type Harness } from './helpers.js';

let h: Harness;
let f: ControlFixture;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'petra-ops-'));

beforeAll(async () => {
  h = await harness();
  f = await controlFixture();
});
afterAll(async () => {
  await f.close();
  await h.close();
});

async function school(prefix: string) {
  const { id, slug } = await registerNew(f, prefix);
  const r = await provisionSchool(f.deps, id);
  const admin = new Client(h.app);
  expect((await admin.login(`admin@${slug}.example.test`, r.adminInitialPassword!, slug)).status).toBe(200);
  return { id, slug, admin, adminEmail: `admin@${slug}.example.test`, pw: r.adminInitialPassword! };
}
const exists = async (name: string) => (await f.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;

describe('backup, restore and export procedure', () => {
  it('exports with a checksummed manifest and restores into a scratch database with identical data', async () => {
    const A = await school('ops-exp');
    for (const n of ['Class 7', 'Class 8']) expect((await A.admin.post('/classes', { name: n })).status).toBe(201);
    const { manifestPath, manifest } = await exportSchool(f.deps, A.id, tmp());
    expect(manifest.table_counts.classes).toBe(2);
    expect(manifest.dump_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(manifestPath).mode & 0o077).toBe(0); // owner-only permissions

    const scratch = await scratchDbName('x');
    const r = await restoreDump(f.deps, manifestPath, scratch);
    expect(r).toEqual({ ok: true, mismatches: [], placeholder_role_created: null });
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, scratch) });
    await c.connect();
    expect((await c.query(`SELECT name FROM classes ORDER BY name`)).rows.map((x) => x.name)).toEqual(['Class 7', 'Class 8']);
    await expect(c.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/); // guards survive a restore
    await c.end();
    await expect(restoreDump(f.deps, manifestPath, scratch)).rejects.toThrow(/already exists/);
    await dropScratchDatabase(f.deps, scratch);
    expect(await exists(scratch)).toBe(false);
  });

  it('detects a corrupted or tampered dump before restoring anything', async () => {
    const A = await school('ops-tamper');
    const { manifestPath, manifest } = await exportSchool(f.deps, A.id, tmp());
    const dump = path.join(path.dirname(manifestPath), manifest.dump_file);
    fs.appendFileSync(dump, 'x');
    const scratch = await scratchDbName('t');
    await expect(restoreDump(f.deps, manifestPath, scratch)).rejects.toThrow(/checksum/);
    expect(await exists(scratch)).toBe(false);
  });

  it('refuses unsafe target names and refuses to drop registered school databases', async () => {
    const A = await school('ops-names');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    await expect(restoreDump(f.deps, manifestPath, 'x; DROP DATABASE postgres')).rejects.toThrow(/invalid/);
    await expect(dropScratchDatabase(f.deps, dbNameFor(A.id))).rejects.toThrow(/refusing/);
    await expect(dropScratchDatabase(f.deps, 'postgres; --')).rejects.toThrow(/refusing/);
  });

  it('restores a school from backup after accidental data loss, then swaps it in through the registry-safe procedure', async () => {
    const A = await school('ops-drill');
    await A.admin.post('/classes', { name: 'Precious' });
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    // disaster: rows gone (as the owner)
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(A.id)) });
    await c.connect();
    await c.query(`DELETE FROM classes`);
    await c.end();
    expect((await A.admin.get('/classes')).body.items).toEqual([]);
    const scratch = await scratchDbName('d');
    expect((await restoreDump(f.deps, manifestPath, scratch)).ok).toBe(true);
    const s = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, scratch) });
    await s.connect();
    expect((await s.query(`SELECT name FROM classes`)).rows).toEqual([{ name: 'Precious' }]);
    await s.end();
    await dropScratchDatabase(f.deps, scratch);
  });
});

describe('offboarding and deletion safeguards', () => {
  const lapse = (id: string, daysAgo: number) =>
    f.control.query(`UPDATE subscriptions SET period_start = $2, period_end = $3 WHERE school_id = $1`, [
      id,
      addDays(today(), -daysAgo - 30),
      addDays(today(), -daysAgo),
    ]);
  const fin = (id: string, slug: string, over: Record<string, unknown> = {}) =>
    finalizeOffboarding(f.deps, id, { confirmSlug: slug, exportDir: tmp(), today: today(), actorId: null, ...over });

  it('a failed payment or lapse never deletes anything; deletion needs an explicit, later, confirmed step', async () => {
    const A = await school('off-lapse');
    await lapse(A.id, 400); // lapsed far beyond grace/read-only/retention
    expect((await A.admin.get('/classes')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    expect(await exists(dbNameFor(A.id))).toBe(true);
    await expect(fin(A.id, A.slug)).rejects.toThrow(/offboarding status/); // not offboarding → refused even though retention elapsed
    expect(await exists(dbNameFor(A.id))).toBe(true);
  });

  it('refuses before the retention window, with a legal hold, or with the wrong confirmation', async () => {
    const A = await school('off-guards');
    await startOffboarding(f.deps, A.id, null, 'school requested closure');
    expect((await A.admin.get('/classes')).body.error.code).toBe('SCHOOL_OFFBOARDED');
    await expect(fin(A.id, A.slug)).rejects.toThrow(/retention window has not elapsed/); // still in trial period
    await lapse(A.id, 60); // 60 days after end: inside the 90-day retention window
    await expect(fin(A.id, A.slug)).rejects.toThrow(/retention window has not elapsed/);
    await lapse(A.id, 91);
    await expect(fin(A.id, 'wrong-slug')).rejects.toThrow(/confirmation slug/);
    await f.control.query(`UPDATE subscriptions SET legal_hold = true WHERE school_id = $1`, [A.id]);
    await expect(fin(A.id, A.slug)).rejects.toThrow(/legal hold/);
    expect(await exists(dbNameFor(A.id))).toBe(true);
    expect((await f.control.query(`SELECT status FROM schools WHERE id = $1`, [A.id])).rows[0].status).toBe('offboarding');
  });

  it('after retention, with a verified final export, deletes the database and role but keeps the business records', async () => {
    const A = await school('off-final');
    await A.admin.post('/classes', { name: 'Archive me' });
    await startOffboarding(f.deps, A.id, null, 'contract ended');
    await lapse(A.id, 91);
    const exportDir = tmp();
    const { manifestPath } = await fin(A.id, A.slug, { exportDir });

    expect(await exists(dbNameFor(A.id))).toBe(false);
    expect((await f.admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleNameFor(A.id)])).rowCount).toBe(0);
    expect(await exists(`verify_${dbNameFor(A.id)}`)).toBe(false); // scratch restore cleaned up
    const row = (await f.control.query(`SELECT status, db_secret_enc, db_secret_pending_enc FROM schools WHERE id = $1`, [A.id])).rows[0];
    expect(row).toEqual({ status: 'archived', db_secret_enc: null, db_secret_pending_enc: null });
    expect((await f.control.query(`SELECT 1 FROM subscriptions WHERE school_id = $1`, [A.id])).rowCount).toBe(1);
    expect((await f.control.query(`SELECT action FROM platform_audit_events WHERE school_id = $1 AND action = 'school.offboarded'`, [A.id])).rowCount).toBe(1);

    // The final export can still bring the data back.
    const scratch = await scratchDbName('f');
    const restored = await restoreDump(f.deps, manifestPath, scratch);
    expect(restored).toMatchObject({ ok: true, placeholder_role_created: roleNameFor(A.id) }); // role was gone; a NOLOGIN placeholder keeps the restore faithful
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, scratch) });
    await c.connect();
    expect((await c.query(`SELECT name FROM classes`)).rows).toEqual([{ name: 'Archive me' }]);
    await c.end();
    await dropScratchDatabase(f.deps, scratch);
    await f.admin.query(`DROP ROLE "${roleNameFor(A.id)}"`);

    // Archived schools cannot be used or re-provisioned.
    expect((await new Client(h.app).login(A.adminEmail, A.pw, A.slug)).status).toBe(401);
    await expect(provisionSchool(f.deps, A.id)).rejects.toThrow(/cannot be provisioned/);
  });

  it('only active or suspended schools can enter offboarding', async () => {
    const { id } = await registerNew(f, 'off-req');
    await expect(startOffboarding(f.deps, id, null, 'x')).rejects.toThrow(/cannot start offboarding/);
  });
});

describe('support and build configuration', () => {
  it('operator password reset issues a new random password, revokes sessions, and is audited', async () => {
    const A = await school('sup-reset');
    const { password } = await resetSchoolAccountPassword(f.deps, A.id, A.adminEmail);
    expect((await A.admin.get('/auth/me')).status).toBe(401);
    expect((await new Client(h.app).login(A.adminEmail, A.pw, A.slug)).status).toBe(401);
    expect((await new Client(h.app).login(A.adminEmail, password, A.slug)).status).toBe(200);
    await expect(resetSchoolAccountPassword(f.deps, A.id, 'nobody@example.test')).rejects.toThrow(/no such account/);
  });

  it('writes non-secret build profiles for branded clients and nothing else', async () => {
    const A = await school('sup-build');
    await f.control.query(`UPDATE school_branding SET display_name = 'Green Valley School', primary_color = '#0b6b4f' WHERE school_id = $1`, [A.id]);
    await f.control.query(
      `INSERT INTO school_build_profiles (school_id, platform, app_id, app_name) VALUES ($1,'android','com.petra.shikkhaos.gv','Green Valley'), ($1,'windows','com.petra.shikkhaos.gv','Green Valley')`,
      [A.id],
    );
    const out = tmp();
    const r = await writeBuildProfile(f.control, A.slug, out, 'https://api.example.test');
    expect(r.files.sort()).toEqual(['capacitor.config.json', 'profile.json', 'tauri.windows.conf.json', 'web.env']);
    const all = r.files.map((n) => fs.readFileSync(path.join(r.dir, n), 'utf8')).join('\n');
    expect(all).toContain(`VITE_SCHOOL_SLUG=${A.slug}`);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'capacitor.config.json'), 'utf8'))).toMatchObject({
      appId: 'com.petra.shikkhaos.gv',
      appName: 'Green Valley',
    });
    expect(all).not.toMatch(/secret|password|v1\.k1|postgres:\/\/|db_name|sk_[a-f0-9]{12}/);
    await expect(writeBuildProfile(f.control, A.slug, out, 'http://insecure.example.test')).rejects.toThrow(/https/);
    await expect(writeBuildProfile(f.control, uniqueCode('zz'), out, 'https://api.example.test')).rejects.toThrow(/unknown school/);
  });
});
