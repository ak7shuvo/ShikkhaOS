import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 s step, 6 digits) for platform-administrator MFA, plus single-use recovery codes.
 * Pure functions on top of node:crypto; no secret is ever logged by this module.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes from one step before/after the current one are accepted (clock drift). */
export const TOTP_WINDOW = 1;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit shared secret, base32 encoded (what authenticator apps expect). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** HOTP value for a counter (RFC 4226 dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** The code valid at `ms` (used by tests and by `verifyTotp`). */
export const totpAt = (secretB32: string, ms: number): string => hotp(base32Decode(secretB32), stepAt(ms));

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Checks a submitted code. Returns the matching time step, or null. A step at or before `lastAcceptedStep` is refused, so a code
 * (even one still inside the window) can be used only once; all candidate steps are compared without early exit.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastAcceptedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = stepAt(nowMs);
  let match: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d;
    if (step < 0) continue;
    if (safeEqual(hotp(secret, step), code) && match === null && (lastAcceptedStep === null || step > lastAcceptedStep)) match = step;
  }
  return match;
}

export const otpauthUri = (issuer: string, account: string, secretB32: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;

// ------------------------------------------------------------------------------------------------ recovery codes
export const RECOVERY_CODE_COUNT = 10;

/** `XXXXX-XXXXX` from the base32 alphabet (50 bits of entropy each). */
export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const raw = Array.from(b, (x) => ALPHABET[x & 31]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normaliseRecoveryCode = (c: string): string => c.replace(/[\s-]/g, '').toUpperCase();
export const hashRecoveryCode = (c: string): string =>
  createHash('sha256')
    .update(`petra-recovery:${normaliseRecoveryCode(c)}`)
    .digest('hex');
