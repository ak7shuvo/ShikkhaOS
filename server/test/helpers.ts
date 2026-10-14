import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { seedSchool, type SeededSchool } from '../src/seed-data.js';

export const PASSWORD = 'correct-horse-battery';
export const ORIGIN = 'http://localhost:5173';

export function testEnv(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ALLOWED_ORIGINS: ORIGIN,
    LOGIN_RATE_LIMIT_PER_MINUTE: '10000',
    API_RATE_LIMIT_PER_MINUTE: '100000',
    ...over,
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  app: FastifyInstance;
  pool: Db;
  owner: pg.Pool;
  close(): Promise<void>;
}

export async function harness(over: Record<string, string> = {}): Promise<Harness> {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const owner = new pg.Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL! });
  const app = await buildApp(testEnv(over), pool);
  await app.ready();
  return {
    app,
    pool,
    owner,
    close: async () => {
      await app.close();
      await pool.end();
      await owner.end();
    },
  };
}

/** Minimal cookie-carrying API client over fastify.inject (real HTTP semantics, real DB). */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url: `/api${url}`,
      headers: { origin: ORIGIN, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      payload: body === undefined ? undefined : (body as object),
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) this.cookie = first.startsWith('sid=;') ? '' : first.split(';')[0]!;
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* empty body */
    }
    return { status: res.statusCode, body: json, headers: res.headers };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('PUT', u, b);
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b);

  async login(email: string, password = PASSWORD) {
    return this.req('POST', '/auth/login', { email, password });
  }
}

export async function loginAs(h: Harness, email: string): Promise<Client> {
  const c = new Client(h.app);
  const r = await c.login(email);
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

let n = 0;
export const uniqueCode = (p: string) => `${p}-${Date.now().toString(36)}${n++}`;

export const seed = (h: Harness, prefix: string): Promise<SeededSchool> =>
  seedSchool(h.owner, { code: uniqueCode(prefix), name: `School ${prefix}`, password: PASSWORD });

/** Creates a brand-new exam (via the owner connection) so each test gets an isolated sheet. */
export async function newExam(h: Harness, s: SeededSchool, subjectId: string, maxMarks = 100, withPolicy = true): Promise<string> {
  const name = `Exam ${uniqueCode('x')}`;
  const e = await h.owner.query(`INSERT INTO exams (school_id, academic_year_id, class_id, name, grading_policy_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    s.schoolId,
    s.yearId,
    s.classId,
    name,
    withPolicy ? s.policyId : null,
  ]);
  await h.owner.query(`INSERT INTO exam_subjects (school_id, exam_id, subject_id, max_marks, pass_marks) VALUES ($1,$2,$3,$4,0)`, [
    s.schoolId,
    e.rows[0].id,
    subjectId,
    maxMarks,
  ]);
  return e.rows[0].id;
}

/** Opens a fresh sheet as the teacher and fills every student's marks. */
export async function fillSheet(h: Harness, teacher: Client, s: SeededSchool, subjectId = s.subjectIds.bangla, marks: number[] = [90, 70, 50, 30]) {
  const examId = await newExam(h, s, subjectId);
  const open = await teacher.post('/result-sheets', { exam_id: examId, subject_id: subjectId, section_id: s.sectionId });
  const sheetId: string = open.body.id;
  const put = await teacher.put(`/result-sheets/${sheetId}/marks`, {
    entries: s.students.map((st, i) => ({ enrollment_id: st.enrollmentId, obtained: marks[i]!, is_absent: false })),
  });
  return { sheetId, examId, open, put };
}
