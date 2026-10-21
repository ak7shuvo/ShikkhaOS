import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/entitlements.js';
import { exportSchool, finalizeOffboarding, restoreDump, startOffboarding, type ExportManifest } from '../src/operations.js';
import { dbNameFor, provisionSchool, roleNameFor, urlForDb, type ProvisionDeps } from '../src/provisioning.js';
import { controlFixture, registerNew, scratchDbName, today, type ControlFixture } from './fixtures.js';
import { acceptInitialPassword, Client, harness, type Harness } from './helpers.js';

let h: Harness;
let f: ControlFixture;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'petra-bk-'));
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const signed = (): ProvisionDeps => ({ ...f.deps, backupSigningKey: KEY });

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
  await acceptInitialPassword(admin, r.adminInitialPassword!);
  return { id, slug, admin };
}
const exists = async (name: string) => (await f.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;
const roleExists = async (name: string) => (await f.admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount === 1;
const readManifest = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as ExportManifest;
const writeManifest = (p: string, m: unknown) => fs.writeFileSync(p, JSON.stringify(m, null, 2));
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dumpOf = (manifestPath: string) => path.join(path.dirname(manifestPath), readManifest(manifestPath).dump_file);
const drop = (name: string) => f.admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);

describe('restore verification: row counts AND content digests', () => {
  it('records a content digest for every table, and a digest mismatch with equal row counts fails, cleans up and is retryable', async () => {
    const A = await school('bk-dig');
    await A.admin.post('/classes', { name: 'Original' });
    const { manifestPath, manifest } = await exportSchool(f.deps, A.id, tmp());
    expect(Object.keys(manifest.table_digests)).toEqual(Object.keys(manifest.table_counts));
    expect(manifest.table_digests.classes).toMatch(/^[a-f0-9]{32}$/);

    const good = readManifest(manifestPath);
    const bad = { ...good, table_digests: { ...good.table_digests, classes: 'f'.repeat(32) } }; // counts untouched: only the content differs
    writeManifest(manifestPath, bad);
    const scratch = await scratchDbName('dg');
    const r = await restoreDump(f.deps, manifestPath, scratch);
    expect(r).toMatchObject({ ok: false, mismatches: ['classes'], cleaned_up: true });
    expect(await exists(scratch)).toBe(false);

    writeManifest(manifestPath, good); // retry with the same name works
    expect(await restoreDump(f.deps, manifestPath, scratch)).toMatchObject({ ok: true, cleaned_up: false });
    await drop(scratch);
  });

  it('flags tables that are missing from, or unexpected in, the manifest', async () => {
    const A = await school('bk-tbl');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const good = readManifest(manifestPath);
    const { classes: _c, ...counts } = good.table_counts;
    const { classes: _d, ...digests } = good.table_digests;
    writeManifest(manifestPath, { ...good, table_counts: counts, table_digests: digests }); // 'classes' is now unexpected
    const s1 = await scratchDbName('tb');
    expect(await restoreDump(f.deps, manifestPath, s1)).toMatchObject({ ok: false, mismatches: ['classes'], cleaned_up: true });
    writeManifest(manifestPath, {
      ...good,
      table_counts: { ...good.table_counts, ghost_table: 0 },
      table_digests: { ...good.table_digests, ghost_table: '' },
    }); // a table the manifest promises but the dump lacks
    const s2 = await scratchDbName('tb');
    expect(await restoreDump(f.deps, manifestPath, s2)).toMatchObject({ ok: false, mismatches: ['ghost_table'], cleaned_up: true });
    expect(await exists(s1)).toBe(false);
    expect(await exists(s2)).toBe(false);
  });

  it('rejects a legacy/incomplete manifest', async () => {
    const A = await school('bk-old');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const { table_digests: _t, ...old } = readManifest(manifestPath);
    writeManifest(manifestPath, { ...old, format: 1 });
    await expect(restoreDump(f.deps, manifestPath, await scratchDbName('ol'))).rejects.toThrow(/unsupported or incomplete manifest/);
  });
});

describe('failed restores clean up exactly what they created', () => {
  it('truncated dump with a re-computed checksum (partial restore): pg_restore fails, scratch dropped, retry works; unrelated DBs untouched', async () => {
    const A = await school('bk-part');
    await A.admin.post('/classes', { name: 'X' });
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const dump = dumpOf(manifestPath);
    const original = fs.readFileSync(dump);
    const good = readManifest(manifestPath);

    // an unrelated database that must survive everything below
    const bystander = await scratchDbName('by');
    await f.admin.query(`CREATE DATABASE "${bystander}"`);
    const bc = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, bystander) });
    await bc.connect();
    await bc.query(`CREATE TABLE keepme (v int); INSERT INTO keepme VALUES (42)`);

    fs.writeFileSync(dump, original.subarray(0, Math.floor(original.length / 2)));
    writeManifest(manifestPath, { ...good, dump_sha256: sha(dump) }); // attacker/corruption keeps the manifest consistent
    const scratch = await scratchDbName('pt');
    await expect(restoreDump(f.deps, manifestPath, scratch)).rejects.toThrow();
    expect(await exists(scratch)).toBe(false);
    expect(await exists(dbNameFor(A.id))).toBe(true); // the live school is untouched
    expect((await bc.query('SELECT v FROM keepme')).rows).toEqual([{ v: 42 }]);

    fs.writeFileSync(dump, original);
    writeManifest(manifestPath, good);
    expect((await restoreDump(f.deps, manifestPath, scratch)).ok).toBe(true);
    await drop(scratch);
    await bc.end();
    await drop(bystander);
  });

  it('a corrupted dump is refused before any database is created', async () => {
    const A = await school('bk-cor');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const dump = dumpOf(manifestPath);
    const buf = fs.readFileSync(dump);
    buf[Math.floor(buf.length / 2)] = (buf[Math.floor(buf.length / 2)] ?? 0) ^ 0xff;
    fs.writeFileSync(dump, buf);
    const scratch = await scratchDbName('co');
    await expect(restoreDump(f.deps, manifestPath, scratch)).rejects.toThrow(/checksum/);
    expect(await exists(scratch)).toBe(false);
  });

  it('never touches a pre-existing database of the same name', async () => {
    const A = await school('bk-pre');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const existing = await scratchDbName('pe');
    await f.admin.query(`CREATE DATABASE "${existing}"`);
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, existing) });
    await c.connect();
    await c.query(`CREATE TABLE precious (v int); INSERT INTO precious VALUES (1)`);
    await expect(restoreDump(f.deps, manifestPath, existing)).rejects.toThrow(/already exists/);
    expect(await exists(existing)).toBe(true);
    expect((await c.query('SELECT v FROM precious')).rows).toEqual([{ v: 1 }]);
    await c.end();
    await drop(existing);
  });

  it('a failed verification removes the NOLOGIN placeholder role it created, but never a real one', async () => {
    const A = await school('bk-role');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const role = roleNameFor(A.id);
    const good = readManifest(manifestPath);
    writeManifest(manifestPath, { ...good, table_digests: { ...good.table_digests, classes: 'a'.repeat(32) } });

    // school role exists (live school) → no placeholder is created and the real role survives a failed restore
    const s1 = await scratchDbName('r1');
    expect(await restoreDump(f.deps, manifestPath, s1)).toMatchObject({ ok: false, placeholder_role_created: null });
    expect(await roleExists(role)).toBe(true);

    // role gone (after offboarding) → placeholder is created for the restore and removed again on failure
    const dbName = dbNameFor(A.id);
    await drop(dbName);
    await f.admin.query(`DROP ROLE "${role}"`);
    const s2 = await scratchDbName('r2');
    expect(await restoreDump(f.deps, manifestPath, s2)).toMatchObject({ ok: false, cleaned_up: true, placeholder_role_created: null });
    expect(await roleExists(role)).toBe(false);
    expect(await exists(s2)).toBe(false);
  });

  it('keepOnFailure keeps the scratch database for forensics', async () => {
    const A = await school('bk-keep');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const good = readManifest(manifestPath);
    writeManifest(manifestPath, { ...good, table_digests: { ...good.table_digests, classes: 'b'.repeat(32) } });
    const scratch = await scratchDbName('kp');
    expect(await restoreDump(f.deps, manifestPath, scratch, { keepOnFailure: true })).toMatchObject({ ok: false, cleaned_up: false });
    expect(await exists(scratch)).toBe(true);
    await drop(scratch);
  });
});

