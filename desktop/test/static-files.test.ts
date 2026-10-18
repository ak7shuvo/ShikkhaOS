import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mimeFor, resolveStaticPath } from '../src/static-files.js';

const root = path.resolve('/srv/app/build/web');

describe('static file resolution', () => {
  it('serves files inside the bundle and falls back to index.html for client-side routes', () => {
    expect(resolveStaticPath(root, '/')).toEqual({ file: path.join(root, 'index.html'), spaFallback: false });
    expect(resolveStaticPath(root, '/assets/index-abc.js')).toEqual({ file: path.join(root, 'assets', 'index-abc.js'), spaFallback: false });
    expect(resolveStaticPath(root, '/students/123')).toEqual({ file: path.join(root, 'index.html'), spaFallback: true });
  });

  it('refuses traversal, encoded traversal, backslashes and NUL bytes', () => {
    for (const p of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%5c..%5csecret', '/a\0b.js', '/%zz']) {
      expect(resolveStaticPath(root, p), p).toBeNull();
    }
  });

  it('knows the content types the bundle uses', () => {
    expect(mimeFor('a.js')).toMatch(/javascript/);
    expect(mimeFor('a.css')).toMatch(/css/);
    expect(mimeFor('a.html')).toMatch(/html/);
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
  });
});
