import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authz, parse, schoolTx } from '../context.js';
import { PASSWORD_MIN_LENGTH, hashPassword } from '../passwords.js';
import { AppError, conflict, notFound } from '../errors.js';

const id = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function academicRoutes(app: FastifyInstance): Promise<void> {
  const view = authz(app, { perm: 'academic.view' });
  const manage = authz(app, { perm: 'academic.manage' });
  const studentsView = authz(app, { perm: 'students.view' });
  const examsManage = authz(app, { perm: 'exams.manage' });

  // ---- academic years ----
  app.get('/academic-years', { preHandler: view }, (req) =>
    schoolTx(app, req, async (tx) => ({
      items: (await tx.query(`SELECT id, name, starts_on, ends_on, is_current FROM academic_years ORDER BY starts_on DESC`)).rows,
    })),
  );
  app.post('/academic-years', { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().min(1).max(50), starts_on: date, ends_on: date, is_current: z.boolean().default(false) }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      if (b.is_current) await tx.query(`UPDATE academic_years SET is_current = false WHERE school_id = $1 AND is_current`, [a.schoolId]);
      const r = await tx.query(
        `INSERT INTO academic_years (school_id, name, starts_on, ends_on, is_current) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, starts_on, ends_on, is_current`,
        [a.schoolId, b.name, b.starts_on, b.ends_on, b.is_current],
      );
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'academic_year.create', entityType: 'academic_year', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ---- classes & sections ----
  app.get('/classes', { preHandler: view }, (req) =>
    schoolTx(app, req, async (tx) => ({
      items: (
        await tx.query(
          `SELECT c.id, c.name, c.name_bn, c.level_order,
                  coalesce(json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '[]') AS sections
             FROM classes c LEFT JOIN sections s ON s.class_id = c.id AND s.school_id = c.school_id
            GROUP BY c.id ORDER BY c.level_order, c.name`,
        )
      ).rows,
    })),
  );
  app.post('/classes', { preHandler: manage }, async (req, reply) => {
    const b = parse(
      z.object({ name: z.string().min(1).max(50), name_bn: z.string().max(50).optional(), level_order: z.number().int().min(0).max(100).default(0) }),
      req.body,
    );
    const row = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(`INSERT INTO classes (school_id, name, name_bn, level_order) VALUES ($1,$2,$3,$4) RETURNING id, name, name_bn, level_order`, [
        a.schoolId,
        b.name,
        b.name_bn ?? null,
        b.level_order,
      ]);
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'class.create', entityType: 'class', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });
  app.post('/classes/:id/sections', { preHandler: manage }, async (req, reply) => {
    const { id: classId } = parse(z.object({ id }), req.params);
    const b = parse(z.object({ name: z.string().min(1).max(30) }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      const c = await tx.query(`SELECT 1 FROM classes WHERE id = $1 AND school_id = $2`, [classId, a.schoolId]);
      if (!c.rows[0]) throw notFound('Class');
      const r = await tx.query(`INSERT INTO sections (school_id, class_id, name) VALUES ($1,$2,$3) RETURNING id, class_id, name`, [
        a.schoolId,
        classId,
        b.name,
      ]);
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'section.create', entityType: 'section', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ---- subjects ----
  app.get('/subjects', { preHandler: view }, (req) =>
    schoolTx(app, req, async (tx) => ({ items: (await tx.query(`SELECT id, code, name, name_bn FROM subjects ORDER BY name`)).rows })),
  );
  app.post('/subjects', { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(100), name_bn: z.string().max(100).optional() }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(`INSERT INTO subjects (school_id, code, name, name_bn) VALUES ($1,$2,$3,$4) RETURNING id, code, name, name_bn`, [
        a.schoolId,
        b.code,
        b.name,
        b.name_bn ?? null,
      ]);
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'subject.create', entityType: 'subject', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ---- students & enrollments ----
  app.get('/students', { preHandler: studentsView }, (req) =>
    schoolTx(app, req, async (tx) => {
      const q = parse(z.object({ academic_year_id: id.optional(), section_id: id.optional() }), req.query);
      const r = await tx.query(
        `SELECT st.id, st.student_code, st.full_name, st.full_name_bn, st.status,
                e.id AS enrollment_id, e.academic_year_id, e.class_id, e.section_id, e.roll_no
           FROM students st
           LEFT JOIN enrollments e ON e.student_id = st.id AND e.school_id = st.school_id
                AND ($1::uuid IS NULL OR e.academic_year_id = $1)
          WHERE ($2::uuid IS NULL OR e.section_id = $2)
          ORDER BY st.full_name LIMIT 500`,
        [q.academic_year_id ?? null, q.section_id ?? null],
      );
      return { items: r.rows };
    }),
  );
  app.post('/students', { preHandler: manage }, async (req, reply) => {
    const b = parse(
      z.object({
        student_code: z.string().min(1).max(40),
        full_name: z.string().min(1).max(200),
        full_name_bn: z.string().max(200).optional(),
        date_of_birth: date.optional(),
        gender: z.enum(['female', 'male', 'other']).optional(),
      }),
      req.body,
    );
    const row = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(
        `INSERT INTO students (school_id, student_code, full_name, full_name_bn, date_of_birth, gender) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, student_code, full_name, full_name_bn, status`,
        [a.schoolId, b.student_code, b.full_name, b.full_name_bn ?? null, b.date_of_birth ?? null, b.gender ?? null],
      );
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'student.create', entityType: 'student', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });
  app.post('/students/:id/enrollments', { preHandler: manage }, async (req, reply) => {
    const { id: studentId } = parse(z.object({ id }), req.params);
    const b = parse(z.object({ academic_year_id: id, class_id: id, section_id: id, roll_no: z.number().int().min(1).max(10000) }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      // Composite FKs also guard this; explicit checks give clear errors.
      const ok = await tx.query(
        `SELECT 1 FROM students st, sections s WHERE st.id = $1 AND st.school_id = $4 AND s.id = $2 AND s.class_id = $3 AND s.school_id = $4`,
        [studentId, b.section_id, b.class_id, a.schoolId],
      );
      if (!ok.rows[0]) throw notFound('Student or section');
      const r = await tx.query(
        `INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_no)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, student_id, academic_year_id, class_id, section_id, roll_no`,
        [a.schoolId, studentId, b.academic_year_id, b.class_id, b.section_id, b.roll_no],
      );
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'enrollment.create', entityType: 'enrollment', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ---- guardians ----
  app.post('/guardians', { preHandler: manage }, async (req, reply) => {
    const b = parse(
      z.object({
        full_name: z.string().min(1).max(200),
        phone: z.string().max(40).optional(),
        account: z.object({ email: z.string().email().max(254), initial_password: z.string().min(PASSWORD_MIN_LENGTH).max(256) }).optional(),
      }),
      req.body,
    );
    const pwHash = b.account ? await hashPassword(b.account.initial_password) : null;
    const userId = b.account ? crypto.randomUUID() : null;
    const row = await schoolTx(app, req, async (tx, a) => {
      if (b.account && userId && pwHash) {
        await tx.query(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1,$2,$3,$4)`, [userId, b.account.email, pwHash, b.full_name]);
        await tx.query(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,'guardian')`, [a.schoolId, userId]);
      }
      const r = await tx.query(
        `INSERT INTO guardian_profiles (school_id, user_id, full_name, phone) VALUES ($1,$2,$3,$4) RETURNING id, user_id, full_name, phone`,
        [a.schoolId, userId, b.full_name, b.phone ?? null],
      );
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'guardian.create', entityType: 'guardian', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });
  app.get('/guardians', { preHandler: studentsView }, (req) =>
    schoolTx(app, req, async (tx) => ({ items: (await tx.query(`SELECT id, user_id, full_name, phone FROM guardian_profiles ORDER BY full_name`)).rows })),
  );

  // Link starts 'pending'; a distinct explicit verification step makes it effective.
  app.post('/students/:id/guardians', { preHandler: manage }, async (req, reply) => {
    const { id: studentId } = parse(z.object({ id }), req.params);
    const b = parse(z.object({ guardian_id: id, relationship: z.string().min(1).max(40) }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(
        `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship)
         SELECT $1, st.id, g.id, $4 FROM students st, guardian_profiles g
          WHERE st.id = $2 AND st.school_id = $1 AND g.id = $3 AND g.school_id = $1
         RETURNING id, student_id, guardian_id, relationship, status`,
        [a.schoolId, studentId, b.guardian_id, b.relationship],
      );
      if (!r.rows[0]) throw notFound('Student or guardian');
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'guardian_link.create', entityType: 'student_guardian', entityId: r.rows[0].id });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });
  app.post('/student-guardians/:id/verify', { preHandler: manage }, async (req) => {
    const { id: linkId } = parse(z.object({ id }), req.params);
    return schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(
        `UPDATE student_guardians SET status = 'verified', verified_by = $3, verified_at = now()
          WHERE id = $1 AND school_id = $2 AND status = 'pending' RETURNING id, status`,
        [linkId, a.schoolId, a.userId],
      );
      if (!r.rows[0]) throw conflict('NOT_PENDING', 'Link not found or not pending');
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'guardian_link.verify', entityType: 'student_guardian', entityId: linkId });
      return r.rows[0];
    });
  });
  app.post('/student-guardians/:id/revoke', { preHandler: manage }, async (req) => {
    const { id: linkId } = parse(z.object({ id }), req.params);
    return schoolTx(app, req, async (tx, a) => {
      const r = await tx.query(
        `UPDATE student_guardians SET status = 'revoked' WHERE id = $1 AND school_id = $2 AND status <> 'revoked' RETURNING id, status`,
        [linkId, a.schoolId],
      );
      if (!r.rows[0]) throw notFound('Link');
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'guardian_link.revoke', entityType: 'student_guardian', entityId: linkId });
      return r.rows[0];
    });
  });

  // ---- teacher assignments ----
  app.get('/teacher-assignments', { preHandler: view }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const own = !a.permissions.has('academic.manage');
      const r = await tx.query(
        `SELECT ta.id, ta.user_id, u.full_name AS teacher_name, ta.academic_year_id, ta.class_id, ta.section_id, ta.subject_id
           FROM teacher_assignments ta JOIN users u ON u.id = ta.user_id
          WHERE ($1::uuid IS NULL OR ta.user_id = $1) ORDER BY u.full_name`,
        [own ? a.userId : null],
      );
      return { items: r.rows };
    }),
  );
  app.post('/teacher-assignments', { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({ user_id: id, academic_year_id: id, class_id: id, section_id: id.nullable().optional(), subject_id: id }), req.body);
    const row = await schoolTx(app, req, async (tx, a) => {
      const t = await tx.query(`SELECT 1 FROM school_memberships WHERE user_id = $1 AND school_id = $2 AND role = 'teacher' AND status = 'active'`, [
        b.user_id,
        a.schoolId,
      ]);
      if (!t.rows[0]) throw new AppError(400, 'NOT_A_TEACHER', 'User is not an active teacher in this school');
      const r = await tx.query(
        `INSERT INTO teacher_assignments (school_id, user_id, academic_year_id, class_id, section_id, subject_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, user_id, academic_year_id, class_id, section_id, subject_id`,
        [a.schoolId, b.user_id, b.academic_year_id, b.class_id, b.section_id ?? null, b.subject_id],
      );
      await audit(tx, {
        schoolId: a.schoolId,
        actorUserId: a.userId,
        action: 'teacher_assignment.create',
        entityType: 'teacher_assignment',
        entityId: r.rows[0].id,
      });
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // ---- exams ----
  app.get('/exams', { preHandler: view }, (req) =>
    schoolTx(app, req, async (tx) => ({
      items: (
        await tx.query(
          `SELECT e.id, e.name, e.name_bn, e.academic_year_id, e.class_id, e.grading_policy_id,
                  coalesce(json_agg(json_build_object('subject_id', es.subject_id, 'max_marks', es.max_marks, 'pass_marks', es.pass_marks)) FILTER (WHERE es.subject_id IS NOT NULL), '[]') AS subjects
             FROM exams e LEFT JOIN exam_subjects es ON es.exam_id = e.id GROUP BY e.id ORDER BY e.created_at DESC`,
        )
      ).rows,
    })),
  );
  app.post('/exams', { preHandler: examsManage }, async (req, reply) => {
    const b = parse(
      z.object({
        name: z.string().min(1).max(100),
        name_bn: z.string().max(100).optional(),
        academic_year_id: id,
        class_id: id,
        grading_policy_id: id.nullable().optional(),
        subjects: z
          .array(
            z
              .object({ subject_id: id, max_marks: z.number().positive().max(100000), pass_marks: z.number().min(0).default(0) })
              .refine((s) => s.pass_marks <= s.max_marks, 'pass_marks cannot exceed max_marks'),
          )
          .min(1),
      }),
      req.body,
    );
    if (new Set(b.subjects.map((s) => s.subject_id)).size !== b.subjects.length) throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate subject in exam');
    const row = await schoolTx(app, req, async (tx, a) => {
      const e = await tx.query(
        `INSERT INTO exams (school_id, academic_year_id, class_id, name, name_bn, grading_policy_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, academic_year_id, class_id, grading_policy_id`,
        [a.schoolId, b.academic_year_id, b.class_id, b.name, b.name_bn ?? null, b.grading_policy_id ?? null, a.userId],
      );
      for (const s of b.subjects) {
        await tx.query(`INSERT INTO exam_subjects (school_id, exam_id, subject_id, max_marks, pass_marks) VALUES ($1,$2,$3,$4,$5)`, [
          a.schoolId,
          e.rows[0].id,
          s.subject_id,
          s.max_marks,
          s.pass_marks,
        ]);
      }
      await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'exam.create', entityType: 'exam', entityId: e.rows[0].id });
      return { ...e.rows[0], subjects: b.subjects };
    });
    return reply.status(201).send(row);
  });
}
