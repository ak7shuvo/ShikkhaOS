import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { authz, parse, schoolTx, type AuthContext } from '../context.js';
import type { Tx } from '../db.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { computeGrade, gradingBandsSchema } from '../grading.js';
import { EDITABLE, TRANSITIONS, type SheetStatus, type WorkflowAction } from '../workflow.js';

const id = z.string().uuid();

interface Sheet {
  id: string;
  exam_id: string;
  subject_id: string;
  section_id: string;
  status: SheetStatus;
  revision: number;
  row_version: number;
  submitted_by: string | null;
  academic_year_id: string;
  class_id: string;
  grading_policy_id: string | null;
  max_marks: number;
  pass_marks: number;
}

const SHEET_SQL = `
  SELECT rs.id, rs.exam_id, rs.subject_id, rs.section_id, rs.status, rs.revision, rs.row_version, rs.submitted_by,
         e.academic_year_id, e.class_id, e.grading_policy_id, es.max_marks, es.pass_marks
    FROM result_sheets rs
    JOIN exams e ON e.id = rs.exam_id
    JOIN exam_subjects es ON es.exam_id = rs.exam_id AND es.subject_id = rs.subject_id
   WHERE rs.id = $1 AND rs.school_id = $2`;

async function loadSheet(tx: Tx, a: AuthContext & { schoolId: string }, sheetId: string, lock: boolean): Promise<Sheet> {
  const r = await tx.query(SHEET_SQL + (lock ? ' FOR UPDATE OF rs' : ''), [sheetId, a.schoolId]);
  if (!r.rows[0]) throw notFound('Result sheet');
  return r.rows[0] as Sheet;
}

