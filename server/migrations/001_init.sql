-- ShikkhaOS initial schema.
-- Requires the application role `shikkha_app` (created by `npm run db:setup`).
-- The app role is NOT the table owner, is NOSUPERUSER and NOBYPASSRLS, so the
-- row-level security policies below are enforced for every application query.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shikkha_app') THEN
    RAISE EXCEPTION 'Role shikkha_app is missing. Run "npm run db:setup" first.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Request context helpers (set per transaction by the API via set_config)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_school_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.school_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_session_hash() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.session_hash', true), '') $$;
CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Platform-level tables
-- ---------------------------------------------------------------------------
CREATE TABLE schools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  name_bn     text,
  logo_url    text CHECK (logo_url IS NULL OR logo_url ~ '^https?://'),
  address     text,
  phone       text,
  email       text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER schools_updated BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE school_licenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL UNIQUE REFERENCES schools(id),
  plan          text NOT NULL DEFAULT 'trial',
  status        text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','expired','suspended')),
  starts_on     date NOT NULL DEFAULT current_date,
  ends_on       date,
  max_students  integer CHECK (max_students IS NULL OR max_students > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE TRIGGER school_licenses_updated BEFORE UPDATE ON school_licenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  full_name          text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  preferred_language text NOT NULL DEFAULT 'bn' CHECK (preferred_language IN ('bn','en')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_platform_admin  boolean NOT NULL DEFAULT false,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  key    text PRIMARY KEY,
  scope  text NOT NULL CHECK (scope IN ('platform','school')),
  label_en text NOT NULL,
  label_bn text NOT NULL
);
CREATE TABLE role_permissions (
  role_key   text NOT NULL REFERENCES roles(key),
  permission text NOT NULL,
  PRIMARY KEY (role_key, permission)
);

INSERT INTO roles (key, scope, label_en, label_bn) VALUES
  ('platform_super_admin','platform','Platform Super Admin','প্ল্যাটফর্ম সুপার অ্যাডমিন'),
  ('school_admin','school','School Admin','স্কুল অ্যাডমিন'),
  ('principal','school','Principal / Management','প্রধান শিক্ষক / ব্যবস্থাপনা'),
  ('exam_controller','school','Exam Controller','পরীক্ষা নিয়ন্ত্রক'),
  ('teacher','school','Teacher','শিক্ষক'),
  ('guardian','school','Guardian','অভিভাবক'),
  ('student','school','Student (reserved)','শিক্ষার্থী (সংরক্ষিত)');

INSERT INTO role_permissions (role_key, permission) VALUES
  ('platform_super_admin','platform.schools.manage'),
  ('platform_super_admin','platform.licenses.manage'),
  ('school_admin','school.view'),
  ('school_admin','school.manage'),
  ('school_admin','members.manage'),
  ('school_admin','academic.view'),
  ('school_admin','academic.manage'),
  ('school_admin','students.view'),
  ('school_admin','exams.manage'),
  ('school_admin','result.view'),
  ('school_admin','audit.view'),
  ('principal','school.view'),
  ('principal','academic.view'),
  ('principal','students.view'),
  ('principal','result.view'),
  ('principal','result.review'),
  ('principal','result.publish'),
  ('principal','result.correct'),
  ('principal','audit.view'),
  ('exam_controller','school.view'),
  ('exam_controller','academic.view'),
  ('exam_controller','students.view'),
  ('exam_controller','exams.manage'),
  ('exam_controller','result.view'),
  ('exam_controller','result.review'),
  ('exam_controller','result.publish'),
  ('exam_controller','result.correct'),
  ('teacher','school.view'),
  ('teacher','academic.view'),
  ('teacher','marks.enter'),
  ('teacher','result.submit'),
  ('guardian','guardian.portal');
-- 'student' is reserved for future activation and intentionally has no permissions.

CREATE TABLE school_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL REFERENCES roles(key),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id, role)
);
CREATE INDEX school_memberships_user_idx ON school_memberships (user_id);
CREATE TRIGGER school_memberships_updated BEFORE UPDATE ON school_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Platform role may not be granted through a school membership.
CREATE FUNCTION membership_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'platform_super_admin' THEN
    RAISE EXCEPTION 'platform_super_admin cannot be a school membership role';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_memberships_role_guard BEFORE INSERT OR UPDATE ON school_memberships
  FOR EACH ROW EXECUTE FUNCTION membership_role_guard();

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users(id),
  active_school_id uuid REFERENCES schools(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  user_agent       text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- School-owned tables. Every one carries school_id; composite FKs
-- (school_id, id) make cross-school relationships impossible at the DB level.
-- ---------------------------------------------------------------------------
CREATE TABLE academic_years (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  name       text NOT NULL,
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name),
  CHECK (ends_on > starts_on)
);
CREATE UNIQUE INDEX academic_years_one_current ON academic_years (school_id) WHERE is_current;

