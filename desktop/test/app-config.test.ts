import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../src/app-config.js';

const ok = { format: 1, slug: 'green-valley', display_name: 'Green Valley School', api_base_url: 'https://api.example.test', allow_insecure_loopback: false };

describe('app config (build-time, non-secret)', () => {
  it('accepts a valid branded or generic configuration and normalises the origin', () => {
    expect(parseAppConfig(ok)).toEqual(ok);
    expect(parseAppConfig({ ...ok, slug: null, api_base_url: 'https://api.example.test/' }).api_base_url).toBe('https://api.example.test');
    expect(parseAppConfig({ ...ok, slug: undefined }).slug).toBeNull();
  });

  it('requires https for the API; plain http only for an explicit loopback test build', () => {
    expect(() => parseAppConfig({ ...ok, api_base_url: 'http://api.example.test' })).toThrow(/https/);
    expect(() => parseAppConfig({ ...ok, api_base_url: 'http://127.0.0.1:3000' })).toThrow(/https/); // flag not set
    expect(() => parseAppConfig({ ...ok, api_base_url: 'http://api.example.test', allow_insecure_loopback: true })).toThrow(/https/); // not loopback
    expect(parseAppConfig({ ...ok, api_base_url: 'http://127.0.0.1:3000', allow_insecure_loopback: true }).api_base_url).toBe('http://127.0.0.1:3000');
    expect(parseAppConfig({ ...ok, api_base_url: 'http://localhost:3000', allow_insecure_loopback: true }).api_base_url).toBe('http://localhost:3000');
  });

  it('rejects anything that is not a bare origin (credentials, paths, query) and invalid fields', () => {
    for (const api_base_url of [
      'https://u:p@api.example.test',
      'https://api.example.test/v1',
      'https://api.example.test/?x=1',
      'https://api.example.test/#f',
      'not a url',
      '',
    ]) {
      expect(() => parseAppConfig({ ...ok, api_base_url }), api_base_url).toThrow(/api_base_url/);
    }
    expect(() => parseAppConfig({ ...ok, slug: 'Bad Slug!' })).toThrow(/slug/);
    expect(() => parseAppConfig({ ...ok, display_name: 'x' })).toThrow(/display_name/);
    expect(() => parseAppConfig({ ...ok, format: 2 })).toThrow(/format/);
    expect(() => parseAppConfig(null)).toThrow();
  });

  it('error messages never echo the configured values', () => {
    try {
      parseAppConfig({ ...ok, api_base_url: 'https://user:secret-pass@api.example.test' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-pass');
    }
  });
});
