import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionSchool, reencryptAllSecrets, rotateSchoolSecret, type ProvisionDeps } from '../src/provisioning.js';
import { generateMasterKey, loadMasterKeys, SecretBox, SecretError } from '../src/secrets.js';
import { REGISTRY_COLUMNS } from '../src/tenancy.js';
import { controlFixture, registerNew, type ControlFixture } from './fixtures.js';

// Test-only keys generated per run; they never touch the real PETRA_MASTER_KEY.
const OLD = generateMasterKey();
const NEW = generateMasterKey();
const oldBox = new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: OLD, PETRA_MASTER_KEY_ID: 'rot-old' }));
const newBox = new SecretBox(
  loadMasterKeys({ PETRA_MASTER_KEY: NEW, PETRA_MASTER_KEY_ID: 'rot-new', PETRA_MASTER_KEY_PREVIOUS: OLD, PETRA_MASTER_KEY_PREVIOUS_ID: 'rot-old' }),
);
const newOnlyBox = new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: NEW, PETRA_MASTER_KEY_ID: 'rot-new' }));

let f: ControlFixture;
let oldDeps: ProvisionDeps;
let newDeps: ProvisionDeps;

beforeAll(async () => {
  f = await controlFixture({ secrets: oldBox });
  oldDeps = f.deps;
  newDeps = { ...f.deps, secrets: newBox };
});
afterAll(() => f.close());

const row = async (id: string) =>
  (await f.control.query(`SELECT ${REGISTRY_COLUMNS}, db_secret_pending_enc FROM schools WHERE id = $1`, [id])).rows[0] as {
    db_secret_enc: string;
    db_secret_pending_enc: string | null;
    db_role: string;
    db_name: string;
    db_host: string;
    db_port: number;
  };
