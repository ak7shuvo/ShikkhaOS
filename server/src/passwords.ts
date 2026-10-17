import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';

// argon2id with library defaults (m=19MiB, t=2, p=1 — OWASP minimum guidance).
export const hashPassword = (pw: string) => hash(pw);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Verifies against a throwaway hash so unknown-user logins cost the same as real ones. */
export async function burnPasswordCheck(pw: string): Promise<void> {
  dummy ??= hash(randomBytes(16).toString('hex'));
  await verifyPassword(await dummy, pw);
}

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const PASSWORD_MIN_LENGTH = 10;

/** Platform administrators control every school, so their minimum is longer than for school users. */
export const PLATFORM_PASSWORD_MIN_LENGTH = 12;
