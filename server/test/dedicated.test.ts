import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbNameFor, provisionSchool, roleNameFor, urlForDb } from '../src/provisioning.js';
import { addDays } from '../src/entitlements.js';
import { controlFixture, registerNew, type ControlFixture } from './fixtures.js';
import { Client, harness, type Harness } from './helpers.js';

// End-to-end through the HTTP API with every school on its OWN PostgreSQL database and role.
let h: Harness;
let f: ControlFixture;

interface Dedicated {
  id: string;
  slug: string;
  adminEmail: string;
  adminPw: string;
  admin: Client;
}

async function newSchool(prefix: string): Promise<Dedicated> {
  const { id, slug } = await registerNew(f, prefix);
  const adminEmail = `admin@${slug}.example.test`;
  const r = await provisionSchool(f.deps, id);
  const admin = new Client(h.app);
  const login = await admin.login(adminEmail, r.adminInitialPassword!, slug);
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { id, slug, adminEmail, adminPw: r.adminInitialPassword!, admin };
}

const inDb = async <T>(id: string, sql: string, params: unknown[] = []): Promise<T[]> => {
  const c = new pg.Client({ connectionString: urlForDb(f.deps.adminUrl, dbNameFor(id)) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  h = await harness();
  f = await controlFixture();
});
afterAll(async () => {
  await f.close();
  await h.close();
});

describe('login and routing', () => {
  it('logs in with slug + email against the school’s own database; data lands only there', async () => {
    const A = await newSchool('dd-a');
    const me = await A.admin.get('/auth/me');
    expect(me.body).toMatchObject({ school: { id: A.id, slug: A.slug }, roles: ['school_admin'], entitlement: { level: 'full', status: 'trial' } });

    const created = await A.admin.post('/classes', { name: 'Class 9' });
    expect(created.status).toBe(201);
    expect(await inDb(A.id, `SELECT name FROM classes`)).toEqual([{ name: 'Class 9' }]);
    // The shared database never saw this school.
    expect((await h.owner.query(`SELECT 1 FROM schools WHERE id = $1`, [A.id])).rowCount).toBe(0);
    expect((await h.owner.query(`SELECT 1 FROM classes WHERE name = 'Class 9'`)).rowCount).toBe(0);
  });

  it('accounts are per school: the same e-mail in two schools is two independent accounts', async () => {
    const A = await newSchool('dd-pa');
    const B = await newSchool('dd-pb');
    const email = 'shared.person@example.test';
    expect((await A.admin.post('/school/members', { email, full_name: 'Person', initial_password: 'password-for-school-a', role: 'principal' })).status).toBe(
      201,
    );
    expect((await B.admin.post('/school/members', { email, full_name: 'Person', initial_password: 'password-for-school-b', role: 'teacher' })).status).toBe(
      201,
    );

    const inA = new Client(h.app);
    const rA = await inA.login(email, 'password-for-school-a', A.slug);
    expect(rA.status).toBe(200);
    expect(rA.body.roles).toEqual(['principal']);
    const inB = new Client(h.app);
    const rB = await inB.login(email, 'password-for-school-b', B.slug);
    expect(rB.body.roles).toEqual(['teacher']);
    // A's password does not work in B and vice versa; no global credential exists.
    expect((await new Client(h.app).login(email, 'password-for-school-a', B.slug)).status).toBe(401);
    expect((await new Client(h.app).login(email, 'password-for-school-b', A.slug)).status).toBe(401);
    expect((await inA.get('/auth/me')).body.school.slug).toBe(A.slug);
  });

  it('a user that exists only in school A cannot log in through school B’s slug', async () => {
    const A = await newSchool('dd-xa');
    const B = await newSchool('dd-xb');
    expect((await new Client(h.app).login(A.adminEmail, A.adminPw, B.slug)).status).toBe(401);
  });

  it('A’s session token cannot be replayed against B by forging the school id in the cookie', async () => {
    const A = await newSchool('dd-fa');
    const B = await newSchool('dd-fb');
    const token = A.admin.cookie.split('=')[1]!.slice(37);
    const forged = new Client(h.app);
    forged.cookie = `sid=${B.id}.${token}`;
    expect((await forged.get('/auth/me')).status).toBe(401);
    expect((await forged.get('/classes')).status).toBe(401);
    // …and B's own admin is unaffected.
    expect((await B.admin.get('/classes')).status).toBe(200);
  });

  it('client-supplied identifiers (school_id, database name, connection string) are ignored', async () => {
    const A = await newSchool('dd-ia');
    const B = await newSchool('dd-ib');
    expect((await B.admin.post('/classes', { name: 'Only B' })).status).toBe(201);
    const headers = { 'x-school-id': B.id, 'x-database': dbNameFor(B.id), 'x-db-url': 'postgres://x', 'x-tenant': B.slug };
    const r = await A.admin.req('GET', `/classes?school_id=${B.id}&db=${dbNameFor(B.id)}`, undefined, headers);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    const w = await A.admin.req('POST', `/classes?school_id=${B.id}`, { name: 'Written In A' }, headers);
    expect(w.status).toBe(201);
    expect(await inDb(B.id, `SELECT name FROM classes ORDER BY name`)).toEqual([{ name: 'Only B' }]);
    expect(await inDb(A.id, `SELECT name FROM classes`)).toEqual([{ name: 'Written In A' }]);
  });

  it('schools that are not provisioned, failed, suspended or offboarded cannot be used', async () => {
    const { id, slug } = await registerNew(f, 'dd-notready');
    expect((await new Client(h.app).login(`admin@${slug}.example.test`, 'whatever-password', slug)).status).toBe(401);
    const A = await newSchool('dd-state');
    await f.control.query(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [A.id]);
    const s = await A.admin.get('/classes');
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('SCHOOL_SUSPENDED');
    await f.control.query(`UPDATE schools SET status = 'offboarding' WHERE id = $1`, [A.id]);
    expect((await A.admin.get('/classes')).body.error.code).toBe('SCHOOL_OFFBOARDED');
    await f.control.query(`UPDATE schools SET status = 'active' WHERE id = $1`, [A.id]);
    expect((await A.admin.get('/classes')).status).toBe(200);
    void id;
  });
});

describe('full result workflow on dedicated databases', () => {
  it('admin builds the school, teacher enters marks, controller publishes, guardian sees only published results', async () => {
    const A = await newSchool('dd-flow');
    const mk = (email: string, role: string, name: string) =>
      A.admin.post('/school/members', { email, full_name: name, initial_password: 'long-enough-password', role });
    const teacherId = (await mk(`t@${A.slug}.example.test`, 'teacher', 'Teacher')).body.user_id;
    await mk(`c@${A.slug}.example.test`, 'exam_controller', 'Controller');
    const year = (await A.admin.post('/academic-years', { name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', is_current: true })).body.id;
    const cls = (await A.admin.post('/classes', { name: 'Class 6' })).body.id;
    const sec = (await A.admin.post(`/classes/${cls}/sections`, { name: 'A' })).body.id;
    const sub = (await A.admin.post('/subjects', { code: 'MAT', name: 'Maths' })).body.id;
    const policy = (
      await A.admin.post('/school/grading-policies', {
        name: 'School scale',
        bands: [
          { min_percent: 0, grade: 'P' },
          { min_percent: 50, grade: 'Q' },
        ],
      })
    ).body.id;
    const st = (await A.admin.post('/students', { student_code: 'S1', full_name: 'Demo Student' })).body.id;
    await A.admin.post(`/students/${st}/enrollments`, { academic_year_id: year, class_id: cls, section_id: sec, roll_no: 1 });
    expect((await A.admin.post('/teacher-assignments', { user_id: teacherId, academic_year_id: year, class_id: cls, subject_id: sub })).status).toBe(201);
    const g = (
      await A.admin.post('/guardians', { full_name: 'Guardian', account: { email: `g@${A.slug}.example.test`, initial_password: 'long-enough-password' } })
    ).body.id;
    const link = (await A.admin.post(`/students/${st}/guardians`, { guardian_id: g, relationship: 'parent' })).body.id;
    await A.admin.post(`/student-guardians/${link}/verify`);

    const teacher = new Client(h.app);
    await teacher.login(`t@${A.slug}.example.test`, 'long-enough-password', A.slug);
    const ctrl = new Client(h.app);
    await ctrl.login(`c@${A.slug}.example.test`, 'long-enough-password', A.slug);
    const guardian = new Client(h.app);
    await guardian.login(`g@${A.slug}.example.test`, 'long-enough-password', A.slug);

    const exam = (
      await ctrl.post('/exams', {
        name: 'Final',
        academic_year_id: year,
        class_id: cls,
        grading_policy_id: policy,
        subjects: [{ subject_id: sub, max_marks: 100 }],
      })
    ).body.id;
    const sheet = (await teacher.post('/result-sheets', { exam_id: exam, subject_id: sub, section_id: sec })).body.id;
    const enr = (await teacher.get(`/result-sheets/${sheet}`)).body.marks[0].enrollment_id;
    expect((await teacher.put(`/result-sheets/${sheet}/marks`, { entries: [{ enrollment_id: enr, obtained: 101, is_absent: false }] })).status).toBe(400);
    expect((await teacher.put(`/result-sheets/${sheet}/marks`, { entries: [{ enrollment_id: enr, obtained: 64, is_absent: false }] })).status).toBe(200);

    expect((await guardian.get(`/guardian/students/${st}/results`)).body.items).toEqual([]);
    for (const a of ['submit']) expect((await teacher.post(`/result-sheets/${sheet}/${a}`)).status).toBe(200);
    for (const a of ['start-review', 'approve']) expect((await ctrl.post(`/result-sheets/${sheet}/${a}`)).status).toBe(200);
    expect((await guardian.get(`/guardian/students/${st}/results`)).body.items).toEqual([]); // approved, not published
    expect((await ctrl.post(`/result-sheets/${sheet}/publish`)).status).toBe(200);
    const res = await guardian.get(`/guardian/students/${st}/results`);
    expect(res.body.items).toMatchObject([{ subject_name: 'Maths', obtained: 64, grade: 'Q' }]);

    // Immutable history lives in the school's own database.
    expect((await inDb<{ action: string }>(A.id, `SELECT action FROM result_events ORDER BY created_at, id`)).map((e) => e.action)).toEqual([
      'create',
      'submit',
      'start_review',
      'approve',
      'publish',
    ]);
    await expect(inDb(A.id, `DELETE FROM result_events`)).rejects.toThrow(/append-only/);
  });
});

describe('failure isolation between schools', () => {
  it('one school’s database becoming unreachable returns 503 for that school only, and recovers', async () => {
    const A = await newSchool('dd-outa');
    const B = await newSchool('dd-outb');
    expect((await A.admin.get('/classes')).status).toBe(200);

    const role = roleNameFor(A.id);
    await f.admin.query(`REVOKE CONNECT ON DATABASE "${dbNameFor(A.id)}" FROM "${role}"`);
    await f.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
    const down = await A.admin.get('/classes');
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('TENANT_UNAVAILABLE');
    expect(JSON.stringify(down.body)).not.toMatch(/sk_|password|postgres/);
    expect((await B.admin.get('/classes')).status).toBe(200);
    expect((await new Client(h.app).login(A.adminEmail, A.adminPw, A.slug)).status).toBe(503);

    await f.admin.query(`GRANT CONNECT ON DATABASE "${dbNameFor(A.id)}" TO "${role}"`);
    expect((await A.admin.get('/classes')).status).toBe(200);
  });

  it('a school whose credentials cannot be decrypted fails alone', async () => {
    const A = await newSchool('dd-keya');
    const B = await newSchool('dd-keyb');
    const good = (await f.control.query(`SELECT db_secret_enc FROM schools WHERE id = $1`, [A.id])).rows[0].db_secret_enc;
    await f.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1`, [A.id, 'v1.k1.AAAA.AAAA.AAAA']);
    expect((await A.admin.get('/classes')).body.error.code).toBe('TENANT_UNAVAILABLE');
    expect((await B.admin.get('/classes')).status).toBe(200);
    await f.control.query(`UPDATE schools SET db_secret_enc = $2 WHERE id = $1`, [A.id, good]);
    expect((await A.admin.get('/classes')).status).toBe(200);
  });

  it('subscription state is per school: blocking one dedicated school leaves another unaffected', async () => {
    const A = await newSchool('dd-suba');
    const B = await newSchool('dd-subb');
    const today = h.clock.now.toISOString().slice(0, 10);
    await f.control.query(`UPDATE subscriptions SET period_start = $2, period_end = $3 WHERE school_id = $1`, [
      A.id,
      addDays(today, -200),
      addDays(today, -100),
    ]);
    expect((await A.admin.get('/classes')).body.error.code).toBe('SUBSCRIPTION_BLOCKED');
    expect((await B.admin.get('/classes')).status).toBe(200);
  });
});

describe('role and credential boundaries observed from the database side', () => {
  it('each school role is confined to its own database and holds no cross-database privileges', async () => {
    const A = await newSchool('dd-bnd-a');
    const B = await newSchool('dd-bnd-b');
    const rows = (
      await f.admin.query(
        `SELECT d.datname, has_database_privilege($1, d.datname, 'CONNECT') AS connect, has_database_privilege($1, d.datname, 'CREATE') AS can_create
         FROM pg_database d WHERE d.datname ~ '^sk_[a-f0-9]{12}$' ORDER BY 1`,
        [roleNameFor(A.id)],
      )
    ).rows;
    expect(rows.filter((r) => r.connect).map((r) => r.datname)).toEqual([dbNameFor(A.id)]);
    expect(rows.every((r) => !r.can_create)).toBe(true);
    void B;
  });
});
