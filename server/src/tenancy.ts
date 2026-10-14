import pg from 'pg';
import type { Config } from './config.js';
import { assertRestrictedRole, type Db } from './db.js';
import { SecretBox } from './secrets.js';

export type SchoolStatus = 'requested' | 'provisioning' | 'active' | 'suspended' | 'offboarding' | 'archived' | 'failed';

export interface RegistryEntry {
  id: string;
  slug: string;
  name: string;
  status: SchoolStatus;
  db_mode: 'shared' | 'dedicated';
  db_host: string | null;
  db_port: number | null;
  db_name: string | null;
  db_role: string | null;
  db_secret_enc: string | null;
  db_secret_pending_enc: string | null;
  provisioning_step: string;
  provisioning_error: string | null;
  admin_email: string | null;
  admin_name: string | null;
  schema_version: string | null;
  migrated_from_shared_at: string | null;
}

export class TenantUnavailableError extends Error {
  constructor(
    public readonly code: 'TENANT_NOT_READY' | 'TENANT_UNAVAILABLE' | 'SCHOOL_SUSPENDED' | 'SCHOOL_OFFBOARDED',
    message: string,
  ) {
    super(message);
  }
}

export const REGISTRY_COLUMNS = `id, slug, name, status, db_mode, db_host, db_port, db_name, db_role, db_secret_enc, db_secret_pending_enc,
  provisioning_step, provisioning_error, admin_email::text AS admin_email, admin_name, schema_version, migrated_from_shared_at`;

interface PoolSlot {
  pool: Db;
  secretFingerprint: string;
}

/**
 * Trusted server-side mapping from an authenticated school identity to its database.
 * Nothing in here is ever derived from request data except a lookup key (slug or school id),
 * which is only used to FIND a registry row; the connection details come exclusively from that row.
 */
export class TenantRouter {
  private pools = new Map<string, PoolSlot>();
  private connecting = new Map<string, Promise<Db>>();
  private cache = new Map<string, { at: number; entry: RegistryEntry | null }>();

  constructor(
    private control: Db,
    private secrets: SecretBox,
    private opts: { sharedPool?: Db; maxPools: number; poolMax: number; cacheMs: number; ssl: boolean },
  ) {}

  private async load(key: 'id' | 'slug', value: string): Promise<RegistryEntry | null> {
    const ck = `${key}:${value}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < this.opts.cacheMs) return hit.entry;
    const { rows } = await this.control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE ${key} = $1`, [value]);
    const entry = (rows[0] as RegistryEntry | undefined) ?? null;
    this.cache.set(ck, { at: Date.now(), entry });
    return entry;
  }

  bySlug = (slug: string) => this.load('slug', slug);
  byId = (id: string) => this.load('id', id);

  /** Drop cached registry rows and close pools (after status change, rotation, cutover). */
  async invalidate(schoolId?: string): Promise<void> {
    this.cache.clear();
    const ids = schoolId ? [schoolId] : [...this.pools.keys()];
    for (const id of ids) {
      const s = this.pools.get(id);
      if (s) {
        this.pools.delete(id);
        await s.pool.end().catch(() => undefined);
      }
    }
  }

  /** Throws if a school must not receive authenticated traffic at all. */
  assertRoutable(e: RegistryEntry): void {
    if (e.status === 'active') return;
    if (e.status === 'suspended') throw new TenantUnavailableError('SCHOOL_SUSPENDED', 'This school account is suspended');
    if (e.status === 'offboarding' || e.status === 'archived') throw new TenantUnavailableError('SCHOOL_OFFBOARDED', 'This school account is no longer active');
    throw new TenantUnavailableError('TENANT_NOT_READY', 'This school is not ready yet');
  }

  async poolFor(e: RegistryEntry): Promise<Db> {
    if (e.db_mode === 'shared') {
      if (!this.opts.sharedPool) throw new TenantUnavailableError('TENANT_UNAVAILABLE', 'Shared database is not configured');
      return this.opts.sharedPool;
    }
    const fp = `${e.db_secret_enc}|${e.db_secret_pending_enc ?? ''}|${e.db_host}|${e.db_port}|${e.db_name}|${e.db_role}`;
    const slot = this.pools.get(e.id);
    if (slot && slot.secretFingerprint === fp) {
      // refresh LRU position
      this.pools.delete(e.id);
      this.pools.set(e.id, slot);
      return slot.pool;
    }
    if (slot) await this.invalidate(e.id);
    const inflight = this.connecting.get(e.id);
    if (inflight) return inflight;
    const p = this.connect(e, fp).finally(() => this.connecting.delete(e.id));
    this.connecting.set(e.id, p);
    return p;
  }

  private makePool(e: RegistryEntry, password: string): pg.Pool {
    return new pg.Pool({
      host: e.db_host!,
      port: e.db_port!,
      database: e.db_name!,
      user: e.db_role!,
      password,
      max: this.opts.poolMax,
      idleTimeoutMillis: 30_000,
      ...(this.opts.ssl ? { ssl: true } : {}),
    });
  }

  private async connect(e: RegistryEntry, fp: string): Promise<Db> {
    if (!e.db_secret_enc || !e.db_host || !e.db_port || !e.db_name || !e.db_role) {
      throw new TenantUnavailableError('TENANT_NOT_READY', 'School database is not provisioned');
    }
    const candidates: string[] = [];
    try {
      candidates.push(this.secrets.decrypt(e.db_secret_enc, e.id));
      if (e.db_secret_pending_enc) candidates.push(this.secrets.decrypt(e.db_secret_pending_enc, e.id));
    } catch {
      throw new TenantUnavailableError('TENANT_UNAVAILABLE', 'School database credentials cannot be decrypted');
    }
    let lastErr: unknown;
    for (const pw of candidates) {
      const pool = this.makePool(e, pw);
      pool.on('error', () => undefined);
      try {
        const { rows } = await pool.query<{ d: string; u: string }>('SELECT current_database() AS d, current_user AS u');
        // Defence against registry/credential mix-ups: the connection must land exactly where the registry says.
        if (rows[0]!.d !== e.db_name || rows[0]!.u !== e.db_role) throw new Error('connected to unexpected database or role');
        await assertRestrictedRole(pool);
        this.pools.set(e.id, { pool, secretFingerprint: fp });
        while (this.pools.size > this.opts.maxPools) {
          const oldest = this.pools.keys().next().value as string;
          const s = this.pools.get(oldest)!;
          this.pools.delete(oldest);
          void s.pool.end().catch(() => undefined);
        }
        return pool;
      } catch (err) {
        lastErr = err;
        await pool.end().catch(() => undefined);
        if ((err as { code?: string }).code !== '28P01') break; // only fall back to the pending secret on auth failure
      }
    }
    void lastErr; // never surface connection details to callers
    throw new TenantUnavailableError('TENANT_UNAVAILABLE', 'School database is unavailable');
  }

  async close(): Promise<void> {
    await this.invalidate();
  }

  get openPools(): number {
    return this.pools.size;
  }
}
