import pg from 'pg';

/**
 * Database-level access control (who may CONNECT to which database).
 *
 * PostgreSQL grants CONNECT to PUBLIC on every new database. Inside a database the school roles have no table
 * privileges outside their own schema, but they should not be able to open a session on the control plane, the
 * shared legacy database, another school's database or the maintenance databases at all. This module is the
 * single place that revokes/grants those privileges; it is used by the operator CLI (`petra harden-db-access`),
 * by provisioning (own database) and by the health checks, and mirrored by the migrations 002/003 for the control
 * plane and every school database (so a database the migrations touch is hardened by the normal deployment path).
 *
 * Needs the database OWNER or a superuser: REVOKE by anyone else only raises a warning in PostgreSQL, which is why
 * `checkDatabaseAcls` re-reads the real ACLs instead of trusting that the statements worked.
 */
const NAME_RE = /^[A-Za-z0-9_]{1,63}$/;
const q = (name: string): string => {
  if (!NAME_RE.test(name)) throw new Error(`refusing unsafe database/role name "${name}"`);
  return `"${name}"`;
};

export interface AclSpec {
  /** Control-plane database name and its runtime role. */
  controlDb?: string;
  controlRole?: string;
  /** Legacy shared database (only while a school is db_mode='shared'). */
  sharedDb?: string;
  sharedRole?: string;
  /** Maintenance databases that must not be reachable by application roles. */
  maintenanceDbs?: string[];
  /** Roles that legitimately connect to `postgres` (provisioner/operator). The connecting role is always included. */
  operatorRoles?: string[];
  /** Dedicated school databases to repair (db_name/db_role from the registry). */
  schools?: { db_name: string | null; db_role: string | null }[];
}

export const DEFAULT_MAINTENANCE_DBS = ['postgres', 'template1'];

export interface HardenResult {
  applied: string[];
  failed: { database: string; error: string; sql: string[] }[];
}

async function roleExists(c: pg.Client, role: string): Promise<boolean> {
  return ((await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount ?? 0) > 0;
}

async function dbExists(c: pg.Client, db: string): Promise<boolean> {
  return ((await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount ?? 0) > 0;
}

/** Idempotently revokes PUBLIC CONNECT and grants CONNECT only to the intended roles. Never throws for one database: failures are reported with the SQL an operator must run. */
export async function hardenDatabaseAccess(adminUrl: string, spec: AclSpec): Promise<HardenResult> {
  const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await c.connect();
  const out: HardenResult = { applied: [], failed: [] };
  try {
    const me = (await c.query('SELECT current_user AS u')).rows[0].u as string;
    const harden = async (db: string, grantTo: string[]) => {
      const quoted = q(db);
      if (!(await dbExists(c, db))) return;
      const sql = [`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`];
      for (const r of new Set(grantTo)) if (await roleExists(c, r)) sql.push(`GRANT CONNECT ON DATABASE ${q(db)} TO ${q(r)}`);
      try {
        for (const s of sql) await c.query(s);
        // REVOKE by a role that is not the owner only raises a warning, so confirm against the real ACL.
        const still = (
          await c.query(
            `SELECT EXISTS (SELECT 1 FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = $1 AND a.grantee = 0 AND a.privilege_type = 'CONNECT') AS open`,
            [db],
          )
        ).rows[0].open as boolean;
        if (still) throw new Error('REVOKE had no effect: PUBLIC can still CONNECT (the connecting role is probably not the database owner or a superuser)');
        out.applied.push(db);
      } catch (e) {
        out.failed.push({ database: db, error: (e as Error).message, sql });
      }
    };
    if (spec.controlDb) await harden(spec.controlDb, [spec.controlRole ?? 'petra_control_app']);
    if (spec.sharedDb) await harden(spec.sharedDb, [spec.sharedRole ?? 'shikkha_app']);
    for (const m of spec.maintenanceDbs ?? DEFAULT_MAINTENANCE_DBS) await harden(m, m === 'postgres' ? [me, ...(spec.operatorRoles ?? [])] : []);
    for (const s of spec.schools ?? []) if (s.db_name && s.db_role) await harden(s.db_name, [s.db_role]);
  } finally {
    await c.end();
  }
  return out;
}

export interface AclFinding {
  database: string;
  exists: boolean;
  public_connect: boolean;
  ok: boolean;
}

/** Reads the real ACLs: ok = the database exists and PUBLIC has no CONNECT on it. */
export async function checkDatabaseAcls(adminUrl: string, spec: AclSpec): Promise<{ ok: boolean; findings: AclFinding[] }> {
  const names = [spec.controlDb, spec.sharedDb, ...(spec.maintenanceDbs ?? DEFAULT_MAINTENANCE_DBS), ...(spec.schools ?? []).map((s) => s.db_name)].filter(
    (n): n is string => Boolean(n),
  );
  const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT d.datname,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT') AS public_connect
         FROM pg_database d WHERE d.datname = ANY($1)`,
      [names],
    );
    const byName = new Map(rows.map((r) => [r.datname as string, r.public_connect as boolean]));
    const findings: AclFinding[] = names.map((n) => {
      const exists = byName.has(n);
      const pub = byName.get(n) ?? false;
      // An absent optional database (e.g. no shared DB configured) is not a finding.
      return { database: n, exists, public_connect: pub, ok: !pub };
    });
    return { ok: findings.every((f) => f.ok), findings };
  } finally {
    await c.end();
  }
}
