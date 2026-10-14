import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authz, parse, schoolTx, type AuthContext } from '../context.js';
import type { Tx } from '../db.js';
import { notFound } from '../errors.js';

const id = z.string().uuid();

/** A guardian may only touch students with a VERIFIED link to their own guardian profile in the active school. */
async function assertLinked(tx: Tx, a: AuthContext & { schoolId: string }, studentId: string): Promise<void> {
  const r = await tx.query(
    `SELECT 1 FROM student_guardians sg JOIN guardian_profiles g ON g.id = sg.guardian_id AND g.school_id = sg.school_id
      WHERE sg.school_id = $1 AND sg.student_id = $2 AND g.user_id = $3 AND sg.status = 'verified'`,
    [a.schoolId, studentId, a.userId],
  );
  if (!r.rows[0]) throw notFound('Student'); // 404 for both "no such student" and "not yours"
}

export async function guardianRoutes(app: FastifyInstance): Promise<void> {
  const g = authz(app, { perm: 'guardian.portal' });

  app.get('/guardian/students', { preHandler: g }, (req) =>
    schoolTx(app, req, async (tx, a) => ({
      items: (
        await tx.query(
          `SELECT st.id, st.student_code, st.full_name, st.full_name_bn, sg.relationship
             FROM student_guardians sg
             JOIN guardian_profiles gp ON gp.id = sg.guardian_id AND gp.school_id = sg.school_id
             JOIN students st ON st.id = sg.student_id AND st.school_id = sg.school_id
            WHERE sg.school_id = $1 AND gp.user_id = $2 AND sg.status = 'verified' ORDER BY st.full_name`,
          [a.schoolId, a.userId],
        )
      ).rows,
    })),
  );

  app.get('/guardian/students/:id', { preHandler: g }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: studentId } = parse(z.object({ id }), req.params);
      await assertLinked(tx, a, studentId);
      const st = (
        await tx.query(`SELECT id, student_code, full_name, full_name_bn, gender, date_of_birth, status FROM students WHERE id = $1 AND school_id = $2`, [
          studentId,
          a.schoolId,
        ])
      ).rows[0];
      const enr = await tx.query(
        `SELECT e.id, ay.name AS academic_year, c.name AS class_name, s.name AS section_name, e.roll_no, e.status
           FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id JOIN sections s ON s.id = e.section_id JOIN classes c ON c.id = e.class_id
          WHERE e.student_id = $1 AND e.school_id = $2 ORDER BY ay.starts_on DESC`,
        [studentId, a.schoolId],
      );
      return { ...st, enrollments: enr.rows };
    }),
  );

  app.get('/guardian/students/:id/exams', { preHandler: g }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: studentId } = parse(z.object({ id }), req.params);
      await assertLinked(tx, a, studentId);
      const r = await tx.query(
        `SELECT DISTINCT ex.id, ex.name, ex.name_bn, ay.name AS academic_year
           FROM enrollments e JOIN exams ex ON ex.academic_year_id = e.academic_year_id AND ex.class_id = e.class_id AND ex.school_id = e.school_id
           JOIN academic_years ay ON ay.id = ex.academic_year_id
          WHERE e.student_id = $1 AND e.school_id = $2 ORDER BY ex.name`,
        [studentId, a.schoolId],
      );
      return { items: r.rows };
    }),
  );

  // Only rows in published_results (written solely at publication) are ever exposed.
  app.get('/guardian/students/:id/results', { preHandler: g }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: studentId } = parse(z.object({ id }), req.params);
      await assertLinked(tx, a, studentId);
      const r = await tx.query(
        `SELECT pr.exam_id, ex.name AS exam_name, sub.name AS subject_name, pr.obtained, pr.max_marks, pr.is_absent, pr.grade, pr.grade_point, pr.published_at
           FROM published_results pr JOIN exams ex ON ex.id = pr.exam_id JOIN subjects sub ON sub.id = pr.subject_id
          WHERE pr.school_id = $1 AND pr.student_id = $2 AND pr.superseded_at IS NULL
          ORDER BY ex.name, sub.name`,
        [a.schoolId, studentId],
      );
      return { items: r.rows };
    }),
  );
}
