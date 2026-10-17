import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  normaliseRecoveryCode,
  otpauthUri,
  stepAt,
  totpAt,
  verifyTotp,
} from '../src/totp.js';

// RFC 6238 appendix B (SHA-1), secret "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_B32 = base32Encode(RFC_SECRET);

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(RFC_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [t, want] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ] as const) {
      expect(hotp(RFC_SECRET, Math.floor(t / 30), 8), String(t)).toBe(want);
    }
    expect(totpAt(RFC_B32, 59_000)).toBe('287082'); // 6 digits = last six digits of the 8-digit vector
  });

  it('round-trips base32 and rejects invalid input', () => {
    for (let n = 0; n < 40; n++) {
      const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(base32Decode('gezd gnbv-GY3T')).toEqual(base32Decode('GEZDGNBVGY3T'));
    expect(() => base32Decode('1')).toThrow();
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('accepts the current step and ±1 step of drift, nothing further', () => {
    const now = 1_700_000_000_000;
    const at = (deltaSteps: number) => totpAt(RFC_B32, now + deltaSteps * 30_000);
    expect(verifyTotp(RFC_B32, at(0), now, null)).toBe(stepAt(now));
    expect(verifyTotp(RFC_B32, at(-1), now, null)).toBe(stepAt(now) - 1);
    expect(verifyTotp(RFC_B32, at(1), now, null)).toBe(stepAt(now) + 1);
    expect(verifyTotp(RFC_B32, at(-2), now, null)).toBeNull();
    expect(verifyTotp(RFC_B32, at(2), now, null)).toBeNull();
  });

  it('refuses a step that was already used (replay) but accepts a later one', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyTotp(RFC_B32, totpAt(RFC_B32, now), now, step)).toBeNull(); // same step
    expect(verifyTotp(RFC_B32, totpAt(RFC_B32, now - 30_000), now, step)).toBeNull(); // earlier step
    expect(verifyTotp(RFC_B32, totpAt(RFC_B32, now + 30_000), now, step)).toBe(step + 1);
  });

  it('rejects malformed codes without throwing', () => {
    const now = Date.now();
    for (const c of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) expect(verifyTotp(RFC_B32, c, now, null), c).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const u = otpauthUri('Petra ShikkhaOS', 'a.b@example.test', 'ABC234');
    expect(u).toBe('otpauth://totp/Petra%20ShikkhaOS:a.b%40example.test?secret=ABC234&issuer=Petra%20ShikkhaOS&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('generates 10 distinct high-entropy codes in XXXXX-XXXXX form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });
  it('normalises case, spaces and dashes before hashing, and never stores the code itself', () => {
    expect(normaliseRecoveryCode(' abcde-fghij ')).toBe('ABCDEFGHIJ');
    expect(hashRecoveryCode('abcde-fghij')).toBe(hashRecoveryCode('ABCDEFGHIJ'));
    expect(hashRecoveryCode('ABCDE-FGHIJ')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRecoveryCode('ABCDE-FGHIJ')).not.toContain('ABCDE');
    expect(hashRecoveryCode('ABCDE-FGHIK')).not.toBe(hashRecoveryCode('ABCDE-FGHIJ'));
  });
});
