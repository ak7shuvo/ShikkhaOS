import type { Db } from './db.js';
import { entitlementOf, todayIn, type Entitlement, type SubscriptionRow } from './entitlements.js';

/** Reads a school's subscription from the control plane and derives its access level (short cache). */
export class EntitlementService {
  private cache = new Map<string, { at: number; value: Entitlement }>();
  constructor(
    private control: Db,
    private opts: { cacheMs: number; timezone: string; now: () => Date },
  ) {}

  today(): string {
    return todayIn(this.opts.timezone, this.opts.now());
  }

  async get(schoolId: string): Promise<Entitlement> {
    const hit = this.cache.get(schoolId);
    if (hit && Date.now() - hit.at < this.opts.cacheMs) return hit.value;
    const { rows } = await this.control.query<SubscriptionRow>(
      `SELECT status, period_end, grace_days, readonly_days, retention_days, legal_hold FROM subscriptions WHERE school_id = $1`,
      [schoolId],
    );
    const value = entitlementOf(rows[0] ?? null, this.today());
    this.cache.set(schoolId, { at: Date.now(), value });
    return value;
  }

  invalidate(schoolId?: string): void {
    if (schoolId) this.cache.delete(schoolId);
    else this.cache.clear();
  }
}
