import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';

/**
 * At-rest encryption for backup dumps (H-3): chunked AES-256-GCM, so a multi-gigabyte dump is never held in memory.
 *
 *   file    = MAGIC(8) | fileSalt(4) | chunk*
 *   chunk   = length(4, big-endian, of ciphertext) | ciphertext | tag(16)
 *   nonce   = fileSalt(4) | chunkIndex(8, big-endian)            (unique per chunk and per file)
 *   AAD     = MAGIC | fileSalt | chunkIndex(8) | isLast(1)        (binds order, position and the end of the file)
 *
 * Reordering, dropping, duplicating or truncating chunks, or splicing chunks from another file, fails authentication.
 * The key (PETRA_BACKUP_ENCRYPTION_KEY, 32 bytes) must be stored away from the backups; losing it loses the backups.
 */
const MAGIC = Buffer.from('PETRABK1');
const CHUNK = 1024 * 1024;
const TAG = 16;
const SALT = 4;

const aad = (salt: Buffer, index: bigint, last: boolean): Buffer => {
  const b = Buffer.alloc(MAGIC.length + SALT + 8 + 1);
  MAGIC.copy(b, 0);
  salt.copy(b, MAGIC.length);
  b.writeBigUInt64BE(index, MAGIC.length + SALT);
  b[b.length - 1] = last ? 1 : 0;
  return b;
};
const nonce = (salt: Buffer, index: bigint): Buffer => {
  const n = Buffer.alloc(12);
  salt.copy(n, 0);
  n.writeBigUInt64BE(index, SALT);
  return n;
};

function readFully(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = fs.readSync(fd, buf, got, size - got, null);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

export function parseBackupKey(b64: string | undefined): Buffer | undefined {
  if (!b64) return undefined;
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('PETRA_BACKUP_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return k;
}

export function encryptFile(src: string, dst: string, key: Buffer): void {
  if (key.length !== 32) throw new Error('backup encryption key must be 32 bytes');
  const salt = randomBytes(SALT);
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dst, 'wx', 0o600);
  try {
    fs.writeSync(outFd, MAGIC);
    fs.writeSync(outFd, salt);
    let index = 0n;
    let cur = readFully(inFd, CHUNK);
    for (;;) {
      const next = cur.length === CHUNK ? readFully(inFd, CHUNK) : Buffer.alloc(0);
      const last = next.length === 0; // a full final chunk is followed by an empty read
      const c = createCipheriv('aes-256-gcm', key, nonce(salt, index));
      c.setAAD(aad(salt, index, last));
      const ct = Buffer.concat([c.update(cur), c.final()]);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(ct.length);
      fs.writeSync(outFd, head);
      fs.writeSync(outFd, ct);
      fs.writeSync(outFd, c.getAuthTag());
      if (last) break;
      cur = next;
      index++;
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

function readAt(fd: number, position: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = fs.readSync(fd, buf, got, size - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** Throws on a wrong key, any modification, reordering or truncation. Partial output is removed on failure. */
export function decryptFile(src: string, dst: string, key: Buffer): void {
  if (key.length !== 32) throw new Error('backup encryption key must be 32 bytes');
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dst, 'wx', 0o600);
  let ok = false;
  try {
    const size = fs.fstatSync(inFd).size;
    const head = readAt(inFd, 0, MAGIC.length + SALT);
    if (head.length !== MAGIC.length + SALT || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted Petra backup');
    const salt = head.subarray(MAGIC.length);
    let pos = MAGIC.length + SALT;
    let index = 0n;
    for (;;) {
      const len = readAt(inFd, pos, 4);
      if (len.length !== 4) throw new Error('backup is truncated');
      const ctLen = len.readUInt32BE();
      if (ctLen > CHUNK) throw new Error('backup chunk too large (corrupted)');
      const body = readAt(inFd, pos + 4, ctLen + TAG);
      if (body.length !== ctLen + TAG) throw new Error('backup is truncated');
      pos += 4 + ctLen + TAG;
      const last = pos === size;
      const d = createDecipheriv('aes-256-gcm', key, nonce(salt, index));
      d.setAAD(aad(salt, index, last));
      d.setAuthTag(body.subarray(ctLen));
      let pt: Buffer;
      try {
        pt = Buffer.concat([d.update(body.subarray(0, ctLen)), d.final()]);
      } catch {
        throw new Error('backup decryption failed (wrong key or modified/truncated file)');
      }
      fs.writeSync(outFd, pt);
      if (last) break;
      if (pos > size) throw new Error('backup is truncated');
      index++;
    }
    ok = true;
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    if (!ok) fs.rmSync(dst, { force: true });
  }
}