CREATE TABLE classes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id),
  name        text NOT NULL,
  name_bn     text,
  level_order integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE sections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  class_id   uuid NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, class_id, name),
  UNIQUE (school_id, id, class_id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id)
);

CREATE TABLE subjects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  code       text NOT NULL,
  name       text NOT NULL,
  name_bn    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, code)
);

-- Permanent student identity; per-year placement lives in enrollments.
CREATE TABLE students (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id),
  student_code text NOT NULL,
  full_name    text NOT NULL,
  full_name_bn text,
  date_of_birth date,
  gender       text CHECK (gender IN ('female','male','other')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','transferred')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_code)
);
CREATE TRIGGER students_updated BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE guardian_profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  user_id    uuid REFERENCES users(id),
  full_name  text NOT NULL,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, user_id)
);

CREATE TABLE student_guardians (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id),
  student_id   uuid NOT NULL,
  guardian_id  uuid NOT NULL,
  relationship text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','revoked')),
  verified_by  uuid REFERENCES users(id),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_id, guardian_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardian_profiles (school_id, id),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX student_guardians_guardian_idx ON student_guardians (school_id, guardian_id);

CREATE TABLE enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id),
  student_id       uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  class_id         uuid NOT NULL,
  section_id       uuid NOT NULL,
  roll_no          integer NOT NULL CHECK (roll_no > 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','promoted')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, academic_year_id),
  UNIQUE (school_id, academic_year_id, section_id, roll_no),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
  FOREIGN KEY (school_id, section_id, class_id) REFERENCES sections (school_id, id, class_id)
);
CREATE INDEX enrollments_section_idx ON enrollments (school_id, academic_year_id, section_id);

CREATE TABLE teacher_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  academic_year_id uuid NOT NULL,
  class_id         uuid NOT NULL,
  section_id       uuid,
  subject_id       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id),
  FOREIGN KEY (school_id, section_id, class_id) REFERENCES sections (school_id, id, class_id),
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id)
);
CREATE UNIQUE INDEX teacher_assignments_unique ON teacher_assignments
  (school_id, user_id, academic_year_id, class_id, subject_id, coalesce(section_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX teacher_assignments_user_idx ON teacher_assignments (school_id, user_id);

-- Grading policy is configuration data owned by each school. Policies are
-- immutable once created (new policy = new row) so published results stay explainable.
CREATE TABLE grading_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id),
  name          text NOT NULL,
  bands         jsonb NOT NULL CHECK (jsonb_typeof(bands) = 'array' AND jsonb_array_length(bands) > 0),
  is_dev_sample boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE exams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id),
  academic_year_id  uuid NOT NULL,
  class_id          uuid NOT NULL,
  name              text NOT NULL,
  name_bn           text,
  grading_policy_id uuid,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, academic_year_id, class_id, name),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id),
  FOREIGN KEY (school_id, grading_policy_id) REFERENCES grading_policies (school_id, id)
);

CREATE TABLE exam_subjects (
  school_id  uuid NOT NULL REFERENCES schools(id),
  exam_id    uuid NOT NULL,
  subject_id uuid NOT NULL,
  max_marks  numeric(7,2) NOT NULL CHECK (max_marks > 0),
  pass_marks numeric(7,2) NOT NULL DEFAULT 0 CHECK (pass_marks >= 0),
  PRIMARY KEY (exam_id, subject_id),
  UNIQUE (school_id, exam_id, subject_id),
  CHECK (pass_marks <= max_marks),
  FOREIGN KEY (school_id, exam_id) REFERENCES exams (school_id, id),
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id)
);