describe('manifest signing (HMAC-SHA256, key kept separate from the backups)', () => {
  it('signs when a key is configured; the signature verifies with that key only', async () => {
    const A = await school('bk-sig');
    const { manifestPath, manifest } = await exportSchool(signed(), A.id, tmp());
    expect(manifest.signature?.alg).toBe('hmac-sha256');
    const s1 = await scratchDbName('s1');
    expect(await restoreDump(signed(), manifestPath, s1)).toMatchObject({ ok: true, signature: 'verified' });
    await drop(s1);
    await expect(restoreDump({ ...f.deps, backupSigningKey: OTHER_KEY }, manifestPath, await scratchDbName('s2'))).rejects.toThrow(/signature is invalid/);
    await expect(restoreDump(f.deps, manifestPath, await scratchDbName('s3'))).rejects.toThrow(/signed but no backup signing key/);
  });

  it('a tampered manifest (any field) or a stripped signature is refused when a key is configured', async () => {
    const A = await school('bk-sg2');
    const { manifestPath } = await exportSchool(signed(), A.id, tmp());
    const good = readManifest(manifestPath);
    const cases: Record<string, unknown> = {
      'changed slug': { ...good, slug: 'someone-else' },
      'changed digest': { ...good, table_digests: { ...good.table_digests, classes: 'c'.repeat(32) } },
      'changed dump checksum': { ...good, dump_sha256: 'd'.repeat(64) },
      'stripped signature': (({ signature: _s, ...rest }) => rest)(good),
    };
    for (const [name, m] of Object.entries(cases)) {
      writeManifest(manifestPath, m);
      const scratch = await scratchDbName('sg');
      await expect(restoreDump(signed(), manifestPath, scratch), name).rejects.toThrow(/signature is invalid|not signed/);
      expect(await exists(scratch), name).toBe(false);
    }
  });

  it('without a key the manifest is NOT tamper-proof: a consistently rewritten dump+manifest restores as "unsigned"', async () => {
    // Documented limitation: unsigned manifests only detect accidental corruption.
    const A = await school('bk-uns');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    const other = await school('bk-uns2');
    const forged = await exportSchool(f.deps, other.id, tmp());
    fs.copyFileSync(forged.manifestPath, manifestPath);
    fs.copyFileSync(dumpOf(forged.manifestPath), path.join(path.dirname(manifestPath), forged.manifest.dump_file));
    const scratch = await scratchDbName('un');
    expect(await restoreDump(f.deps, manifestPath, scratch)).toMatchObject({ ok: true, signature: 'unsigned' });
    await drop(scratch);
    // …but with a key configured, the same forgery is refused.
    const scratch2 = await scratchDbName('un');
    await expect(restoreDump(signed(), manifestPath, scratch2)).rejects.toThrow(/not signed/);
  });
});

