import { describe, expect, it } from 'vitest';
import { SecretBox, SecretError, generateMasterKey, loadMasterKeys } from '../src/secrets.js';

const box = (id = 'k1', key = generateMasterKey(), prev?: { id: string; key: string }) =>
  new SecretBox(loadMasterKeys({ PETRA_MASTER_KEY: key, PETRA_MASTER_KEY_ID: id, PETRA_MASTER_KEY_PREVIOUS: prev?.key, PETRA_MASTER_KEY_PREVIOUS_ID: prev?.id }));

describe('SecretBox', () => {
  it('round-trips and never contains the plaintext', () => {
    const b = box();
    const blob = b.encrypt('s3cret-password', 'school-a');
    expect(blob).not.toContain('s3cret');
    expect(b.decrypt(blob, 'school-a')).toBe('s3cret-password');
    expect(b.encrypt('s3cret-password', 'school-a')).not.toBe(blob); // random IV
  });
  it('binds ciphertext to the school id (copying it to another row fails)', () => {
    const b = box();
    expect(() => b.decrypt(b.encrypt('x', 'school-a'), 'school-b')).toThrow(SecretError);
  });
  it('fails closed with the wrong key and does not leak details', () => {
    const blob = box('k1').encrypt('x', 'a');
    expect(() => box('k1').decrypt(blob, 'a')).toThrow(/could not be decrypted/);
  });
  it('rejects tampering and unknown formats', () => {
    const b = box();
    const blob = b.encrypt('x', 'a');
    const parts = blob.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => b.decrypt(parts.join('.'), 'a')).toThrow(SecretError);
    expect(() => b.decrypt('plain', 'a')).toThrow(/unsupported/);
  });
  it('rotation: previous key still decrypts, reencrypt moves to the current key', () => {
    const k1 = generateMasterKey();
    const old = box('k1', k1);
    const blob = old.encrypt('pw', 's');
    const key2 = generateMasterKey();
    const rotated = box('k2', key2, { id: 'k1', key: k1 });
    expect(rotated.decrypt(blob, 's')).toBe('pw');
    const re = rotated.reencrypt(blob, 's');
    expect(rotated.keyIdOf(re)).toBe('k2');
    expect(rotated.reencrypt(re, 's')).toBe(re);
    // After retiring the previous key, only re-encrypted data works.
    const retired = box('k2', key2);
    expect(retired.decrypt(re, 's')).toBe('pw');
    expect(() => retired.decrypt(blob, 's')).toThrow(/not available/);
  });
  it('validates key material', () => {
    expect(() => loadMasterKeys({ PETRA_MASTER_KEY: 'short', PETRA_MASTER_KEY_ID: 'k1' })).toThrow(/32 bytes/);
    const k = generateMasterKey();
    expect(() => loadMasterKeys({ PETRA_MASTER_KEY: k, PETRA_MASTER_KEY_ID: 'k1', PETRA_MASTER_KEY_PREVIOUS: k, PETRA_MASTER_KEY_PREVIOUS_ID: 'k1' })).toThrow(/differ/);
  });
});
