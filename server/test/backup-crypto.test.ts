import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptFile, encryptFile, parseBackupKey } from '../src/backup-crypto.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petra-crypto-'));
const KEY = Buffer.alloc(32, 3);
const MiB = 1024 * 1024;

function roundTrip(data: Buffer, name: string) {
  const src = path.join(dir, `${name}.bin`);
  fs.writeFileSync(src, data);
  const enc = `${src}.enc`;
  encryptFile(src, enc, KEY);
  return { src, enc, dec: `${src}.dec` };
}

describe('backup file encryption (AES-256-GCM, chunked)', () => {
  it.each([
    ['empty', 0],
    ['tiny', 5],
    ['exactly one chunk', MiB],
    ['one chunk plus one byte', MiB + 1],
    ['several chunks', 3 * MiB + 123],
  ])('round-trips %s', (name, size) => {
    const data = randomBytes(size);
    const { enc, dec } = roundTrip(data, name.replace(/ /g, '-'));
    expect(fs.statSync(enc).mode & 0o777).toBe(0o600);
    if (size > 0) expect(fs.readFileSync(enc).includes(data.subarray(0, 64))).toBe(false); // ciphertext does not contain the plaintext
    decryptFile(enc, dec, KEY);
    expect(fs.readFileSync(dec).equals(data)).toBe(true);
  });

  it('two encryptions of the same data differ (fresh per-file salt)', () => {
    const a = roundTrip(Buffer.from('same'), 'a');
    const b = roundTrip(Buffer.from('same'), 'b');
    expect(fs.readFileSync(a.enc).equals(fs.readFileSync(b.enc))).toBe(false);
  });

  it('rejects a wrong key, a flipped bit, truncation, dropped or reordered chunks, and removes partial output', () => {
    const { enc, dec } = roundTrip(randomBytes(3 * MiB + 10), 'tamper');
    const good = fs.readFileSync(enc);
    const attempt = (bytes: Buffer, key = KEY) => {
      const f = path.join(dir, 'x.enc');
      fs.writeFileSync(f, bytes);
      try {
        decryptFile(f, dec, key);
      } finally {
        expect(fs.existsSync(dec), 'no partial plaintext is left behind').toBe(false);
      }
    };
    expect(() => attempt(good, Buffer.alloc(32, 4))).toThrow(/decryption failed/);
    const flipped = Buffer.from(good);
    flipped[good.length - 40] = flipped[good.length - 40]! ^ 1;
    expect(() => attempt(flipped)).toThrow(/decryption failed/);
    expect(() => attempt(good.subarray(0, good.length - 1))).toThrow(/truncated|decryption failed/);
    // drop the last chunk: the new last chunk was authenticated as "not last"
    const chunk = 4 + MiB + 16;
    const head = 12;
    expect(() => attempt(good.subarray(0, head + 3 * chunk))).toThrow(/decryption failed/);
    // swap the first two chunks
    const swapped = Buffer.concat([
      good.subarray(0, head),
      good.subarray(head + chunk, head + 2 * chunk),
      good.subarray(head, head + chunk),
      good.subarray(head + 2 * chunk),
    ]);
    expect(() => attempt(swapped)).toThrow(/decryption failed/);
    expect(() => attempt(Buffer.from('not a backup at all'))).toThrow(/not an encrypted Petra backup/);
  });

  it('validates the configured key', () => {
    expect(parseBackupKey(undefined)).toBeUndefined();
    expect(parseBackupKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseBackupKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
