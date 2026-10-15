import fs from 'node:fs';

export interface TlsOptions {
  rejectUnauthorized: true;
  ca?: string;
}

/**
 * TLS options for runtime database pools. Certificate AND host name verification are always on when TLS is enabled.
 * `caFile` adds a private CA (PEM) to the trust store for these connections; without it the Node trust store is used.
 * (A connection-string `sslmode` takes precedence over these options in node-postgres.)
 */
export function tlsOptions(enabled: boolean, caFile?: string): false | TlsOptions {
  if (!enabled) return false;
  return { rejectUnauthorized: true, ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}) };
}