describe('offboarding is safely retryable after a restore-verification failure', () => {
  const lapse = (id: string, daysAgo: number) =>
    f.control.query(`UPDATE subscriptions SET period_start = $2, period_end = $3 WHERE school_id = $1`, [
      id,
      addDays(today(), -daysAgo - 30),
      addDays(today(), -daysAgo),
    ]);
  const fin = (deps: ProvisionDeps, id: string, slug: string, over: Record<string, unknown> = {}) =>
    finalizeOffboarding(deps, id, { confirmSlug: slug, exportDir: tmp(), today: today(), actorId: null, ...over });
  const stateOf = async (id: string) => (await f.control.query(`SELECT status FROM schools WHERE id = $1`, [id])).rows[0].status as string;

  async function ready(prefix: string) {
    const A = await school(prefix);
    await A.admin.post('/classes', { name: 'Keep me' });
    await startOffboarding(f.deps, A.id, null, 'closing');
    await lapse(A.id, 91);
    return A;
  }

  it('a corrupted export (checksum) aborts without deleting; the retry succeeds', async () => {
    const A = await ready('bk-of1');
    const hooked: ProvisionDeps = {
      ...f.deps,
      testHooks: { afterExport: (m) => fs.appendFileSync(dumpOf(m), 'garbage') },
    };
    await expect(fin(hooked, A.id, A.slug)).rejects.toThrow(/checksum/);
    expect(await exists(dbNameFor(A.id))).toBe(true);
    expect(await exists(`verify_${dbNameFor(A.id)}`)).toBe(false);
    expect(await stateOf(A.id)).toBe('offboarding');
    await fin(f.deps, A.id, A.slug);
    expect(await exists(dbNameFor(A.id))).toBe(false);
    expect(await stateOf(A.id)).toBe('archived');
  });

  it('a digest mismatch aborts without deleting and leaves no scratch database; the retry succeeds', async () => {
    const A = await ready('bk-of2');
    const hooked: ProvisionDeps = {
      ...f.deps,
      testHooks: {
        afterExport: (m) => {
          const good = readManifest(m);
          writeManifest(m, { ...good, table_digests: { ...good.table_digests, classes: '0'.repeat(32) } });
        },
      },
    };
    await expect(fin(hooked, A.id, A.slug)).rejects.toThrow(/failed verification \(classes\); nothing was deleted/);
    expect(await exists(dbNameFor(A.id))).toBe(true);
    expect(await exists(`verify_${dbNameFor(A.id)}`)).toBe(false);
    expect(await stateOf(A.id)).toBe('offboarding');
    await fin(f.deps, A.id, A.slug);
    expect(await stateOf(A.id)).toBe('archived');
  });

  it('a stale verify_ database left by a crashed earlier attempt does not block the retry; other databases are untouched', async () => {
    const A = await ready('bk-of3');
    const stale = `verify_${dbNameFor(A.id)}`.slice(0, 40);
    await f.admin.query(`CREATE DATABASE "${stale}"`);
    const bystander = await scratchDbName('b3');
    await f.admin.query(`CREATE DATABASE "${bystander}"`);
    await fin(f.deps, A.id, A.slug);
    expect(await exists(stale)).toBe(false);
    expect(await exists(bystander)).toBe(true);
    expect(await stateOf(A.id)).toBe('archived');
    await drop(bystander);
  });

  it('a signed final export is verified and the audit says so; the offboarding refuses a future "today"', async () => {
    const A = await ready('bk-of4');
    await expect(fin(signed(), A.id, A.slug, { today: addDays(today(), 400) })).rejects.toThrow(/future/);
    expect(await exists(dbNameFor(A.id))).toBe(true);
    await fin(signed(), A.id, A.slug);
    const meta = (await f.control.query(`SELECT metadata FROM platform_audit_events WHERE school_id = $1 AND action = 'school.offboarded'`, [A.id])).rows[0]
      .metadata;
    expect(meta.manifest_signed).toBe(true);
  });
});