async function newSchool(prefix: string) {
  const { id } = await registerNew(f, prefix);
  await provisionSchool(oldDeps, id);
  return id;
}
async function canLogin(box: SecretBox, id: string): Promise<boolean> {
  const r = await row(id);
  const c = new pg.Client({ host: r.db_host, port: r.db_port, user: r.db_role, password: box.decrypt(r.db_secret_enc, id), database: r.db_name });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

describe('reencryptAllSecrets', () => {
  it('moves every credential to the current key, keeps the plaintext, is idempotent, and the schools stay reachable', async () => {
    const ids = [await newSchool('rk1'), await newSchool('rk2'), await newSchool('rk3')];
    const before = await Promise.all(ids.map(row));
    for (const b of before) expect(oldBox.keyIdOf(b.db_secret_enc)).toBe('rot-old');
    const plain = ids.map((id, i) => oldBox.decrypt(before[i]!.db_secret_enc, id));

    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: ids })).toEqual({ updated: 3, skipped: 0 });
    const after = await Promise.all(ids.map(row));
    after.forEach((a, i) => {
      expect(newBox.keyIdOf(a.db_secret_enc)).toBe('rot-new');
      expect(a.db_secret_enc).not.toBe(before[i]!.db_secret_enc);
      expect(newBox.decrypt(a.db_secret_enc, ids[i]!)).toBe(plain[i]);
    });
    for (const id of ids) expect(await canLogin(newBox, id)).toBe(true);

    // idempotent: nothing changes, ciphertexts are byte-identical
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: ids })).toEqual({ updated: 0, skipped: 0 });
    expect((await Promise.all(ids.map(row))).map((r) => r.db_secret_enc)).toEqual(after.map((r) => r.db_secret_enc));
  });

  it('mixed state (some rows already migrated, e.g. an interrupted earlier run): only the remaining rows change', async () => {
    const [a, b, c] = [await newSchool('rm1'), await newSchool('rm2'), await newSchool('rm3')] as [string, string, string];
    await reencryptAllSecrets(f.control, newBox, { schoolIds: [b] }); // "interrupted after the first row"
    const bDone = (await row(b)).db_secret_enc;
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [a, b, c] })).toEqual({ updated: 2, skipped: 0 });
    expect((await row(b)).db_secret_enc).toBe(bDone); // already-current rows are not rewritten
    for (const id of [a, b, c]) {
      expect(newBox.keyIdOf((await row(id)).db_secret_enc)).toBe('rot-new');
      expect(await canLogin(newBox, id)).toBe(true);
    }
    // during the mixed state everything was decryptable with the previous key configured: re-verify with a fresh box
    expect(await canLogin(newBox, a)).toBe(true);
  });

  it('a pending credential rotation is re-encrypted too, and the rotation can still complete afterwards', async () => {
    const id = await newSchool('rp1');
    await expect(
      rotateSchoolSecret(oldDeps, id, {
        afterPending: () => {
          throw new Error('crash after the pending secret was stored');
        },
      }),
    ).rejects.toThrow(/crash after/);
    const mid = await row(id);
    expect(mid.db_secret_pending_enc).toBeTruthy();
    const pendingPlain = oldBox.decrypt(mid.db_secret_pending_enc!, id);

    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [id] })).toEqual({ updated: 1, skipped: 0 });
    const after = await row(id);
    expect(newBox.keyIdOf(after.db_secret_enc)).toBe('rot-new');
    expect(newBox.keyIdOf(after.db_secret_pending_enc!)).toBe('rot-new');
    expect(newBox.decrypt(after.db_secret_pending_enc!, id)).toBe(pendingPlain); // the pending password is preserved, not regenerated

    await rotateSchoolSecret(newDeps, id); // resumes with the very same pending password
    const done = await row(id);
    expect(done.db_secret_pending_enc).toBeNull();
    expect(newBox.decrypt(done.db_secret_enc, id)).toBe(pendingPlain);
    expect(await canLogin(newBox, id)).toBe(true);
  });

  it('only a pending slot left on the old key (current already migrated) is still converted', async () => {
    const id = await newSchool('rp2');
    await reencryptAllSecrets(f.control, newBox, { schoolIds: [id] });
    await f.control.query(`UPDATE schools SET db_secret_pending_enc = $2 WHERE id = $1`, [id, oldBox.encrypt('pending-test-secret', id)]);
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [id] })).toEqual({ updated: 1, skipped: 0 });
    expect(newBox.keyIdOf((await row(id)).db_secret_pending_enc!)).toBe('rot-new');
  });

  it('without the previous key the run aborts and leaves the row untouched (no data loss)', async () => {
    const id = await newSchool('rn1');
    const before = await row(id);
    await expect(reencryptAllSecrets(f.control, newOnlyBox, { schoolIds: [id] })).rejects.toThrow(SecretError);
    await expect(reencryptAllSecrets(f.control, newOnlyBox, { schoolIds: [id] })).rejects.not.toThrow(/v1\.|[A-Za-z0-9_-]{40,}/); // no key or ciphertext in the message
    const after = await row(id);
    expect(after.db_secret_enc).toBe(before.db_secret_enc);
    expect(await canLogin(oldBox, id)).toBe(true);
  });

  it('a ciphertext bound to another school (swapped rows) is detected and nothing is rewritten', async () => {
    const [a, b] = [await newSchool('rs1'), await newSchool('rs2')] as [string, string];
    const [ra, rb] = [await row(a), await row(b)];
    await f.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1`, [a, rb.db_secret_enc]);
    await expect(reencryptAllSecrets(f.control, newBox, { schoolIds: [a] })).rejects.toThrow(/could not be decrypted/);
    expect((await row(a)).db_secret_enc).toBe(rb.db_secret_enc);
    await f.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1`, [a, ra.db_secret_enc]);
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [a, b] })).toEqual({ updated: 2, skipped: 0 });
  });

  it('a concurrent credential rotation is never overwritten: the row is skipped and converted by the next run', async () => {
    const id = await newSchool('rc1');
    const racing = new Proxy(f.control, {
      get(target, prop, recv) {
        if (prop !== 'query') return Reflect.get(target, prop, recv);
        return async (sql: unknown, params?: unknown[]) => {
          if (typeof sql === 'string' && /SET db_secret_enc = \$2, db_secret_pending_enc = \$3/.test(sql)) {
            // a rotation lands between our SELECT and our UPDATE
            await target.query(`UPDATE schools SET db_secret_pending_enc = $2 WHERE id = $1`, [id, oldBox.encrypt('rotation-won-the-race', id)]);
          }
          return (target.query as (s: unknown, p?: unknown[]) => Promise<unknown>).call(target, sql, params);
        };
      },
    });
    expect(await reencryptAllSecrets(racing, newBox, { schoolIds: [id] })).toEqual({ updated: 0, skipped: 1 });
    const mid = await row(id);
    expect(oldBox.keyIdOf(mid.db_secret_enc)).toBe('rot-old'); // untouched
    expect(oldBox.decrypt(mid.db_secret_pending_enc!, id)).toBe('rotation-won-the-race'); // the rotation's value survived
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [id] })).toEqual({ updated: 1, skipped: 0 });
    expect(newBox.decrypt((await row(id)).db_secret_pending_enc!, id)).toBe('rotation-won-the-race');
  });

  it('only registry rows with a credential are considered (archived/unprovisioned schools are ignored)', async () => {
    const { id } = await registerNew(f, 'rx1'); // never provisioned: no secret
    expect(await reencryptAllSecrets(f.control, newBox, { schoolIds: [id] })).toEqual({ updated: 0, skipped: 0 });
  });
});
