import type { Db } from './db.js';
import { entitlementOf, storedStatusFor, type SubscriptionRow } from './entitlements.js';
import { platformAudit } from './registry.js';

/**
 * Records derived status transitions (trial → past_due → expired → suspended) in the stored status and event log.
 * Purely informational/reporting: access control never depends on it (see entitlements.ts), and it never deletes data.
 * Idempotent: running it twice on the same day changes nothing.
 */
export async function sweepSubscriptions(control: Db, today: string): Promise<{ checked: number; changed: { school_id: string; from: string; to: string }[] }> {
  const { rows } = await control.query(`SELECT school_id, status, period_end, grace_days, readonly_days, retention_days, legal_hold FROM subscriptions`);
  const changed: { school_id: string; from: string; to: string }[] = [];
  for (const r of rows) {
    const e = entitlementOf(r as SubscriptionRow, today);
    const to = storedStatusFor(e, r.status);
    // 'suspended' derived from lapse is stored as 'suspended' only for reporting; manual vs lapsed is told apart by the event note.
    if (to !== r.status) {
      const u = await control.query(`UPDATE subscriptions SET status = $2 WHERE school_id = $1 AND status = $3`, [r.school_id, to, r.status]);
      if (u.rowCount) {
        await control.query(`INSERT INTO subscription_events (school_id, event, from_status, to_status, note) VALUES ($1,'status_derived',$2,$3,$4)`, [r.school_id, r.status, to, `sweep ${today}: ${e.reason}`]);
        await platformAudit(control, { actorId: null, schoolId: r.school_id, action: 'subscription.sweep', entityType: 'subscription', metadata: { from: r.status, to, reason: e.reason } });
        changed.push({ school_id: r.school_id, from: r.status, to });
      }
    }
  }
  return { checked: rows.length, changed };
}
