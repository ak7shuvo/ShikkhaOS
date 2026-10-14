import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, entitlementOf, renewalPeriod, todayIn, type SubscriptionRow } from '../src/entitlements.js';

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: 'active',
  period_end: '2026-03-31',
  grace_days: 7,
  readonly_days: 30,
  retention_days: 90,
  legal_hold: false,
  ...over,
});
const at = (offset: number, s = sub()) => entitlementOf(s, addDays(s.period_end, offset));

describe('exact date boundaries (7 grace, 30 read-only, 90 retention)', () => {
  it('last paid day and earlier are full access', () => {
    expect(at(-30).level).toBe('full');
    expect(at(0)).toMatchObject({ level: 'full', status: 'active', warning: null });
  });
  it('days 1..7 are grace: full access with a warning', () => {
    expect(at(1)).toMatchObject({ level: 'grace', status: 'past_due', warning: { code: 'RENEWAL_OVERDUE' } });
    expect(at(7).level).toBe('grace');
  });
  it('days 8..37 are read-only', () => {
    expect(at(8)).toMatchObject({ level: 'read_only', status: 'expired', warning: { code: 'READ_ONLY' } });
    expect(at(37).level).toBe('read_only');
  });
  it('day 38 onward is blocked, and stays blocked (data is preserved, never auto-deleted)', () => {
    expect(at(38)).toMatchObject({ level: 'blocked', status: 'suspended', reason: 'lapsed' });
    expect(at(400).level).toBe('blocked');
  });
  it('reports the derived dates', () => {
    const e = at(0);
    expect(e.full_access_until).toBe('2026-04-07');
    expect(e.read_only_until).toBe('2026-05-07');
    expect(e.retention_until).toBe('2026-06-29');
    expect(e.deletion_allowed_from).toBe('2026-06-30');
  });
  it('legal hold removes deletion eligibility', () => {
    expect(at(0, sub({ legal_hold: true })).deletion_allowed_from).toBeNull();
  });
  it('honours custom grace and read-only windows, including zero', () => {
    const s = sub({ grace_days: 0, readonly_days: 0 });
    expect(at(0, s).level).toBe('full');
    expect(at(1, s).level).toBe('blocked');
    const s2 = sub({ grace_days: 3, readonly_days: 2 });
    expect([at(3, s2).level, at(4, s2).level, at(5, s2).level, at(6, s2).level]).toEqual(['grace', 'read_only', 'read_only', 'blocked']);
  });
});

describe('statuses', () => {
  it('trial and cancelled are full until period end, then follow the same timeline', () => {
    expect(at(-1, sub({ status: 'trial' })).status).toBe('trial');
    expect(at(-1, sub({ status: 'cancelled' })).status).toBe('cancelled');
    expect(at(1, sub({ status: 'trial' })).level).toBe('grace');
    expect(at(10, sub({ status: 'cancelled' })).level).toBe('read_only');
  });
  it('manual suspension blocks immediately even inside the paid period', () => {
    expect(at(-100, sub({ status: 'suspended' }))).toMatchObject({ level: 'blocked', reason: 'manual_suspension' });
  });
  it('no subscription means blocked', () => {
    expect(entitlementOf(null, '2026-01-01').level).toBe('blocked');
  });
  it('stored past_due/expired do not override dates (a renewal that moved period_end wins)', () => {
    expect(at(-5, sub({ status: 'expired' })).level).toBe('full');
    expect(at(-5, sub({ status: 'past_due' })).status).toBe('active');
  });
});

describe('date helpers', () => {
  it('daysBetween/addDays are calendar exact across leap years and year ends', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('addMonths clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-15', 12)).toBe('2027-03-15');
  });
  it('todayIn uses the requested timezone', () => {
    const t = new Date('2026-03-31T20:00:00Z'); // already April 1 in Dhaka (UTC+6)
    expect(todayIn('Asia/Dhaka', t)).toBe('2026-04-01');
    expect(todayIn('UTC', t)).toBe('2026-03-31');
  });
});

describe('renewal periods', () => {
  it('early renewal extends seamlessly from the day after the current end', () => {
    expect(renewalPeriod('2026-03-31', '2026-03-20', 1)).toEqual({ start: '2026-04-01', end: '2026-04-30' });
    expect(renewalPeriod('2026-03-31', '2026-03-31', 12)).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });
  it('late renewal starts today (no free back-dated period)', () => {
    expect(renewalPeriod('2026-03-31', '2026-04-10', 1)).toEqual({ start: '2026-04-10', end: '2026-05-09' });
  });
  it('first period starts today', () => {
    expect(renewalPeriod(null, '2026-05-01', 1)).toEqual({ start: '2026-05-01', end: '2026-05-31' });
  });
});
