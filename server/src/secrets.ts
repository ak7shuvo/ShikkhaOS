import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope for per-school database credentials stored in the control-plane registry.
 * AES-256-GCM, key from the PETRA_MASTER_KEY environment variable (never stored in the DB or repo).
 * The school id is bound as AAD, so a ciphertext copied onto another school's row will not decrypt.
 * Format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * This is NOT an external KMS; whoever can read the environment of the API process can decrypt.
 */
export interface MasterKeys {
  currentId: string;
  keys: Map<string, Buffer>;
}

export class SecretError extends Error {}

function decodeKey(b64: string, label: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new SecretError(`${label} must be base64 of exactly 32 bytes`);
  return k;
}

export function loadMasterKeys(env: {
  PETRA_MASTER_KEY: string;
  PETRA_MASTER_KEY_ID: string;
  PETRA_MASTER_KEY_PREVIOUS?: string;
  PETRA_MASTER_KEY_PREVIOUS_ID?: string;
}): MasterKeys {
  const keys = new Map<string, Buffer>();
  keys.set(env.PETRA_MASTER_KEY_ID, decodeKey(env.PETRA_MASTER_KEY, 'PETRA_MASTER_KEY'));
  if (env.PETRA_MASTER_KEY_PREVIOUS) {
    const pid = env.PETRA_MASTER_KEY_PREVIOUS_ID;
    if (!pid || pid === env.PETRA_MASTER_KEY_ID) throw new SecretError('PETRA_MASTER_KEY_PREVIOUS_ID must be set and differ from PETRA_MASTER_KEY_ID');
    keys.set(pid, decodeKey(env.PETRA_MASTER_KEY_PREVIOUS, 'PETRA_MASTER_KEY_PREVIOUS'));
  }
  return { currentId: env.PETRA_MASTER_KEY_ID, keys };
}

const b64 = (b: Buffer) => b.toString('base64url');

export class SecretBox {
  constructor(private mk: MasterKeys) {}

  get currentKeyId(): string {
    return this.mk.currentId;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.mk.keys.get(this.mk.currentId)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return ['v1', this.mk.currentId, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
  }

  /** Key id embedded in a ciphertext (for rotation reports). */
  keyIdOf(blob: string): string | null {
    const p = blob.split('.');
    return p[0] === 'v1' && p.length === 5 ? p[1]! : null;
  }

  decrypt(blob: string, aad: string): string {
    const p = blob.split('.');
    if (p.length !== 5 || p[0] !== 'v1') throw new SecretError('unsupported secret format');
    const key = this.mk.keys.get(p[1]!);
    if (!key) throw new SecretError(`master key "${p[1]}" is not available (rotate keys or restore PETRA_MASTER_KEY_PREVIOUS)`);
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(p[2]!, 'base64url'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(p[3]!, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(p[4]!, 'base64url')), d.final()]).toString('utf8');
    } catch {
      // Never include key material or ciphertext in the message.
      throw new SecretError('secret could not be decrypted (wrong key or ciphertext bound to a different school)');
    }
  }

  /** Re-encrypts with the current key. Returns the same blob if already current. */
  reencrypt(blob: string, aad: string): string {
    if (this.keyIdOf(blob) === this.mk.currentId) return blob;
    return this.encrypt(this.decrypt(blob, aad), aad);
  }
}

/** 32 random bytes, base64 — for `npm run secrets:generate-key`. */
export const generateMasterKey = () => randomBytes(32).toString('base64');

/** URL-safe random password for generated database roles. */
export const generateDbPassword = () => randomBytes(32).toString('base64url');
