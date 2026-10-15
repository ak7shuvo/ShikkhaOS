/**
 * Safety guard for the destructive test setup (test/global-setup.ts).
 *
 * The suite drops and recreates schemas and drops per-school databases/roles, so it must only ever run against a
 * cluster that was explicitly created for testing. Everything here is fail-closed: any missing or ambiguous input
 * throws UnsafeTestEnvironmentError BEFORE a destructive statement is executed.
 *
 * A cluster counts as disposable only if ALL of the following hold:
 *   1. PETRA_TEST_CLUSTER=disposable and PETRA_TEST_CLUSTER_ID are set (explicit opt-in);
 *   2. every TEST_* URL points at the same loopback (or explicitly allow-listed) host and port;
 *   3. the database names match the strict test-only patterns below and the roles are the fixed application roles;
 *   4. the cluster contains the marker database below whose `marker.cluster_id` equals PETRA_TEST_CLUSTER_ID.
 * Cleanup only ever drops objects the test environment can positively attribute to itself (see planCleanup).
 */
export class UnsafeTestEnvironmentError extends Error {
  constructor(message: string) {
    super(`Refusing to run destructive test setup: ${message}`);
  }
}

export const MARKER_DB = 'petra_disposable_test_cluster';
export const SHARED_DB_RE = /^shikkhaos_test(_[a-z0-9]{1,20})?$/;
export const CONTROL_DB_RE = /^petra_control_test(_[a-z0-9]{1,20})?$/;
export const SCRATCH_DB_RE = /^petra_test_scratch_[a-z0-9_]{1,30}$/;
export const SCHOOL_DB_RE = /^sk_[a-f0-9]{12}$/;
export const SCHOOL_ROLE_RE = /^sk_[a-f0-9]{12}_app$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ValidatedTestEnv {
  clusterId: string;
  host: string;
  port: string;
  adminUrl: string;
  markerUrl: string;
  sharedApp: string;
  sharedOwner: string;
  controlApp: string;
  controlOwner: string;
  sharedDb: string;
  controlDb: string;
}

const REQUIRED = [
  'TEST_PROVISIONER_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_MIGRATION_DATABASE_URL',
  'TEST_CONTROL_DATABASE_URL',
  'TEST_CONTROL_MIGRATION_DATABASE_URL',
] as const;

