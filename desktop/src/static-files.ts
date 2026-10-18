import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export const mimeFor = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * Maps a request path to a file inside `root`. Returns null when the path escapes the root or is malformed.
 * Paths without a file extension fall back to index.html (client-side routing).
 */
export function resolveStaticPath(root: string, pathname: string): { file: string; spaFallback: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').some((seg) => seg === '..')) return null; // never normalise traversal away: refuse it
  const rel = decoded === '/' ? '/index.html' : decoded;
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, '.' + path.posix.normalize(rel));
  if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) return null;
  if (path.extname(file) === '') return { file: path.join(resolvedRoot, 'index.html'), spaFallback: true };
  return { file, spaFallback: false };
}