async function isAssigned(tx: Tx, a: AuthContext & { schoolId: string }, s: Sheet): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM teacher_assignments ta
      WHERE ta.school_id = $1 AND ta.user_id = $2 AND ta.academic_year_id = $3 AND ta.class_id = $4
        AND ta.subject_id = $5 AND (ta.section_id IS NULL OR ta.section_id = $6)
        AND EXISTS (SELECT 1 FROM school_memberships m WHERE m.user_id = ta.user_id AND m.school_id = ta.school_id AND m.role = 'teacher' AND m.status = 'active')
      LIMIT 1`,
    [a.schoolId, a.userId, s.academic_year_id, s.class_id, s.subject_id, s.section_id],
  );
  return r.rows.length > 0;
}

/** Read access: result.view holders, or the assigned teacher. Others get 404 (no existence leak). */
async function assertCanRead(tx: Tx, a: AuthContext & { schoolId: string }, s: Sheet): Promise<void> {
  if (a.permissions.has('result.view')) return;
  if (a.permissions.has('marks.enter') && (await isAssigned(tx, a, s))) return;
  throw notFound('Result sheet');
}

async function marksSnapshot(tx: Tx, s: Sheet, schoolId: string) {
  const r = await tx.query(
    `SELECT m.enrollment_id, e.student_id, e.roll_no, m.obtained, m.is_absent
       FROM marks m JOIN enrollments e ON e.id = m.enrollment_id
      WHERE m.sheet_id = $1 AND m.school_id = $2 ORDER BY e.roll_no`,
    [s.id, schoolId],
  );
  return r.rows;
}

const pathToAction: Record<string, WorkflowAction> = {
  submit: 'submit',
  'start-review': 'start_review',
  approve: 'approve',
  return: 'return',
  publish: 'publish',
  correction: 'open_correction',
};

export async function resultRoutes(app: FastifyInstance): Promise<void> {
  const base = authz(app, {}); // school context + licence; permissions checked per operation

  // ---- listing ----
  app.get('/result-sheets', { preHandler: base }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const all = a.permissions.has('result.view');
      if (!all && !a.permissions.has('marks.enter')) throw forbidden();
      const r = await tx.query(
        `SELECT rs.id, rs.exam_id, ex.name AS exam_name, rs.subject_id, sub.name AS subject_name,
                rs.section_id, sec.name AS section_name, cl.name AS class_name,
                rs.status, rs.revision, rs.row_version, es.max_marks
           FROM result_sheets rs
           JOIN exams ex ON ex.id = rs.exam_id
           JOIN exam_subjects es ON es.exam_id = rs.exam_id AND es.subject_id = rs.subject_id
           JOIN subjects sub ON sub.id = rs.subject_id
           JOIN sections sec ON sec.id = rs.section_id
           JOIN classes cl ON cl.id = sec.class_id
          WHERE ($1 OR EXISTS (
                  SELECT 1 FROM teacher_assignments ta
                   WHERE ta.user_id = $2 AND ta.academic_year_id = ex.academic_year_id AND ta.class_id = ex.class_id
                     AND ta.subject_id = rs.subject_id AND (ta.section_id IS NULL OR ta.section_id = rs.section_id)))
          ORDER BY rs.updated_at DESC LIMIT 200`,
        [all, a.userId],
      );
      return { items: r.rows };
    }),
  );

  // ---- open (idempotent) a draft sheet ----
  app.post('/result-sheets', { preHandler: authz(app, { perm: 'marks.enter' }) }, async (req, reply) => {
    const b = parse(z.object({ exam_id: id, subject_id: id, section_id: id }), req.body);
    const out = await schoolTx(app, req, async (tx, a) => {
      const ctx = await tx.query(
        `SELECT e.academic_year_id, e.class_id FROM exams e
           JOIN exam_subjects es ON es.exam_id = e.id AND es.subject_id = $2
           JOIN sections s ON s.id = $3 AND s.class_id = e.class_id
          WHERE e.id = $1 AND e.school_id = $4`,
        [b.exam_id, b.subject_id, b.section_id, a.schoolId],
      );
      if (!ctx.rows[0]) throw new AppError(400, 'INVALID_SHEET', 'Subject or section does not belong to this exam');
      const probe = {
        academic_year_id: ctx.rows[0].academic_year_id,
        class_id: ctx.rows[0].class_id,
        subject_id: b.subject_id,
        section_id: b.section_id,
      } as Sheet;
      if (!(await isAssigned(tx, a, probe))) throw forbidden('You are not assigned to this class/subject', 'NOT_ASSIGNED');
      const ins = await tx.query(
        `INSERT INTO result_sheets (school_id, exam_id, subject_id, section_id, created_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (school_id, exam_id, subject_id, section_id) DO NOTHING RETURNING id`,
        [a.schoolId, b.exam_id, b.subject_id, b.section_id, a.userId],
      );
      const sheetId: string =
        ins.rows[0]?.id ??
        (
          await tx.query(`SELECT id FROM result_sheets WHERE school_id=$1 AND exam_id=$2 AND subject_id=$3 AND section_id=$4`, [
            a.schoolId,
            b.exam_id,
            b.subject_id,
            b.section_id,
          ])
        ).rows[0].id;
      await tx.query(
        `INSERT INTO marks (school_id, sheet_id, enrollment_id, updated_by)
         SELECT $1, $2, en.id, $3 FROM enrollments en
          WHERE en.school_id = $1 AND en.section_id = $4 AND en.academic_year_id = $5 AND en.status = 'active'
            AND EXISTS (SELECT 1 FROM result_sheets WHERE id = $2 AND status IN ('draft','returned'))
         ON CONFLICT (sheet_id, enrollment_id) DO NOTHING`,
        [a.schoolId, sheetId, a.userId, b.section_id, ctx.rows[0].academic_year_id],
      );
      if (ins.rows[0]) {
        await tx.query(
          `INSERT INTO result_events (school_id, sheet_id, revision, action, from_status, to_status, actor_user_id) VALUES ($1,$2,1,'create',NULL,'draft',$3)`,
          [a.schoolId, sheetId, a.userId],
        );
        await audit(tx, { schoolId: a.schoolId, actorUserId: a.userId, action: 'result_sheet.create', entityType: 'result_sheet', entityId: sheetId });
      }
      return { id: sheetId, created: Boolean(ins.rows[0]) };
    });
    return reply.status(out.created ? 201 : 200).send({ id: out.id });
  });

  // ---- read sheet with marks ----
  app.get('/result-sheets/:id', { preHandler: base }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: sheetId } = parse(z.object({ id }), req.params);
      const s = await loadSheet(tx, a, sheetId, false);
      await assertCanRead(tx, a, s);
      const marks = await tx.query(
        `SELECT m.enrollment_id, m.obtained, m.is_absent, m.row_version, e.roll_no, st.full_name, st.student_code
           FROM marks m JOIN enrollments e ON e.id = m.enrollment_id JOIN students st ON st.id = e.student_id
          WHERE m.sheet_id = $1 AND m.school_id = $2 ORDER BY e.roll_no`,
        [s.id, a.schoolId],
      );
      return {
        id: s.id,
        exam_id: s.exam_id,
        subject_id: s.subject_id,
        section_id: s.section_id,
        status: s.status,
        revision: s.revision,
        row_version: s.row_version,
        max_marks: s.max_marks,
        pass_marks: s.pass_marks,
        editable: EDITABLE.includes(s.status),
        marks: marks.rows,
      };
    }),
  );

  // ---- record / update draft marks ----
  const marksBody = z.object({
    entries: z
      .array(
        z.object({
          enrollment_id: id,
          obtained: z.number().min(0).nullable(),
          is_absent: z.boolean().default(false),
          expected_version: z.number().int().positive().optional(),
        }),
      )
      .min(1)
      .max(500),
  });

  app.put('/result-sheets/:id/marks', { preHandler: authz(app, { perm: 'marks.enter' }) }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: sheetId } = parse(z.object({ id }), req.params);
      const b = parse(marksBody, req.body);
      const s = await loadSheet(tx, a, sheetId, true);
      if (!(await isAssigned(tx, a, s))) throw notFound('Result sheet');
      if (!EDITABLE.includes(s.status)) throw conflict('SHEET_LOCKED', `Marks cannot be changed while the sheet is "${s.status}"`);
      const seen = new Set<string>();
      const errors: { enrollment_id: string; message: string }[] = [];
      for (const e of b.entries) {
        if (seen.has(e.enrollment_id)) errors.push({ enrollment_id: e.enrollment_id, message: 'duplicate entry' });
        seen.add(e.enrollment_id);
        if (e.is_absent && e.obtained !== null) errors.push({ enrollment_id: e.enrollment_id, message: 'absent students cannot have obtained marks' });
        if (e.obtained !== null && e.obtained > s.max_marks)
          errors.push({ enrollment_id: e.enrollment_id, message: `obtained marks exceed maximum ${s.max_marks}` });
        if (e.obtained !== null && Math.round(e.obtained * 100) / 100 !== e.obtained)
          errors.push({ enrollment_id: e.enrollment_id, message: 'at most 2 decimal places' });
      }
      if (errors.length) throw new AppError(400, 'INVALID_MARKS', 'Marks validation failed', errors);

      const changes: unknown[] = [];
      for (const e of b.entries) {
        // Enrollment must belong to this sheet's section & year (IDOR / cross-section guard).
        const ok = await tx.query(
          `SELECT 1 FROM enrollments WHERE id = $1 AND school_id = $2 AND section_id = $3 AND academic_year_id = $4 AND status = 'active'`,
          [e.enrollment_id, a.schoolId, s.section_id, s.academic_year_id],
        );
        if (!ok.rows[0]) throw new AppError(400, 'INVALID_ENROLLMENT', 'Enrollment is not part of this result sheet', { enrollment_id: e.enrollment_id });
        const prev = (
          await tx.query(`SELECT obtained, is_absent, row_version FROM marks WHERE sheet_id = $1 AND enrollment_id = $2 FOR UPDATE`, [s.id, e.enrollment_id])
        ).rows[0];
        if (prev) {
          if (e.expected_version !== undefined && e.expected_version !== prev.row_version) {
            throw conflict('STALE_MARK', 'Mark was changed by someone else; reload and retry', {
              enrollment_id: e.enrollment_id,
              current_version: prev.row_version,
            });
          }
          await tx.query(
            `UPDATE marks SET obtained = $3, is_absent = $4, row_version = row_version + 1, updated_by = $5, updated_at = now() WHERE sheet_id = $1 AND enrollment_id = $2`,
            [s.id, e.enrollment_id, e.obtained, e.is_absent, a.userId],
          );
        } else {
          await tx.query(`INSERT INTO marks (school_id, sheet_id, enrollment_id, obtained, is_absent, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
            a.schoolId,
            s.id,
            e.enrollment_id,
            e.obtained,
            e.is_absent,
            a.userId,
          ]);
        }
        changes.push({
          enrollment_id: e.enrollment_id,
          from: prev ? { obtained: prev.obtained, absent: prev.is_absent } : null,
          to: { obtained: e.obtained, absent: e.is_absent },
        });
      }
      const bumped = await tx.query(`UPDATE result_sheets SET row_version = row_version + 1, updated_at = now() WHERE id = $1 RETURNING row_version`, [s.id]);
      await audit(tx, {
        schoolId: a.schoolId,
        actorUserId: a.userId,
        action: 'marks.update',
        entityType: 'result_sheet',
        entityId: s.id,
        metadata: { revision: s.revision, changes },
      });
      return { sheet_row_version: bumped.rows[0].row_version, updated: b.entries.length };
    }),
  );

  // ---- workflow transitions ----
  app.post('/result-sheets/:id/:action', { preHandler: base }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const p = parse(z.object({ id, action: z.enum(['submit', 'start-review', 'approve', 'return', 'publish', 'correction']) }), req.params);
      const body = parse(
        z.object({ reason: z.string().trim().min(3).max(1000).optional(), expected_version: z.number().int().positive().optional() }),
        req.body ?? {},
      );
      const action = pathToAction[p.action]!;
      const t = TRANSITIONS[action];
      if (!a.permissions.has(t.permission)) throw forbidden(`Missing permission: ${t.permission}`);

      const s = await loadSheet(tx, a, p.id, true);
      if (!t.from.includes(s.status)) {
        throw conflict('INVALID_TRANSITION', `Cannot ${p.action} a sheet that is "${s.status}"`, { status: s.status, allowed_from: t.from });
      }
      if (body.expected_version !== undefined && body.expected_version !== s.row_version) {
        throw conflict('STALE_SHEET', 'Sheet changed since you loaded it', { current_version: s.row_version });
      }
      if (t.needsReason && !body.reason) throw new AppError(400, 'REASON_REQUIRED', 'A reason is required for this action');

      if (action === 'submit') {
        if (!(await isAssigned(tx, a, s))) throw forbidden('You are not assigned to this class/subject', 'NOT_ASSIGNED');
        const inc = await tx.query(
          `SELECT count(*)::int AS n FROM enrollments en LEFT JOIN marks m ON m.enrollment_id = en.id AND m.sheet_id = $1
            WHERE en.school_id = $2 AND en.section_id = $3 AND en.academic_year_id = $4 AND en.status = 'active'
              AND (m.id IS NULL OR (m.obtained IS NULL AND NOT m.is_absent))`,
          [s.id, a.schoolId, s.section_id, s.academic_year_id],
        );
        if (inc.rows[0].n > 0) throw conflict('INCOMPLETE_MARKS', `${inc.rows[0].n} student(s) have no marks or absence recorded`);
      }
      if (['start_review', 'approve', 'return'].includes(action) && s.submitted_by === a.userId) {
        throw forbidden('The submitter cannot review their own submission', 'SELF_REVIEW');
      }

      const newRevision = action === 'open_correction' ? s.revision + 1 : s.revision;
      const stage = action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : null;
      if (stage) {
        await tx.query(`INSERT INTO result_versions (school_id, sheet_id, revision, stage, snapshot, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
          a.schoolId,
          s.id,
          s.revision,
          stage,
          JSON.stringify({ max_marks: s.max_marks, marks: await marksSnapshot(tx, s, a.schoolId) }),
          a.userId,
        ]);
      }
      if (action === 'publish') await publish(tx, a, s);

      await tx.query(
        `UPDATE result_sheets SET status = $2, revision = $3, row_version = row_version + 1, updated_at = now(),
                submitted_by = CASE WHEN $4 = 'submit' THEN $5::uuid ELSE submitted_by END,
                reviewer_id = CASE WHEN $4 = 'start_review' THEN $5::uuid ELSE reviewer_id END
          WHERE id = $1`,
        [s.id, t.to, newRevision, action, a.userId],
      );
      await tx.query(
        `INSERT INTO result_events (school_id, sheet_id, revision, action, from_status, to_status, actor_user_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.schoolId, s.id, newRevision, action, s.status, t.to, a.userId, body.reason ?? null],
      );
      await audit(tx, {
        schoolId: a.schoolId,
        actorUserId: a.userId,
        action: `result.${action}`,
        entityType: 'result_sheet',
        entityId: s.id,
        metadata: { from: s.status, to: t.to, revision: newRevision, reason: body.reason ?? null },
      });
      return { id: s.id, status: t.to, revision: newRevision, row_version: s.row_version + 1 };
    }),
  );

  // ---- history ----
  app.get('/result-sheets/:id/history', { preHandler: base }, (req) =>
    schoolTx(app, req, async (tx, a) => {
      const { id: sheetId } = parse(z.object({ id }), req.params);
      const s = await loadSheet(tx, a, sheetId, false);
      await assertCanRead(tx, a, s);
      const events = await tx.query(
        `SELECT ev.id, ev.revision, ev.action, ev.from_status, ev.to_status, ev.reason, ev.created_at, u.full_name AS actor_name
           FROM result_events ev JOIN users u ON u.id = ev.actor_user_id WHERE ev.sheet_id = $1 ORDER BY ev.created_at, ev.id`,
        [s.id],
      );
      const versions = await tx.query(`SELECT id, revision, stage, created_at FROM result_versions WHERE sheet_id = $1 ORDER BY created_at`, [s.id]);
      return { events: events.rows, versions: versions.rows };
    }),
  );
}

