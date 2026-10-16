import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authOf, authz, parse, schoolTx } from '../context.js';
import { validateBranding } from '../branding.js';
import { platformAudit } from '../registry.js';
import { gradingBandsSchema } from '../grading.js';
import { SCHOOL_ROLES } from '../rbac.js';
import { PASSWORD_MIN_LENGTH, hashPassword } from '../passwords.js';
import { AppError, notFound } from '../errors.js';

const EXPORT_TABLES = [
  'schools',
  'school_memberships',
  'academic_years',
  'classes',
  'sections',
  'subjects',
  'students',
  'guardian_profiles',
  'student_guardians',
  'enrollments',
  'teacher_assignments',
  'grading_policies',
  'exams',
  'exam_subjects',
  'result_sheets',
  'marks',
  'result_events',
  'result_versions',
  'published_results',
  'audit_events',
];

const settingsSchema = z
  .object({
    default_language: z.enum(['bn', 'en']).optional(),
    timezone: z.string().max(60).optional(),
    result_publication_note: z.string().max(500).optional(),
  })
  .strict();

const profileBody = z
  .object({
    name: z.string().min(2).max(200),
    name_bn: z.string().max(200).nullable(),
    logo_url: z
      .string()
      .url()
      .max(500)
      .regex(/^https?:\/\//)
      .nullable(),
    address: z.string().max(500).nullable(),
    phone: z.string().max(40).nullable(),
    email: z.string().email().max(254).nullable(),
    settings: settingsSchema,
  })
  .partial()
  .strict();

export async function schoolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/school', { preHandler: authz(app, { perm: 'school.view' }) }, async (req) => {
    const school = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(
        `SELECT s.id, s.code, s.name, s.name_bn, s.logo_url, s.address, s.phone, s.email, s.settings, s.status FROM schools s WHERE s.id = $1`,
        [a.schoolId],
      );
      return r.rows[0];
    });
    // Subscription and branding live in the control plane; the school id comes from the authenticated session.
    const a = authOf(req);
    const e = a.entitlement;
    const branding =
      (await app.deps.control.query(`SELECT display_name, logo_url, primary_color, accent_color FROM school_branding WHERE school_id = $1`, [a.entry.id]))
        .rows[0] ?? null;
    return {
      ...school,
      subscription: {
        level: e.level,
        status: e.status,
        warning: e.warning,
        full_access_until: e.full_access_until,
        read_only_until: e.read_only_until,
        retention_until: e.retention_until,
      },
      branding,
    };
  });

  // School admins manage their own branding; the school is the authenticated one, never a request parameter.
  app.put('/school/branding', { preHandler: authz(app, { perm: 'school.manage' }) }, async (req) => {
    const a = authOf(req);
    const b = validateBranding(req.body);
    const r = await app.deps.control.query(
      `UPDATE school_branding SET display_name = $2, logo_url = $3, primary_color = $4, accent_color = $5 WHERE school_id = $1 RETURNING display_name, logo_url, primary_color, accent_color`,
      [a.entry.id, b.display_name, b.logo_url, b.primary_color, b.accent_color],
    );
    await schoolTx(app, req, (tx, x) =>
      audit(tx, { schoolId: x.schoolId, actorUserId: x.userId, action: 'branding.update', entityType: 'branding', entityId: x.schoolId }),
    );
    await platformAudit(app.deps.control, {
      actorId: null,
      schoolId: a.entry.id,
      action: 'branding.update.by_school_admin',
      entityType: 'branding',
      entityId: a.entry.id,
      metadata: { user_id: a.userId },
    });
    return r.rows[0];
  });

  // Data export: allowed while the subscription is in read-only mode (GET). Excludes credentials and sessions.
  app.get('/school/export', { preHandler: authz(app, { perm: 'school.manage' }) }, async (req, reply) => {
    const data = await schoolTx(app, req, async (tx, a) => {
      const out: Record<string, unknown[]> = {};
      for (const t of EXPORT_TABLES) out[t] = (await tx.query(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY 1`)).rows.map((r) => r.r);
      out.users = (
        await tx.query(
          `SELECT jsonb_build_object('id', u.id, 'email', u.email, 'full_name', u.full_name, 'status', u.status, 'preferred_language', u.preferred_language, 'created_at', u.created_at) AS r FROM users u ORDER BY u.email`,
        )
      ).rows.map((r) => r.r);
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'school.export', entityType: 'school', entityId: a.schoolId });
      return out;
    });
    reply.header('Content-Disposition', `attachment; filename="${authOf(req).entry.slug}-export.json"`);
    return { exported_at: new Date().toISOString(), school: authOf(req).entry.slug, format: 1, tables: data };
  });

  // Platform-level fields (code, status, licence) are NOT editable here.
  app.patch('/school', { preHandler: authz(app, { perm: 'school.manage' }) }, async (req) => {
    const b = parse(profileBody, req.body);
    return schoolTx(app, req, async (tx, a) => {
      const cols = Object.keys(b) as (keyof typeof b)[];
      if (!cols.length) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
      const sets = cols.map((c, i) => `${c} = $${i + 2}`);
      const vals = cols.map((c) => (c === 'settings' ? JSON.stringify(b[c]) : b[c]));
      const r = await tx.query(
        `UPDATE schools SET ${sets.join(', ')} WHERE id = $1 RETURNING id, code, name, name_bn, logo_url, address, phone, email, settings`,
        [a.schoolId, ...vals],
      );
      await audit(tx, {
        schoolId: a.schoolId,
        actorUserId: a.userId,
        action: 'school.update',
        entityType: 'school',
        entityId: a.schoolId,
        metadata: { fields: cols },
      });
      return r.rows[0];
    });
  });

  app.get('/school/members', { preHandler: authz(app, { perm: 'members.manage' }) }, async (req) =>
    schoolTx(app, req, async (tx, a) => ({
      items: (
        await tx.query(
          `SELECT m.id, m.role, m.status, u.id AS user_id, u.email, u.full_name
             FROM school_memberships m JOIN users u ON u.id = m.user_id
            WHERE m.school_id = $1 ORDER BY u.full_name`,
          [a.schoolId],
        )
      ).rows,
    })),
  );

  const memberBody = z.object({
    email: z.string().email().max(254),
    full_name: z.string().min(1).max(200),
    initial_password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
    role: z.enum(SCHOOL_ROLES), // 'student' is reserved and rejected by validation
  });

  app.post('/school/members', { preHandler: authz(app, { perm: 'members.manage' }) }, async (req, reply) => {
    const b = parse(memberBody, req.body);
    const pwHash = await hashPassword(b.initial_password);
    const userId = crypto.randomUUID();
    const out = await schoolTx(app, req, async (tx, a) => {
      await tx.query(`INSERT INTO users (id, email, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,$4,true)`, [
        userId,
        b.email,
        pwHash,
        b.full_name,
      ]);
      const m = await tx.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,$3) RETURNING id, role, status`, [
        a.schoolId,
        userId,
        b.role,
      ]);
      await audit(tx, {
        schoolId: a.schoolId,
        actorUserId: a.userId,
        action: 'member.create',
        entityType: 'membership',
        entityId: m.rows[0].id,
        metadata: { role: b.role },
      });
      return { ...m.rows[0], user_id: userId };
    });
    return reply.status(201).send(out);
  });

  app.patch('/school/members/:id', { preHandler: authz(app, { perm: 'members.manage' }) }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'removed']) }), req.body);
    return schoolTx(app, req, async (tx, a) => {
      if (status !== 'active') {
        // Lock every active school_admin row so two concurrent demotions cannot both pass the "last admin" check.
        const admins = (
          await tx.query(`SELECT id, user_id FROM school_memberships WHERE school_id = $1 AND role = 'school_admin' AND status = 'active' FOR UPDATE`, [
            a.schoolId,
          ])
        ).rows;
        const target = admins.find((m) => m.id === id);
        if (target) {
          if (target.user_id === a.userId) throw new AppError(409, 'CANNOT_CHANGE_SELF', 'Administrators cannot suspend or remove their own membership');
          if (admins.length <= 1) throw new AppError(409, 'LAST_ADMIN', 'The last active school administrator cannot be suspended or removed');
        }
      }
      const r = await tx.query(`UPDATE school_memberships SET status = $3 WHERE id = $1 AND school_id = $2 RETURNING id, role, status`, [
        id,
        a.schoolId,
        status,
      ]);
      if (!r.rows[0]) throw notFound('Member');
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'member.status', entityType: 'membership', entityId: id, metadata: { status } });
      return r.rows[0];
    });
  });

  // Grading policies are school configuration; immutable once created.
  app.get('/school/grading-policies', { preHandler: authz(app, { perm: 'academic.view' }) }, async (req) =>
    schoolTx(app, req, async (tx) => ({
      items: (await tx.query(`SELECT id, name, bands, is_dev_sample, created_at FROM grading_policies ORDER BY created_at DESC`)).rows,
    })),
  );

  app.post('/school/grading-policies', { preHandler: authz(app, { perm: 'school.manage' }) }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().min(1).max(100), bands: gradingBandsSchema }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(`INSERT INTO grading_policies (school_id, name, bands, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, bands`, [
        a.schoolId,
        b.name,
        JSON.stringify(b.bands),
        a.userId,
      ]);
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'grading_policy.create', entityType: 'grading_policy', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.get('/school/audit', { preHandler: authz(app, { perm: 'audit.view' }) }, async (req) =>
    schoolTx(app, req, async (tx) => ({
      items: (
        await tx.query(`SELECT id, action, entity_type, entity_id, actor_user_id, metadata, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100`)
      ).rows,
    })),
  );
}
