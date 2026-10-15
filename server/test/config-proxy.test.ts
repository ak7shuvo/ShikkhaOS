import { describe, expect, it } from 'vitest';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { generateMasterKey } from '../src/secrets.js';
import { Client, harness } from './helpers.js';

const base = { CONTROL_DATABASE_URL: 'postgres://u:p@localhost:5432/db', PETRA_MASTER_KEY: generateMasterKey() };

describe('config validation', () => {
  it('requires the control database and the master key', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/CONTROL_DATABASE_URL/);
    expect(() => loadConfig({ CONTROL_DATABASE_URL: base.CONTROL_DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(/PETRA_MASTER_KEY/);
  });
  it('requires secure cookies and https origins in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv)).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/https/);
    const secureProd = {
      ...base,
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://app.example.test',
      TRUST_PROXY: '1',
      CONTROL_DB_SSL: 'true',
      SCHOOL_DB_SSL: 'true',
    };
    expect(loadConfig(secureProd as NodeJS.ProcessEnv).COOKIE_SECURE).toBe(true); // see production-guards.test.ts for the full matrix
  });
  it('parses TRUST_PROXY as off, a hop count, or a CIDR/IP list', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5')).toEqual(['10.0.0.0/8', '192.168.1.5']);
  });
});

describe('rate limiting and client IPs behind a proxy', () => {
  const spoofed = (h: { app: any }, i: number) =>
    new Client(h.app).req(
      'POST',
      '/auth/login',
      { school: 'nowhere', email: 'a@nowhere.example.test', password: 'whatever-123' },
      { 'x-forwarded-for': `203.0.113.${i}` },
    );

  it('without TRUST_PROXY a forged X-Forwarded-For cannot evade the login rate limit', async () => {
    const h = await harness({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 6; i++) codes.push((await spoofed(h, i)).status);
      expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    } finally {
      await h.close();
    }
  });

  it('with TRUST_PROXY=1 the proxy-supplied client address is used for limiting', async () => {
    const h = await harness({ LOGIN_RATE_LIMIT_PER_MINUTE: '3', TRUST_PROXY: '1' });
    try {
      const codes: number[] = [];
      for (let i = 1; i <= 6; i++) codes.push((await spoofed(h, i)).status);
      expect(codes).toEqual([401, 401, 401, 401, 401, 401]); // six distinct client IPs
      const same: number[] = [];
      for (let i = 0; i < 5; i++) same.push((await spoofed(h, 50)).status);
      expect(same).toEqual([401, 401, 401, 429, 429]); // one client IP is still limited
    } finally {
      await h.close();
    }
  });
});
