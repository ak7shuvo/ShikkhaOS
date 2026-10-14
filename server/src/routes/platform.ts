import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authz, parse, platformTx } from '../context.js';
import { notFound } from '../errors.js';
import { PASSWORD_MIN_LENGTH, hashPassword } from '../passwords.js';

const schoolCreate = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(200),
  name_bn: z.string().max(200).optional(),
  admin: z.object({
    email: z.string().email().max(254),
    full_name: z.string().min(1).max(200),
    initial_password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
  }),
});

const licenseBody = z.object({
  plan: z.string().min(1).max(50),
  status: z.enum(['trial', 'active', 'expired', 'suspended']),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ends_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  max_students: z.number().int().positive().nullable().optional(),
});

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const manage = authz(app, { platform: true, perm: 'platform.schools.manage' });
  const lic = authz(app, { platform: true, perm: 'platform.licenses.manage' });

  app.get('/platform/schools', { preHandler: manage }, async (req) =>
    platformTx(app, req, async (tx) => ({
      items: (
        await tx.query(
          `SELECT s.id, s.code, s.name, s.name_bn, s.status, s.created_at, l.status AS license_status, l.plan, l.ends_on
             FROM schools s LEFT JOIN school_licenses l ON l.school_id = s.id ORDER BY s.created_at DESC`,
        )
      ).rows,
    })),
  );

  // Creates the school, a trial licence and its first School Admin in one transaction.
  app.post('/platform/schools', { preHandler: manage }, async (req, reply) => {
    const body = parse(schoolCreate, req.body);
    const pwHash = await hashPassword(body.admin.initial_password);
    const userId = crypto.randomUUID();
    const school = await platformTx(app, req, async (tx, auth) => {
      const s = (
        await tx.query(`INSERT INTO schools (code, name, name_bn) VALUES ($1,$2,$3) RETURNING id, code, name, name_bn, status`, [
          body.code,
          body.name,
          body.name_bn ?? null,
        ])
      ).rows[0];
      await tx.query(`INSERT INTO school_licenses (school_id, plan, status, ends_on) VALUES ($1,'trial','trial', current_date + 30)`, [s.id]);
      await tx.query(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1,$2,$3,$4)`, [userId, body.admin.email, pwHash, body.admin.full_name]);
      await tx.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,'school_admin')`, [s.id, userId]);
      await audit(tx, {
        schoolId: s.id,
        actorUserId: auth.userId,
        action: 'platform.school.create',
        entityType: 'school',
        entityId: s.id,
        metadata: { code: s.code },
      });
      return s;
    });
    return reply.status(201).send({ ...school, admin_user_id: userId });
  });

  app.patch('/platform/schools/:id/status', { preHandler: manage }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'archived']) }), req.body);
    return platformTx(app, req, async (tx, auth) => {
      const r = await tx.query(`UPDATE schools SET status = $2 WHERE id = $1 RETURNING id, status`, [id, status]);
      if (!r.rows[0]) throw notFound('School');
      await audit(tx, { schoolId: id, actorUserId: auth.userId, action: 'platform.school.status', entityType: 'school', entityId: id, metadata: { status } });
      return r.rows[0];
    });
  });

  app.put('/platform/schools/:id/license', { preHandler: lic }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(licenseBody, req.body);
    return platformTx(app, req, async (tx, auth) => {
      const r = await tx.query(
        `INSERT INTO school_licenses (school_id, plan, status, starts_on, ends_on, max_students)
         SELECT s.id, $2, $3, $4, $5, $6 FROM schools s WHERE s.id = $1
         ON CONFLICT (school_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status,
           starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, max_students = EXCLUDED.max_students
         RETURNING school_id, plan, status, starts_on, ends_on, max_students`,
        [id, b.plan, b.status, b.starts_on, b.ends_on ?? null, b.max_students ?? null],
      );
      if (!r.rows[0]) throw notFound('School');
      await audit(tx, {
        schoolId: id,
        actorUserId: auth.userId,
        action: 'platform.license.set',
        entityType: 'license',
        entityId: id,
        metadata: { plan: b.plan, status: b.status },
      });
      return r.rows[0];
    });
  });
}
