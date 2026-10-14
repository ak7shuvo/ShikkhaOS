/**
 * Pure subscription entitlement logic. Everything is derived from dates, so enforcement never
 * depends on a background job. Dates are calendar dates ('YYYY-MM-DD') in the billing timezone.
 *
 * Let `end` = subscription.period_end (the LAST day of full access of the paid/trial period),
 * and d = today - end in whole days:
 *   d <= 0                              full       (trial | active | cancelled-until-end)
 *   1 .. grace_days                     grace      full access + warnings   (effective status past_due)
 *   grace_days+1 .. +readonly_days      read_only  reads + export only      (effective status expired)
 *   beyond                              blocked    school users locked out  (effective status suspended)
 * A manual 'suspended' status is blocked immediately. Data is NEVER deleted by this logic; see
 * retention_until and legal_hold for offboarding eligibility.
 */
export type AccessLevel = 'full' | 'grace' | 'read_only' | 'blocked';
export type StoredStatus = 'trial' | 'active' | 'past_due' | 'expired' | 'suspended' | 'cancelled';
export type EffectiveStatus = 'trial' | 'active' | 'cancelled' | 'past_due' | 'expired' | 'suspended';

export interface SubscriptionRow {
  status: StoredStatus;
  period_end: string;
  grace_days: number;
  readonly_days: number;
  retention_days: number;
  legal_hold: boolean;
}

export interface Entitlement {
  level: AccessLevel;
  status: EffectiveStatus;
  reason: 'in_period' | 'grace_period' | 'read_only_period' | 'lapsed' | 'manual_suspension' | 'no_subscription';
  days_past_end: number;
  full_access_until: string;
  read_only_until: string;
  retention_until: string;
  deletion_allowed_from: string | null;
  warning: null | { code: 'RENEWAL_OVERDUE' | 'READ_ONLY' | 'BLOCKED'; message: string };
}

const MS = 86_400_000;
const parse = (d: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`invalid date ${d}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
};
export const daysBetween = (from: string, to: string): number => Math.round((parse(to) - parse(from)) / MS);
export const addDays = (d: string, n: number): string => new Date(parse(d) + n * MS).toISOString().slice(0, 10);

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: string, months: number): string {
  const t = new Date(parse(d));
  const day = t.getUTCDate();
  const target = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Today's calendar date in an IANA timezone. */
export function todayIn(tz: string, now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p;
}

export function entitlementOf(sub: SubscriptionRow | null, today: string): Entitlement {
  if (!sub) {
    return { level: 'blocked', status: 'suspended', reason: 'no_subscription', days_past_end: 0, full_access_until: today, read_only_until: today, retention_until: today, deletion_allowed_from: null, warning: { code: 'BLOCKED', message: 'No subscription on record' } };
  }
  const d = daysBetween(sub.period_end, today);
  const fullUntil = addDays(sub.period_end, sub.grace_days);
  const roUntil = addDays(fullUntil, sub.readonly_days);
  const retention = addDays(sub.period_end, sub.retention_days);
  // Deletion is only ever eligible after retention AND with no legal hold; it still needs an explicit offboarding.
  const base = { days_past_end: d, full_access_until: fullUntil, read_only_until: roUntil, retention_until: retention, deletion_allowed_from: sub.legal_hold ? null : addDays(retention, 1) };

  if (sub.status === 'suspended') {
    return { ...base, level: 'blocked', status: 'suspended', reason: 'manual_suspension', warning: { code: 'BLOCKED', message: 'Account suspended by Petra Software Solution' } };
  }
  if (d <= 0) {
    const status: EffectiveStatus = sub.status === 'trial' ? 'trial' : sub.status === 'cancelled' ? 'cancelled' : 'active';
    return { ...base, level: 'full', status, reason: 'in_period', warning: null };
  }
  if (d <= sub.grace_days) {
    return { ...base, level: 'grace', status: 'past_due', reason: 'grace_period', warning: { code: 'RENEWAL_OVERDUE', message: `Subscription ended ${d} day(s) ago. Full access continues until ${fullUntil}.` } };
  }
  if (d <= sub.grace_days + sub.readonly_days) {
    return { ...base, level: 'read_only', status: 'expired', reason: 'read_only_period', warning: { code: 'READ_ONLY', message: `Subscription expired. Read-only access and data export until ${roUntil}.` } };
  }
  return { ...base, level: 'blocked', status: 'suspended', reason: 'lapsed', warning: { code: 'BLOCKED', message: `Access suspended. Your data is preserved until at least ${retention}; contact Petra Software Solution.` } };
}

/** Which stored status best reflects an effective one (used by the sweeper for reporting). */
export const storedStatusFor = (e: Entitlement, current: StoredStatus): StoredStatus => (current === 'suspended' ? 'suspended' : e.status === 'cancelled' ? 'cancelled' : e.status);

/** New period when a payment is recorded. Renewal before the end extends seamlessly; after lapse it starts today. */
export function renewalPeriod(currentEnd: string | null, today: string, months: number): { start: string; end: string } {
  const start = currentEnd !== null && daysBetween(today, currentEnd) >= 0 ? addDays(currentEnd, 1) : today;
  return { start, end: addDays(addMonths(start, months), -1) };
}

/** HTTP methods allowed in read_only mode. */
export const READ_ONLY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