function parseUrl(name: string, v: string | undefined): URL {
  if (!v) throw new UnsafeTestEnvironmentError(`${name} is not set`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new UnsafeTestEnvironmentError(`${name} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new UnsafeTestEnvironmentError(`${name} is not a postgres URL`);
  return u;
}

export const urlWithDb = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Pure validation of the environment. Performs no I/O. */
export function validateTestEnvironment(env: NodeJS.ProcessEnv): ValidatedTestEnv {
  if (env.PETRA_TEST_CLUSTER !== 'disposable') throw new UnsafeTestEnvironmentError('PETRA_TEST_CLUSTER=disposable is required (explicit opt-in)');
  const clusterId = env.PETRA_TEST_CLUSTER_ID ?? '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clusterId))
    throw new UnsafeTestEnvironmentError('PETRA_TEST_CLUSTER_ID (8-64 chars) is required and must match the cluster marker');
  const allowedHosts = new Set(
    (env.PETRA_TEST_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );

  const urls = Object.fromEntries(REQUIRED.map((k) => [k, parseUrl(k, env[k])])) as Record<(typeof REQUIRED)[number], URL>;
  const first = urls.TEST_PROVISIONER_DATABASE_URL;
  const host = first.hostname;
  const port = first.port || '5432';
  for (const [k, u] of Object.entries(urls)) {
    if (u.hostname !== host || (u.port || '5432') !== port)
      throw new UnsafeTestEnvironmentError(`${k} points at a different host/port than the provisioner URL (one cluster only)`);
  }
  if (!LOOPBACK.has(host) && !allowedHosts.has(host))
    throw new UnsafeTestEnvironmentError(`host "${host}" is neither loopback nor listed in PETRA_TEST_ALLOWED_HOSTS`);

  const db = (u: URL) => decodeURIComponent(u.pathname.slice(1));
  if (db(first) !== 'postgres') throw new UnsafeTestEnvironmentError('TEST_PROVISIONER_DATABASE_URL must use the maintenance database "postgres"');
  const sharedDb = db(urls.TEST_DATABASE_URL);
  const controlDb = db(urls.TEST_CONTROL_DATABASE_URL);
  if (db(urls.TEST_MIGRATION_DATABASE_URL) !== sharedDb) throw new UnsafeTestEnvironmentError('shared app and owner URLs must name the same database');
  if (db(urls.TEST_CONTROL_MIGRATION_DATABASE_URL) !== controlDb)
    throw new UnsafeTestEnvironmentError('control app and owner URLs must name the same database');
  if (!SHARED_DB_RE.test(sharedDb)) throw new UnsafeTestEnvironmentError(`shared database "${sharedDb}" does not match ${SHARED_DB_RE}`);
  if (!CONTROL_DB_RE.test(controlDb)) throw new UnsafeTestEnvironmentError(`control database "${controlDb}" does not match ${CONTROL_DB_RE}`);
  if (decodeURIComponent(urls.TEST_DATABASE_URL.username) !== 'shikkha_app')
    throw new UnsafeTestEnvironmentError('TEST_DATABASE_URL must use the role shikkha_app');
  if (decodeURIComponent(urls.TEST_CONTROL_DATABASE_URL.username) !== 'petra_control_app')
    throw new UnsafeTestEnvironmentError('TEST_CONTROL_DATABASE_URL must use the role petra_control_app');

  return {
    clusterId,
    host,
    port,
    adminUrl: env.TEST_PROVISIONER_DATABASE_URL!,
    markerUrl: urlWithDb(env.TEST_PROVISIONER_DATABASE_URL!, MARKER_DB),
    sharedApp: env.TEST_DATABASE_URL!,
    sharedOwner: env.TEST_MIGRATION_DATABASE_URL!,
    controlApp: env.TEST_CONTROL_DATABASE_URL!,
    controlOwner: env.TEST_CONTROL_MIGRATION_DATABASE_URL!,
    sharedDb,
    controlDb,
  };
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Read-only: proves the connected cluster carries this environment's marker. `marker` is a client connected to MARKER_DB. */
export async function assertClusterMarker(marker: Queryable, expectedId: string): Promise<void> {
  let id: unknown;
  try {
    id = (await marker.query('SELECT cluster_id FROM marker LIMIT 2')).rows;
  } catch {
    throw new UnsafeTestEnvironmentError(`marker table missing in database "${MARKER_DB}": this cluster was not prepared as a disposable test cluster`);
  }
  const rows = id as { cluster_id: string }[];
  if (rows.length !== 1 || rows[0]!.cluster_id !== expectedId) throw new UnsafeTestEnvironmentError('cluster marker does not match PETRA_TEST_CLUSTER_ID');
}

export interface CleanupInput {
  /** Rows of the TEST control registry: (db_name, db_role). */
  registry: { db_name: string | null; db_role: string | null }[];
  /** Names the test run itself recorded in the marker ledger. */
  ledger: { kind: string; name: string }[];
}
export interface CleanupPlan {
  databases: string[];
  roles: string[];
}

/**
 * Decides what may be dropped. Only objects attributable to this test environment are eligible:
 *  - school databases/roles recorded in the TEST control registry (and their `verify_<db>` scratch databases);
 *  - scratch databases the tests recorded in the marker ledger under the test-only prefix.
 * Any malformed or unexpected entry aborts the plan (fail closed). Unregistered `sk_*` objects are NOT touched.
 */
export function planCleanup(input: CleanupInput): CleanupPlan {
  const databases = new Set<string>();
  const roles = new Set<string>();
  for (const r of input.registry) {
    if (r.db_name === null && r.db_role === null) continue;
    if (!r.db_name || !SCHOOL_DB_RE.test(r.db_name)) throw new UnsafeTestEnvironmentError(`unexpected registry database name "${r.db_name}"`);
    if (!r.db_role || !SCHOOL_ROLE_RE.test(r.db_role) || r.db_role !== `${r.db_name}_app`)
      throw new UnsafeTestEnvironmentError(`unexpected registry role "${r.db_role}"`);
    databases.add(r.db_name);
    databases.add(`verify_${r.db_name}`);
    roles.add(r.db_role);
  }
  for (const l of input.ledger) {
    if (l.kind !== 'database' || !SCRATCH_DB_RE.test(l.name)) throw new UnsafeTestEnvironmentError(`unexpected ledger entry ${l.kind}:${l.name}`);
    databases.add(l.name);
  }
  for (const d of databases)
    if (['postgres', 'template0', 'template1', MARKER_DB].includes(d)) throw new UnsafeTestEnvironmentError(`protected database "${d}" in cleanup plan`);
  return { databases: [...databases], roles: [...roles] };
}