-- One result sheet = exam x subject x section; it is the unit of the workflow.
CREATE TABLE result_sheets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id),
  exam_id      uuid NOT NULL,
  subject_id   uuid NOT NULL,
  section_id   uuid NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted','under_review','returned','approved','published')),
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  row_version  integer NOT NULL DEFAULT 1,
  submitted_by uuid REFERENCES users(id),
  reviewer_id  uuid REFERENCES users(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, exam_id, subject_id, section_id),
  FOREIGN KEY (school_id, exam_id, subject_id) REFERENCES exam_subjects (school_id, exam_id, subject_id),
  FOREIGN KEY (school_id, section_id) REFERENCES sections (school_id, id)
);
CREATE INDEX result_sheets_status_idx ON result_sheets (school_id, status);

CREATE TABLE marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id),
  sheet_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  obtained      numeric(7,2) CHECK (obtained IS NULL OR obtained >= 0),
  is_absent     boolean NOT NULL DEFAULT false,
  row_version   integer NOT NULL DEFAULT 1,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, enrollment_id),
  CHECK (NOT is_absent OR obtained IS NULL),
  FOREIGN KEY (school_id, sheet_id) REFERENCES result_sheets (school_id, id),
  FOREIGN KEY (school_id, enrollment_id) REFERENCES enrollments (school_id, id)
);

-- Defence in depth: marks can only change while the sheet is editable, and
-- never exceed the exam's maximum, regardless of which code path writes them.
CREATE FUNCTION marks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; mx numeric;
BEGIN
  SELECT rs.status, es.max_marks INTO s, mx
    FROM result_sheets rs
    JOIN exam_subjects es ON es.exam_id = rs.exam_id AND es.subject_id = rs.subject_id
   WHERE rs.id = NEW.sheet_id;
  IF s NOT IN ('draft','returned') THEN
    RAISE EXCEPTION 'marks are locked: sheet status is %', s USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.obtained IS NOT NULL AND NEW.obtained > mx THEN
    RAISE EXCEPTION 'obtained marks % exceed maximum %', NEW.obtained, mx USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marks_guard_trg BEFORE INSERT OR UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION marks_guard();

CREATE TABLE result_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id),
  sheet_id       uuid NOT NULL,
  revision       integer NOT NULL,
  action         text NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_user_id  uuid NOT NULL REFERENCES users(id),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, sheet_id) REFERENCES result_sheets (school_id, id)
);
CREATE INDEX result_events_sheet_idx ON result_events (sheet_id, created_at);

-- Immutable snapshots of marks at each milestone (submitted / approved / published).
CREATE TABLE result_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES schools(id),
  sheet_id   uuid NOT NULL,
  revision   integer NOT NULL,
  stage      text NOT NULL CHECK (stage IN ('submitted','approved','published')),
  snapshot   jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, sheet_id) REFERENCES result_sheets (school_id, id)
);
CREATE INDEX result_versions_sheet_idx ON result_versions (sheet_id, created_at);

-- What guardians may see: one row per student per published revision.
CREATE TABLE published_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id),
  sheet_id      uuid NOT NULL,
  revision      integer NOT NULL,
  exam_id       uuid NOT NULL,
  subject_id    uuid NOT NULL,
  student_id    uuid NOT NULL,
  obtained      numeric(7,2),
  max_marks     numeric(7,2) NOT NULL,
  is_absent     boolean NOT NULL,
  grade         text,
  grade_point   numeric(4,2),
  published_at  timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (sheet_id, revision, student_id),
  FOREIGN KEY (school_id, sheet_id) REFERENCES result_sheets (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id)
);
CREATE INDEX published_results_student_idx ON published_results (school_id, student_id) WHERE superseded_at IS NULL;

CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid REFERENCES schools(id),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_school_idx ON audit_events (school_id, created_at DESC);

