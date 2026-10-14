import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLATFORM_COOKIE, parse, platformAuthz, platformOf } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { entitlementOf, storedStatusFor, type SubscriptionRow } from '../entitlements.js';
import { burnPasswordCheck, hashToken, newSessionToken, verifyPassword } from '../passwords.js';
import { platformAudit, recordPayment, registerSchool, SLUG_RE } from '../registry.js';
import { REGISTRY_COLUMNS } from '../tenancy.js';
import { validateBranding } from '../branding.js';

const id = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SAFE_COLUMNS = `s.id, s.slug, s.name, s.status, s.db_mode, s.db_name, s.provisioning_step, s.provisioning_error, s.schema_version, s.migrated_from_shared_at, s.created_at`;

/** Platform (Petra staff) API. Uses ONLY the control plane: no school database credential is ever used here. */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const { control, config, router, entitlements } = app.deps;
  const guard = { preHandler: platformAuthz(app) };

  // ------------------------------------------------------------------ authentication
  app.post('/platform/auth/login', { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }), req.body);
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const a = (await control.query(`SELECT id, password_hash, status, locked_until FROM platform_admins WHERE email = $1`, [b.email])).rows[0];
    if (!a) {
      await burnPasswordCheck(b.password);
      throw fail();
    }
    const locked = a.locked_until && new Date(a.locked_until) > new Date();
    const ok = await verifyPassword(a.password_hash, b.password);
    if (locked || a.status !== 'active' || !ok) {
      if (!ok && !locked && a.status === 'active') {
        await control.query(
          `UPDATE platform_admins SET failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
          [a.id, config.LOGIN_MAX_FAILURES, config.LOGIN_LOCK_MINUTES],
        );
      }
      throw fail();
    }
    const token = newSessionToken();
    await control.query(`UPDATE platform_admins SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [a.id]);
    await control.query(`INSERT INTO platform_sessions (token_hash, admin_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))`, [
      hashToken(token),
      a.id,
      config.SESSION_TTL_HOURS,
    ]);
    await control.query(`DELETE FROM platform_sessions WHERE id IN (SELECT id FROM platform_sessions WHERE admin_id = $1 ORDER BY created_at DESC OFFSET $2)`, [
      a.id,
      config.MAX_SESSIONS_PER_USER,
    ]);
    reply.setCookie(PLATFORM_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: '/api/platform',
      maxAge: config.SESSION_TTL_HOURS * 3600,
    });
    await platformAudit(control, { actorId: a.id, action: 'platform.login', entityType: 'session' });
    return { admin: { id: a.id, email: b.email } };
  });

  app.post('/platform/auth/logout', guard, async (req, reply) => {
    await control.query('DELETE FROM platform_sessions WHERE id = $1', [platformOf(req).sessionId]);
    reply.clearCookie(PLATFORM_COOKIE, { path: '/api/platform' });
    return { ok: true };
  });
  app.get('/platform/auth/me', guard, async (req) => {
    const p = platformOf(req);
    return { admin: { id: p.adminId, email: p.email, full_name: p.fullName } };
  });

  // ------------------------------------------------------------------ schools
  app.get('/platform/schools', guard, async () => {
    const rows = (
      await control.query(
        `SELECT ${SAFE_COLUMNS}, b.display_name, sub.plan_code, sub.status AS sub_status, sub.period_end, sub.grace_days, sub.readonly_days, sub.retention_days, sub.legal_hold
           FROM schools s LEFT JOIN school_branding b ON b.school_id = s.id LEFT JOIN subscriptions sub ON sub.school_id = s.id ORDER BY s.created_at DESC`,
      )
    ).rows;
    const today = entitlements.today();
    return {
      items: rows.map((r) => {
        const e = entitlementOf(
          r.plan_code
            ? ({
                status: r.sub_status,
                period_end: r.period_end,
                grace_days: r.grace_days,
                readonly_days: r.readonly_days,
                retention_days: r.retention_days,
                legal_hold: r.legal_hold,
              } as SubscriptionRow)
            : null,
          today,
        );
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          status: r.status,
          db_mode: r.db_mode,
          provisioning_step: r.provisioning_step,
          provisioning_error: r.provisioning_error,
          schema_version: r.schema_version,
          plan: r.plan_code,
          period_end: r.period_end,
          access_level: e.level,
          subscription_status: e.status,
        };
      }),
    };
  });

  // Registration only records the school. The database is created by the operator-run provisioning workflow
  // (`npm run school:provision`), which holds the privileged credential — the API process never does.
  app.post('/platform/schools', guard, async (req, reply) => {
    const b = parse(
      z.object({
        slug: z.string().regex(SLUG_RE),
        name: z.string().min(2).max(200),
        admin_email: z.string().email().max(254),
        admin_name: z.string().min(1).max(200),
        plan: z.enum(['monthly', 'annual']).default('monthly'),
      }),
      req.body,
    );
    let r;
    try {
      r = await registerSchool(control, {
        slug: b.slug,
        name: b.name,
        adminEmail: b.admin_email,
        adminName: b.admin_name,
        createdBy: platformOf(req).adminId,
        today: entitlements.today(),
        trialDays: config.TRIAL_DAYS,
        plan: b.plan,
      });
    } catch (e) {
      if ((e as Error).message.includes('reserved') || (e as Error).message.includes('invalid'))
        throw new AppError(400, 'INVALID_SLUG', 'Slug is invalid or reserved');
      throw e;
    }
    return reply.status(201).send({ id: r.id, slug: b.slug, status: 'requested', next_step: 'An operator must run: npm run school:provision -- ' + b.slug });
  });

  app.get('/platform/schools/:id', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const s = (await control.query(`SELECT ${SAFE_COLUMNS}, s.admin_email::text AS admin_email FROM schools s WHERE s.id = $1`, [sid])).rows[0];
    if (!s) throw notFound('School');
    return s;
  });

  // Only reversible operational states are exposed here; offboarding/deletion is an operator procedure.
  app.patch('/platform/schools/:id/status', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    const cur = (await control.query(`SELECT ${REGISTRY_COLUMNS} FROM schools WHERE id = $1`, [sid])).rows[0];
    if (!cur) throw notFound('School');
    if (!['active', 'suspended'].includes(cur.status))
      throw new AppError(409, 'INVALID_STATE', `School is "${cur.status}"; only active/suspended schools can be toggled`);
    await control.query(`UPDATE schools SET status = $2 WHERE id = $1`, [sid, status]);
    await platformAudit(control, {
      actorId: platformOf(req).adminId,
      schoolId: sid,
      action: 'school.status',
      entityType: 'school',
      entityId: sid,
      metadata: { from: cur.status, to: status },
    });
    await router.invalidate(sid);
    return { id: sid, status };
  });

  // ------------------------------------------------------------------ branding
  app.put('/platform/schools/:id/branding', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const b = validateBranding(req.body);
    const r = await control.query(
      `UPDATE school_branding SET display_name = $2, logo_url = $3, primary_color = $4, accent_color = $5 WHERE school_id = $1 RETURNING display_name, logo_url, primary_color, accent_color`,
      [sid, b.display_name, b.logo_url, b.primary_color, b.accent_color],
    );
    if (!r.rows[0]) throw notFound('School');
    await platformAudit(control, { actorId: platformOf(req).adminId, schoolId: sid, action: 'branding.update', entityType: 'branding', entityId: sid });
    return r.rows[0];
  });

  // ------------------------------------------------------------------ subscription
  const subOf = async (sid: string) => {
    const r = (await control.query(`SELECT * FROM subscriptions WHERE school_id = $1`, [sid])).rows[0];
    if (!r) throw notFound('Subscription');
    return r;
  };
  const subView = (r: any) => ({ ...r, entitlement: entitlementOf(r, entitlements.today()) });

  app.get('/platform/schools/:id/subscription', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const pay = (
      await control.query(
        `SELECT plan_code, amount_minor, currency, method, reference, received_on, period_start, period_end, created_at FROM subscription_payments WHERE school_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [sid],
      )
    ).rows;
    const ev = (
      await control.query(
        `SELECT event, from_status, to_status, note, created_at FROM subscription_events WHERE school_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [sid],
      )
    ).rows;
    return { subscription: subView(await subOf(sid)), payments: pay, events: ev };
  });

  app.post('/platform/schools/:id/subscription/payments', guard, async (req, reply) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const b = parse(
      z.object({
        plan: z.enum(['monthly', 'annual']),
        amount_minor: z.number().int().min(0),
        currency: z.string().regex(/^[A-Z]{3}$/),
        method: z.string().min(1).max(40),
        reference: z.string().min(1).max(100),
        received_on: date,
      }),
      req.body,
    );
    await subOf(sid);
    const r = await recordPayment(control, {
      schoolId: sid,
      plan: b.plan,
      amountMinor: b.amount_minor,
      currency: b.currency,
      method: b.method,
      reference: b.reference,
      receivedOn: b.received_on,
      actorId: platformOf(req).adminId,
      today: entitlements.today(),
    });
    entitlements.invalidate(sid);
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  const setStatus = async (sid: string, actor: string, to: 'suspended' | 'active' | 'cancelled', event: string, note: string | null) => {
    const cur = await subOf(sid);
    await control.query(
      `UPDATE subscriptions SET status = $2, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END WHERE school_id = $1`,
      [sid, to],
    );
    await control.query(`INSERT INTO subscription_events (school_id, event, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)`, [
      sid,
      event,
      cur.status,
      to,
      actor,
      note,
    ]);
    await platformAudit(control, {
      actorId: actor,
      schoolId: sid,
      action: `subscription.${event}`,
      entityType: 'subscription',
      entityId: cur.id,
      metadata: { note },
    });
    entitlements.invalidate(sid);
    return subView(await subOf(sid));
  };
  const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
  app.post('/platform/schools/:id/subscription/suspend', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    return setStatus(sid, platformOf(req).adminId, 'suspended', 'suspended', parse(reasonBody, req.body).reason);
  });
  // Reinstating recomputes status from dates (an expired period stays read-only/blocked until paid).
  app.post('/platform/schools/:id/subscription/reinstate', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const reason = parse(reasonBody, req.body).reason;
    const cur = await subOf(sid);
    if (cur.status !== 'suspended') throw new AppError(409, 'NOT_SUSPENDED', 'Subscription is not manually suspended');
    const eff = entitlementOf({ ...cur, status: 'active' }, entitlements.today());
    return setStatus(sid, platformOf(req).adminId, 'active', 'reinstated', `${reason} (access now: ${eff.level})`);
  });
  app.post('/platform/schools/:id/subscription/cancel', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    return setStatus(sid, platformOf(req).adminId, 'cancelled', 'cancelled', 'no renewal; access continues to period end');
  });
  app.patch('/platform/schools/:id/subscription/terms', guard, async (req) => {
    const { id: sid } = parse(z.object({ id }), req.params);
    const b = parse(
      z
        .object({
          grace_days: z.number().int().min(0).max(90),
          readonly_days: z.number().int().min(0).max(365),
          retention_days: z.number().int().min(0).max(3650),
          legal_hold: z.boolean(),
        })
        .partial()
        .refine((x) => Object.keys(x).length > 0, 'nothing to update'),
      req.body,
    );
    await subOf(sid);
    const cols = Object.keys(b);
    await control.query(`UPDATE subscriptions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE school_id = $1`, [sid, ...Object.values(b)]);
    await platformAudit(control, { actorId: platformOf(req).adminId, schoolId: sid, action: 'subscription.terms', entityType: 'subscription', metadata: b });
    entitlements.invalidate(sid);
    return subView(await subOf(sid));
  });

  // ------------------------------------------------------------------ releases and build profiles
  app.get('/platform/releases', guard, async () => ({
    items: (await control.query(`SELECT version, channel, min_supported_version, notes, created_at FROM app_releases ORDER BY created_at DESC LIMIT 50`)).rows,
  }));
  app.post('/platform/releases', guard, async (req, reply) => {
    const b = parse(
      z.object({
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        channel: z.enum(['stable', 'beta']).default('stable'),
        min_supported_version: z.string().regex(/^\d+\.\d+\.\d+$/),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    await control.query(`INSERT INTO app_releases (version, channel, min_supported_version, notes, published_by) VALUES ($1,$2,$3,$4,$5)`, [
      b.version,
      b.channel,
      b.min_supported_version,
      b.notes ?? null,
      platformOf(req).adminId,
    ]);
    await platformAudit(control, { actorId: platformOf(req).adminId, action: 'release.publish', entityType: 'release', entityId: b.version });
    return reply.status(201).send(b);
  });
  app.put('/platform/schools/:id/build-profiles/:platform', guard, async (req) => {
    const p = parse(z.object({ id, platform: z.enum(['android', 'windows', 'linux']) }), req.params);
    const b = parse(
      z.object({
        app_id: z
          .string()
          .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/)
          .max(100),
        app_name: z.string().min(2).max(40),
      }),
      req.body,
    );
    const r = await control.query(
      `INSERT INTO school_build_profiles (school_id, platform, app_id, app_name) SELECT s.id,$2,$3,$4 FROM schools s WHERE s.id = $1
       ON CONFLICT (school_id, platform) DO UPDATE SET app_id = EXCLUDED.app_id, app_name = EXCLUDED.app_name RETURNING platform, app_id, app_name`,
      [p.id, p.platform, b.app_id, b.app_name],
    );
    if (!r.rows[0]) throw notFound('School');
    await platformAudit(control, {
      actorId: platformOf(req).adminId,
      schoolId: p.id,
      action: 'build_profile.set',
      entityType: 'build_profile',
      entityId: p.platform,
    });
    return r.rows[0];
  });

  app.get('/platform/audit', guard, async () => ({
    items: (
      await control.query(
        `SELECT id, actor_id, school_id, action, entity_type, entity_id, metadata, created_at FROM platform_audit_events ORDER BY created_at DESC LIMIT 200`,
      )
    ).rows,
  }));
  void storedStatusFor;
}
