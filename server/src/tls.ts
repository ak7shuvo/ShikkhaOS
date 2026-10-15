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
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = fs.readFileSync(caFile, 'utf8');
    } catch {
      throw new Error('DB_SSL_CA_FILE is not a readable file');
    }
  }
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

/**
 * The single place that decides TLS for the API's runtime pools: `control` is used for the control-plane pool AND the optional
 * legacy shared pool, `school` for every per-school pool (TenantRouter). Both always verify certificate and host name.
 */
export function runtimeDbTls(c: { CONTROL_DB_SSL: boolean; SCHOOL_DB_SSL: boolean; DB_SSL_CA_FILE?: string }): {
  control: false | TlsOptions;
  school: false | TlsOptions;
} {
  return { control: tlsOptions(c.CONTROL_DB_SSL, c.DB_SSL_CA_FILE), school: tlsOptions(c.SCHOOL_DB_SSL, c.DB_SSL_CA_FILE) };
}