-- Append-only enforcement.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER result_events_immutable BEFORE UPDATE OR DELETE ON result_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER result_versions_immutable BEFORE UPDATE OR DELETE ON result_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- published_results: only superseded_at may change, rows are never deleted.
CREATE FUNCTION published_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published_results rows cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'published_results rows are immutable except superseded_at';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER published_results_guard_trg BEFORE UPDATE OR DELETE ON published_results
  FOR EACH ROW EXECUTE FUNCTION published_results_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Pure tenant tables: visible and writable only inside the request's school.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'academic_years','classes','sections','subjects','students','guardian_profiles',
    'student_guardians','enrollments','teacher_assignments','grading_policies','exams',
    'exam_subjects','result_sheets','marks','result_events','result_versions','published_results'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id()) WITH CHECK (school_id = app_school_id())', t);
  END LOOP;
END $$;

-- schools: a request sees its active school and schools the user belongs to; platform admins see all.
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY schools_select ON schools FOR SELECT USING (
  id = app_school_id() OR app_is_platform()
  OR EXISTS (SELECT 1 FROM school_memberships m WHERE m.school_id = schools.id AND m.user_id = app_user_id()));
CREATE POLICY schools_insert ON schools FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY schools_update ON schools FOR UPDATE USING (id = app_school_id() OR app_is_platform())
  WITH CHECK (id = app_school_id() OR app_is_platform());

ALTER TABLE school_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY licenses_select ON school_licenses FOR SELECT USING (school_id = app_school_id() OR app_is_platform());
CREATE POLICY licenses_insert ON school_licenses FOR INSERT WITH CHECK (app_is_platform());
CREATE POLICY licenses_update ON school_licenses FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());

-- memberships: own memberships, memberships of the current school, or platform.
ALTER TABLE school_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON school_memberships FOR SELECT
  USING (user_id = app_user_id() OR school_id = app_school_id() OR app_is_platform());
CREATE POLICY memberships_insert ON school_memberships FOR INSERT
  WITH CHECK (school_id = app_school_id() OR app_is_platform());
CREATE POLICY memberships_update ON school_memberships FOR UPDATE
  USING (school_id = app_school_id() OR app_is_platform())
  WITH CHECK (school_id = app_school_id() OR app_is_platform());

-- users: self, members of the current school, or platform. Only platform
-- context may create platform admins.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  id = app_user_id() OR app_is_platform()
  OR EXISTS (SELECT 1 FROM school_memberships m WHERE m.user_id = users.id AND m.school_id = app_school_id()));
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK ((app_is_platform() OR app_school_id() IS NOT NULL) AND (NOT is_platform_admin OR app_is_platform()));
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_user_id() OR app_is_platform())
  WITH CHECK (id = app_user_id() OR app_is_platform());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_all ON sessions
  USING (token_hash = app_session_hash() OR user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_events FOR SELECT USING (school_id = app_school_id() OR app_is_platform());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (school_id = app_school_id() OR app_is_platform());

-- Pre-authentication lookups. These SECURITY DEFINER functions are the only way
-- the app role can read users/sessions before a user context exists.
CREATE FUNCTION auth_user_by_email(p_email citext)
RETURNS TABLE (id uuid, password_hash text, status text, locked_until timestamptz, failed_login_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT u.id, u.password_hash, u.status, u.locked_until, u.failed_login_count FROM users u WHERE u.email = p_email $$;

CREATE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, active_school_id uuid, expires_at timestamptz,
               user_status text, is_platform_admin boolean, email citext, full_name text, preferred_language text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT s.id, s.user_id, s.active_school_id, s.expires_at, u.status, u.is_platform_admin, u.email, u.full_name, u.preferred_language
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = p_hash $$;

REVOKE ALL ON FUNCTION auth_user_by_email(citext), auth_session_by_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_email(citext), auth_session_by_hash(text) TO shikkha_app;

-- ---------------------------------------------------------------------------
-- Privileges for the application role (least privilege; no DELETE except sessions)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO shikkha_app;
GRANT SELECT ON roles, role_permissions TO shikkha_app;
GRANT SELECT, INSERT, UPDATE ON
  schools, school_licenses, users, school_memberships, academic_years, classes, sections,
  subjects, students, guardian_profiles, student_guardians, enrollments, teacher_assignments,
  grading_policies, exams, exam_subjects, result_sheets, marks, published_results TO shikkha_app;
GRANT SELECT, INSERT ON result_events, result_versions, audit_events TO shikkha_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO shikkha_app;
