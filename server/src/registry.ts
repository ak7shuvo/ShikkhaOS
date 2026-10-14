import './db.js'; // registers pg type parsers (dates as strings, numeric as number)
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from './db.js';
import { addDays, addMonths, renewalPeriod, type StoredStatus } from './entitlements.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const RESERVED_SLUGS = new Set(['admin', 'api', 'platform', 'www', 'petra', 'static', 'assets', 'login', 'app']);

export interface RegisterInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminName: string;
  createdBy: string | null;
  today: string;
  trialDays: number;
  plan?: string;
  /** Registry row for an EXISTING Phase 1 school living in the shared database (migration/rollback path only). */
  shared?: { schoolId: string };
}

export async function platformAudit(db: Db | Tx, e: { actorId: string | null; schoolId?: string | null; action: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown> }) {
  await db.query(`INSERT INTO platform_audit_events (actor_id, school_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`, [
    e.actorId,
    e.schoolId ?? null,
    e.action,
    e.entityType,
    e.entityId ?? null,
    JSON.stringify(e.metadata ?? {}),
  ]);
}

/** Registers a school (registry + default branding + trial subscription) in one transaction. Does NOT create a database. */
export async function registerSchool(control: Db, i: RegisterInput): Promise<{ id: string }> {
  if (!SLUG_RE.test(i.slug) || RESERVED_SLUGS.has(i.slug)) throw new Error('invalid or reserved slug');
  const id = i.shared?.schoolId ?? randomUUID();
  const c = await control.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO schools (id, slug, name, status, db_mode, provisioning_step, admin_email, admin_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, i.slug, i.name, i.shared ? 'active' : 'requested', i.shared ? 'shared' : 'dedicated', i.shared ? 'active' : 'requested', i.adminEmail, i.adminName, i.createdBy],
    );
    await c.query(`INSERT INTO school_branding (school_id, display_name) VALUES ($1,$2)`, [id, i.name]);
    const trialEnd = addDays(i.today, Math.max(i.trialDays, 1) - 1);
    await c.query(`INSERT INTO subscriptions (school_id, plan_code, status, period_start, period_end) VALUES ($1,$2,'trial',$3,$4)`, [id, i.plan ?? 'monthly', i.today, trialEnd]);
    await c.query(`INSERT INTO subscription_events (school_id, event, to_status, actor_id, note) VALUES ($1,'trial_started','trial',$2,$3)`, [id, i.createdBy, `trial until ${trialEnd}`]);
    await platformAudit(c, { actorId: i.createdBy, schoolId: id, action: 'school.register', entityType: 'school', entityId: id, metadata: { slug: i.slug, mode: i.shared ? 'shared' : 'dedicated' } });
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { id };
}

export interface PaymentInput {
  schoolId: string;
  plan: string;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string;
  receivedOn: string;
  actorId: string | null;
  today: string;
}

/**
 * Records a manual payment and renews the subscription. Idempotent on (school, reference):
 * replaying the same reference returns the original result and never extends twice.
 */
export async function recordPayment(control: Db, p: PaymentInput): Promise<{ replayed: boolean; period_start: string; period_end: string }> {
  const c = await control.connect();
  try {
    await c.query('BEGIN');
    const sub = (await c.query(`SELECT id, status, period_end FROM subscriptions WHERE school_id = $1 FOR UPDATE`, [p.schoolId])).rows[0];
    if (!sub) throw new Error('subscription not found');
    const dup = (await c.query(`SELECT period_start, period_end FROM subscription_payments WHERE school_id = $1 AND reference = $2`, [p.schoolId, p.reference])).rows[0];
    if (dup) {
      await c.query('ROLLBACK');
      return { replayed: true, period_start: dup.period_start, period_end: dup.period_end };
    }
    const plan = (await c.query(`SELECT period_months FROM plans WHERE code = $1 AND active`, [p.plan])).rows[0];
    if (!plan) throw new Error('unknown plan');
    const per = renewalPeriod(sub.period_end, p.today, plan.period_months);
    // Trial period_end is a trial end, not a paid end: first payment starts today (or after, if trial still running).
    await c.query(
      `INSERT INTO subscription_payments (school_id, plan_code, amount_minor, currency, method, reference, received_on, period_start, period_end, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.schoolId, p.plan, p.amountMinor, p.currency, p.method, p.reference, p.receivedOn, per.start, per.end, p.actorId],
    );
    // A manual suspension is an explicit decision: payment never silently lifts it.
    const newStatus: StoredStatus = sub.status === 'suspended' ? 'suspended' : 'active';
    await c.query(`UPDATE subscriptions SET plan_code = $2, status = $3, period_end = $4, period_start = CASE WHEN $5::date > period_end THEN $5::date ELSE period_start END, cancelled_at = NULL WHERE school_id = $1`, [p.schoolId, p.plan, newStatus, per.end, per.start]);
    await c.query(`INSERT INTO subscription_events (school_id, event, from_status, to_status, actor_id, note) VALUES ($1,'payment_recorded',$2,$3,$4,$5)`, [p.schoolId, sub.status, newStatus, p.actorId, `${p.plan} ${per.start}..${per.end} ref ${p.reference}`]);
    await platformAudit(c, { actorId: p.actorId, schoolId: p.schoolId, action: 'subscription.payment', entityType: 'subscription', entityId: sub.id, metadata: { plan: p.plan, reference: p.reference, period: [per.start, per.end] } });
    await c.query('COMMIT');
    return { replayed: false, period_start: per.start, period_end: per.end };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export { addMonths };
