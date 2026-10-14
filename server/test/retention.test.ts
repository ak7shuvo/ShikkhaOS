import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, entitlementOf, MIN_RETENTION_DAYS, type SubscriptionRow } from '../src/entitlements.js';
import { finalizeOffboarding, startOffboarding } from '../src/operations.js';
import { dbNameFor, provisionSchool } from '../src/provisioning.js';
import { hashPassword } from '../src/passwords.js';
import { controlFixture, registerNew, today, type ControlFixture } from './fixtures.js';
import { Client, harness, PASSWORD, seed, type Harness } from './helpers.js';

let h: Harness;
let f: ControlFixture;
let platform: Client;

beforeAll(async () => {
  h = await harness();
  f = await controlFixture();
  const email = `ret-root-${Date.now()}@petra.example.test`;
  await h.control.query(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1,$2,'Root')`, [email, await hashPassword(PASSWORD)]);
  platform = new Client(h.app);
  expect((await platform.req('POST', '/platform/auth/login', { email, password: PASSWORD })).status).toBe(200);
});
afterAll(async () => {
  await f.close();
  await h.close();
});

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: 'active',
  period_end: '2026-03-31',
  grace_days: 7,
  readonly_days: 30,
  retention_days: 90,
  legal_hold: false,
  ...over,
});

describe('code-level minimum retention (90 days)', () => {
  it('the constant matches the documented policy', () => {
    expect(MIN_RETENTION_DAYS).toBe(90);
  });

  it('exact boundary: deletion is first allowed on period_end + 91 days; never earlier', () => {
    const s = sub();
    expect(entitlementOf(s, addDays(s.period_end, 89)).deletion_allowed_from).toBe('2026-06-30');
    for (const d of [0, 1, 89, 90]) expect(entitlementOf(s, addDays(s.period_end, d)).retention_until).toBe('2026-06-29');
    expect(entitlementOf(s, '2026-06-29').deletion_allowed_from).toBe('2026-06-30'); // retention_until is itself still protected
  });

  it('a stored value below the minimum (legacy rows, a dropped CHECK) is clamped in code', () => {
    for (const days of [0, 1, 30, 89]) {
      const e = entitlementOf(sub({ retention_days: days }), '2026-04-01');
      expect(e.retention_until, `retention_days=${days}`).toBe('2026-06-29');
      expect(e.deletion_allowed_from).toBe('2026-06-30');
    }
    expect(entitlementOf(sub({ retention_days: 91 }), '2026-04-01').retention_until).toBe('2026-06-30'); // longer values are honoured
    expect(entitlementOf(sub({ retention_days: 30, legal_hold: true }), '2026-04-01').deletion_allowed_from).toBeNull();
  });
});

describe('platform terms API cannot silently reduce retention', () => {
  const terms = (id: string, body: unknown) => platform.patch(`/platform/schools/${id}/subscription/terms`, body);

  it('89 is rejected, 90 and 3650 are accepted, 3651 and non-integers are rejected', async () => {
    const S = await seed(h, 'ret1');
    const bad = await terms(S.schoolId, { retention_days: 89 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/cannot be below 90/);
    for (const v of [0, 30, -5, 3651, 90.5, '90']) expect((await terms(S.schoolId, { retention_days: v })).status, String(v)).toBe(400);
    expect((await terms(S.schoolId, { retention_days: 90 })).status).toBe(200);
    expect((await terms(S.schoolId, { retention_days: 3650 })).status).toBe(200);
    expect((await h.control.query(`SELECT retention_days FROM subscriptions WHERE school_id = $1`, [S.schoolId])).rows[0].retention_days).toBe(3650);
  });

  it('a rejected request changes nothing and writes no audit record; an accepted one records requested and previous values', async () => {
    const S = await seed(h, 'ret2');
    const audits = async () =>
      (
        await h.control.query(`SELECT metadata FROM platform_audit_events WHERE school_id = $1 AND action = 'subscription.terms' ORDER BY created_at, id`, [
          S.schoolId,
        ])
      ).rows;
    await terms(S.schoolId, { retention_days: 30 });
    expect(await audits()).toHaveLength(0);
    expect((await h.control.query(`SELECT retention_days FROM subscriptions WHERE school_id = $1`, [S.schoolId])).rows[0].retention_days).toBe(90);
    await terms(S.schoolId, { retention_days: 365, grace_days: 3 });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].metadata).toEqual({ requested: { retention_days: 365, grace_days: 3 }, previous: { retention_days: 90, grace_days: 7 } });
  });

  it('a mixed update with one invalid field is rejected as a whole (no partial application)', async () => {
    const S = await seed(h, 'ret3');
    expect((await terms(S.schoolId, { retention_days: 10, legal_hold: true })).status).toBe(400);
    expect((await h.control.query(`SELECT legal_hold FROM subscriptions WHERE school_id = $1`, [S.schoolId])).rows[0].legal_hold).toBe(false);
  });
});

describe('the database refuses a lower value too (bypass audit)', () => {
  it('direct UPDATE and INSERT below 90 or above 3650 violate the CHECK, even for the application role', async () => {
    const S = await seed(h, 'ret4');
    for (const v of [0, 30, 89, 3651]) {
      await expect(h.control.query(`UPDATE subscriptions SET retention_days = $2 WHERE school_id = $1`, [S.schoolId, v]), String(v)).rejects.toThrow(
        /check constraint/,
      );
    }
    await h.control.query(`UPDATE subscriptions SET retention_days = 90 WHERE school_id = $1`, [S.schoolId]);
    const { id } = await registerNew(f, 'ret4b');
    expect((await f.control.query(`SELECT retention_days FROM subscriptions WHERE school_id = $1`, [id])).rows[0].retention_days).toBe(90); // default for new schools
    await expect(
      f.control.query(
        `INSERT INTO subscriptions (school_id, plan_code, status, period_start, period_end, retention_days) VALUES ($1,'monthly','active','2026-01-01','2026-02-01',30)`,
        [S.schoolId],
      ),
    ).rejects.toThrow();
  });
});

describe('offboarding honours the minimum exactly (end to end)', () => {
  const lapse = (id: string, daysAgo: number) =>
    f.control.query(`UPDATE subscriptions SET period_start = $2, period_end = $3 WHERE school_id = $1`, [
      id,
      addDays(today(), -daysAgo - 30),
      addDays(today(), -daysAgo),
    ]);

  it('day 90 after the period end is refused, day 91 is allowed', async () => {
    const { id, slug } = await registerNew(f, 'ret5');
    await provisionSchool(f.deps, id);
    await startOffboarding(f.deps, id, null, 'closing');
    const run = () =>
      finalizeOffboarding(f.deps, id, { confirmSlug: slug, exportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'petra-ret-')), today: today(), actorId: null });

    await lapse(id, 90);
    await expect(run()).rejects.toThrow(/retention window has not elapsed; deletion allowed from/);
    expect((await f.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbNameFor(id)])).rowCount).toBe(1);

    await lapse(id, 91);
    await run();
    expect((await f.admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbNameFor(id)])).rowCount).toBe(0);
  });
});