async function publish(tx: Tx, a: AuthContext & { schoolId: string }, s: Sheet): Promise<void> {
  let bands = null;
  if (s.grading_policy_id) {
    const g = await tx.query(`SELECT bands FROM grading_policies WHERE id = $1 AND school_id = $2`, [s.grading_policy_id, a.schoolId]);
    bands = gradingBandsSchema.parse(g.rows[0].bands);
  }
  const marks = await marksSnapshot(tx, s, a.schoolId);
  const rows = marks.map((m) => ({ ...m, ...computeGrade(bands, m.obtained, s.max_marks, m.is_absent) }));
  for (const r of rows) {
    await tx.query(
      `INSERT INTO published_results (school_id, sheet_id, revision, exam_id, subject_id, student_id, obtained, max_marks, is_absent, grade, grade_point)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [a.schoolId, s.id, s.revision, s.exam_id, s.subject_id, r.student_id, r.obtained, s.max_marks, r.is_absent, r.grade, r.grade_point],
    );
  }
  // Older revisions stay in the table as history; only the newest is shown to guardians.
  await tx.query(`UPDATE published_results SET superseded_at = now() WHERE sheet_id = $1 AND revision < $2 AND superseded_at IS NULL`, [s.id, s.revision]);
  await tx.query(`INSERT INTO result_versions (school_id, sheet_id, revision, stage, snapshot, created_by) VALUES ($1,$2,$3,'published',$4,$5)`, [
    a.schoolId,
    s.id,
    s.revision,
    JSON.stringify({ max_marks: s.max_marks, grading_policy_id: s.grading_policy_id, bands, results: rows }),
    a.userId,
  ]);
}