describe('encrypted backups at rest', () => {
  const ENC = Buffer.alloc(32, 5);
  const enc = (): ProvisionDeps => ({ ...f.deps, backupEncryptionKey: ENC, backupSigningKey: KEY });

  it('writes only ciphertext, restores and verifies with the key, and refuses without or with a wrong key', async () => {
    const A = await school('bk-enc');
    await A.admin.post('/classes', { name: 'Secret Class Name' });
    const out = tmp();
    const { manifestPath, manifest } = await exportSchool(enc(), A.id, out);
    expect(manifest.encryption).toEqual({ alg: 'aes-256-gcm-chunked', version: 1 });
    expect(manifest.dump_file.endsWith('.dump.enc')).toBe(true);
    expect(fs.readdirSync(out).filter((n) => n.endsWith('.dump'))).toEqual([]); // no plaintext dump left behind
    expect(fs.readFileSync(dumpOf(manifestPath)).includes('Secret Class Name')).toBe(false);
    expect(manifest.signature).toBeDefined();

    const scratch = await scratchDbName('en');
    expect(await restoreDump(enc(), manifestPath, scratch)).toMatchObject({ ok: true, signature: 'verified' });
    const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, scratch) });
    await c.connect();
    try {
      expect((await c.query(`SELECT 1 FROM classes WHERE name = 'Secret Class Name'`)).rowCount).toBe(1); // decrypted content is really there
    } finally {
      await c.end();
    }
    await drop(scratch);

    const s2 = await scratchDbName('en2');
    await expect(restoreDump({ ...enc(), backupEncryptionKey: undefined }, manifestPath, s2)).rejects.toThrow(/encrypted but no backup encryption key/);
    await expect(restoreDump({ ...enc(), backupEncryptionKey: Buffer.alloc(32, 6) }, manifestPath, s2)).rejects.toThrow(/decryption failed/);
    expect(await exists(s2)).toBe(false); // nothing was created
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('petra-restore-'))).toEqual([]); // scratch plaintext removed
  });

  it('the encryption marker is covered by the signature (cannot be stripped to force a plaintext restore)', async () => {
    const A = await school('bk-enc2');
    const { manifestPath } = await exportSchool(enc(), A.id, tmp());
    const m = readManifest(manifestPath);
    const { encryption: _e, ...stripped } = m;
    writeManifest(manifestPath, stripped);
    await expect(restoreDump(enc(), manifestPath, await scratchDbName('en3'))).rejects.toThrow(/signature is invalid/);
  });

  it('a modified ciphertext fails the manifest checksum before anything is decrypted', async () => {
    const A = await school('bk-enc3');
    const { manifestPath } = await exportSchool(enc(), A.id, tmp());
    const file = dumpOf(manifestPath);
    const b = fs.readFileSync(file);
    b[b.length - 20] = b[b.length - 20]! ^ 1;
    fs.writeFileSync(file, b);
    await expect(restoreDump(enc(), manifestPath, await scratchDbName('en4'))).rejects.toThrow(/checksum/);
  });

  it('unencrypted backups made before the key existed still restore', async () => {
    const A = await school('bk-enc4');
    const { manifestPath } = await exportSchool(f.deps, A.id, tmp());
    expect(readManifest(manifestPath).encryption).toBeUndefined();
    const scratch = await scratchDbName('en5');
    expect(await restoreDump({ ...f.deps, backupEncryptionKey: ENC }, manifestPath, scratch)).toMatchObject({ ok: true });
    await drop(scratch);
  });
});
