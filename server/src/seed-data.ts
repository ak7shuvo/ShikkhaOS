import type pg from 'pg';
import { hashPassword } from './passwords.js';

export interface SeededSchool {
  schoolId: string;
  code: string;
  users: Record<'admin' | 'principal' | 'controller' | 'teacher' | 'teacher2' | 'guardian' | 'guardian2', { id: string; email: string }>;
  yearId: string;
  classId: string;
  sectionId: string;
  sectionBId: string;
  subjectIds: { bangla: string; english: string; math: string };
  examId: string;
  policyId: string;
  students: { id: string; enrollmentId: string; code: string }[];
}

/**
 * Creates one fully populated DEMO school. Development and automated tests only —
 * all names are obviously fictional and no real student data is used.
 * Requires an owner/superuser connection (bypasses RLS by design).
 */
export async function seedSchool(
  db: pg.Pool | pg.PoolClient,
  opts: {
    code: string;
    name: string;
    password: string;
    /** The schools row already exists (dedicated database provisioned with the registry id). */ existingSchoolId?: string;
  },
): Promise<SeededSchool> {
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const pw = await hashPassword(opts.password);
  const school = opts.existingSchoolId
    ? (
        await q(`UPDATE schools SET name_bn = $2, address = 'Demo address, Demo City' WHERE id = $1 RETURNING id`, [
          opts.existingSchoolId,
          `${opts.name} (বাংলা)`,
        ])
      )[0]!
    : (
        await q(`INSERT INTO schools (code, name, name_bn, address) VALUES ($1,$2,$3,'Demo address, Demo City') RETURNING id`, [
          opts.code,
          opts.name,
          `${opts.name} (বাংলা)`,
        ])
      )[0]!;
  const schoolId: string = school.id;
  // Legacy table (Phase 1); subscriptions now live in the control plane. Kept only so Phase 1 schema invariants hold.
  await q(`INSERT INTO school_licenses (school_id, plan, status, ends_on) VALUES ($1,'demo','active', current_date + 365) ON CONFLICT (school_id) DO NOTHING`, [
    schoolId,
  ]);

  const mk = async (key: string, role: string, name: string) => {
    const email = `${key}@${opts.code}.example.test`;
    const u = (await q(`INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`, [email, pw, name]))[0]!;
    await q(`INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1,$2,$3)`, [schoolId, u.id, role]);
    return { id: u.id as string, email };
  };
  const users = {
    admin: await mk('admin', 'school_admin', 'Demo Admin'),
    principal: await mk('principal', 'principal', 'Demo Principal'),
    controller: await mk('controller', 'exam_controller', 'Demo Exam Controller'),
    teacher: await mk('teacher', 'teacher', 'Demo Teacher One'),
    teacher2: await mk('teacher2', 'teacher', 'Demo Teacher Two'),
    guardian: await mk('guardian', 'guardian', 'Demo Guardian One'),
    guardian2: await mk('guardian2', 'guardian', 'Demo Guardian Two'),
  };

  const year = (
    await q(`INSERT INTO academic_years (school_id, name, starts_on, ends_on, is_current) VALUES ($1,'2026','2026-01-01','2026-12-31',true) RETURNING id`, [
      schoolId,
    ])
  )[0]!;
  const cls = (await q(`INSERT INTO classes (school_id, name, name_bn, level_order) VALUES ($1,'Class 6','ষষ্ঠ শ্রেণি',6) RETURNING id`, [schoolId]))[0]!;
  const secA = (await q(`INSERT INTO sections (school_id, class_id, name) VALUES ($1,$2,'A') RETURNING id`, [schoolId, cls.id]))[0]!;
  const secB = (await q(`INSERT INTO sections (school_id, class_id, name) VALUES ($1,$2,'B') RETURNING id`, [schoolId, cls.id]))[0]!;
  const sub = async (code: string, name: string, bn: string) =>
    (await q(`INSERT INTO subjects (school_id, code, name, name_bn) VALUES ($1,$2,$3,$4) RETURNING id`, [schoolId, code, name, bn]))[0]!.id as string;
  const subjectIds = {
    bangla: await sub('BAN', 'Bangla', 'বাংলা'),
    english: await sub('ENG', 'English', 'ইংরেজি'),
    math: await sub('MAT', 'Mathematics', 'গণিত'),
  };

  // DEVELOPMENT SAMPLE grading bands — arbitrary values for demos/tests, NOT an official scale.
  const bands = [
    { min_percent: 80, grade: 'A', grade_point: 4 },
    { min_percent: 60, grade: 'B', grade_point: 3 },
    { min_percent: 40, grade: 'C', grade_point: 2 },
    { min_percent: 0, grade: 'F', grade_point: 0 },
  ];
  const policy = (
    await q(`INSERT INTO grading_policies (school_id, name, bands, is_dev_sample) VALUES ($1,'Development sample (not official)',$2,true) RETURNING id`, [
      schoolId,
      JSON.stringify(bands),
    ])
  )[0]!;

  const exam = (
    await q(
      `INSERT INTO exams (school_id, academic_year_id, class_id, name, name_bn, grading_policy_id) VALUES ($1,$2,$3,'Half-yearly','অর্ধ-বার্ষিক',$4) RETURNING id`,
      [schoolId, year.id, cls.id, policy.id],
    )
  )[0]!;
  for (const s of Object.values(subjectIds)) {
    await q(`INSERT INTO exam_subjects (school_id, exam_id, subject_id, max_marks, pass_marks) VALUES ($1,$2,$3,100,33)`, [schoolId, exam.id, s]);
  }

  const students: SeededSchool['students'] = [];
  for (let i = 1; i <= 4; i++) {
    const code = `S${i}`;
    const st = (await q(`INSERT INTO students (school_id, student_code, full_name) VALUES ($1,$2,$3) RETURNING id`, [schoolId, code, `Demo Student ${i}`]))[0]!;
    const en = (
      await q(`INSERT INTO enrollments (school_id, student_id, academic_year_id, class_id, section_id, roll_no) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
        schoolId,
        st.id,
        year.id,
        cls.id,
        secA.id,
        i,
      ])
    )[0]!;
    students.push({ id: st.id, enrollmentId: en.id, code });
  }

  const gp = async (uid: string, name: string) =>
    (await q(`INSERT INTO guardian_profiles (school_id, user_id, full_name) VALUES ($1,$2,$3) RETURNING id`, [schoolId, uid, name]))[0]!.id as string;
  const g1 = await gp(users.guardian.id, 'Demo Guardian One');
  const g2 = await gp(users.guardian2.id, 'Demo Guardian Two');
  await q(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship, status, verified_by, verified_at) VALUES ($1,$2,$3,'parent','verified',$4, now())`,
    [schoolId, students[0]!.id, g1, users.admin.id],
  );
  await q(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship, status, verified_by, verified_at) VALUES ($1,$2,$3,'parent','verified',$4, now())`,
    [schoolId, students[1]!.id, g2, users.admin.id],
  );

  // teacher: Bangla for all of Class 6; teacher2: Math for section B only.
  await q(`INSERT INTO teacher_assignments (school_id, user_id, academic_year_id, class_id, section_id, subject_id) VALUES ($1,$2,$3,$4,NULL,$5)`, [
    schoolId,
    users.teacher.id,
    year.id,
    cls.id,
    subjectIds.bangla,
  ]);
  await q(`INSERT INTO teacher_assignments (school_id, user_id, academic_year_id, class_id, section_id, subject_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
    schoolId,
    users.teacher2.id,
    year.id,
    cls.id,
    secB.id,
    subjectIds.math,
  ]);

  return {
    schoolId,
    code: opts.code,
    users,
    yearId: year.id,
    classId: cls.id,
    sectionId: secA.id,
    sectionBId: secB.id,
    subjectIds,
    examId: exam.id,
    policyId: policy.id,
    students,
  };
}
