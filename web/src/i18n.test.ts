import { describe, expect, it } from 'vitest';
import { translate } from './i18n';
import { bn } from './locales/bn';
import { en } from './locales/en';

describe('i18n', () => {
  it('Bengali and English dictionaries have identical keys', () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
  });
  it('has no empty strings', () => {
    for (const d of [en, bn]) for (const [k, v] of Object.entries(d)) expect(v.trim(), k).not.toBe('');
  });
  it('interpolates variables and falls back to the key', () => {
    expect(translate('en', 'dash.welcome', { name: 'Rahim' })).toBe('Welcome, Rahim');
    expect(translate('bn', 'dash.welcome', { name: 'Rahim' })).toContain('Rahim');
    expect(translate('en', 'missing.key')).toBe('missing.key');
  });
});
