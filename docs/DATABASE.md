# Database

> **Phase 2 update:** this document describes the school schema (`server/migrations`), which is now applied **per school database** (see [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md) and [SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md)); platform data (registry, subscriptions, platform admins) lives in a separate control-plane schema (`server/control-migrations`, described in [PHASE2_ARCHITECTURE.md](PHASE2_ARCHITECTURE.md#3-control-plane)). Migration `002_session_idle.sql` adds `last_seen_at` to `auth_session_by_hash()`. The roles table below refers to the legacy shared setup (`shikkha_app`); dedicated schools use `sk_<id>_app`. `school_licenses` and `users.is_platform_admin` are legacy and unused in dedicated databases.

PostgreSQL ≥ 14 (tested on 16). Schema in `server/migrations/*.sql` (`001_init.sql`, `002_session_idle.sql`). Each school's dedicated database is created and migrated by the operator CLI: `npm run petra -- provision <slug>` (new school) and `npm run petra -- migrate <slug|--all>` (pending migrations). `npm run db:migrate` applies the same files to the **legacy shared database only** (needs `MIGRATION_DATABASE_URL`). Applied files are tracked in `schema_migrations`; the runner is advisory-locked and applies each file in one transaction.

## Roles

| Role                                                               | Used by                                                         | Notes                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sk_<id>_app` (one per school; password encrypted in the registry) | API, for that school's database only                            | `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, `CONNECT` on its own database, same least-privilege table grants as below (no DELETE except `sessions`; INSERT-only on append-only tables). Created by `petra provision`. |
| provisioner (`PROVISIONER_DATABASE_URL`)                           | operator CLI only (`petra provision/migrate/export/offboard-*`) | Privileged (`CREATEDB`/`CREATEROLE`); owns the school databases and bypasses RLS. **Never** configured in the API process.                                                                                                   |
| `petra_control_app` (`CONTROL_DATABASE_URL`)                       | API, control-plane database                                     | See [PHASE2_ARCHITECTURE.md](PHASE2_ARCHITECTURE.md#3-control-plane).                                                                                                                                                        |
| `shikkha_app` (`SHARED_DATABASE_URL`)                              | API, legacy shared database only                                | Phase 1 role, used only while a school is `db_mode='shared'`. Created by `npm run db:setup` (needs `APP_DB_PASSWORD`).                                                                                                       |

Initialisation order (development): create `petra_control` → `npm run control:setup` → `npm run control:migrate` → `npm run petra -- register …` / `provision …` (or `npm run petra -- seed-demo`). See [SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md). The legacy shared database additionally needs `npm run db:setup` and `npm run db:migrate`.

## Tables

Platform: `schools`, `school_licenses`, `users`, `roles`, `role_permissions`, `school_memberships`, `sessions`, `audit_events`.

School-owned (all have `school_id`, composite `UNIQUE (school_id, id)` for tenant-safe FKs): `academic_years`, `classes`, `sections`, `subjects`, `students`, `guardian_profiles`, `student_guardians`, `enrollments`, `teacher_assignments`, `grading_policies`, `exams`, `exam_subjects`, `result_sheets`, `marks`, `result_events`, `result_versions`, `published_results`.

Design notes:

- **Stable ids:** `uuid` primary keys (`gen_random_uuid()`), `created_at`/`updated_at` timestamps with an update trigger where rows are mutable.
- **Student identity vs. enrolment:** `students` is the permanent identity (`student_code` unique per school); `enrollments` places a student in a year/class/section with a roll number. Unique `(student, year)` and `(year, section, roll_no)`.
- **Guardian links:** `student_guardians.status` `pending → verified | revoked`; `verified` requires `verified_by` and `verified_at` (CHECK). Only `verified` grants portal access.
- **Roles/permissions:** `roles` + `role_permissions` seeded in the migration; `school_memberships(school_id, user_id, role)` unique; a trigger forbids `platform_super_admin` as a membership role.
- **Licence:** one row per school (`trial|active|expired|suspended`, `ends_on`, `max_students`). `max_students` is stored but **not yet enforced**.
- **Indexes:** FK-supporting and query indexes, e.g. `school_memberships(user_id)`, `enrollments(school_id, academic_year_id, section_id)`, `published_results(school_id, student_id) WHERE superseded_at IS NULL`, `result_sheets(school_id, status)`, partial unique "one current academic year per school".

## Row-level security

Context helpers read transaction-local settings: `app.school_id`, `app.user_id`, `app.session_hash`, `app.platform`.

- Pure tenant tables (list above): `tenant_isolation` policy `USING/WITH CHECK (school_id = app_school_id())`.
- `schools`: SELECT own/active school, schools the user is a member of, or platform; INSERT platform only; UPDATE own school or platform.
- `school_licenses`: SELECT own or platform; INSERT/UPDATE platform only.
- `school_memberships`: SELECT own memberships, current school's, or platform; INSERT/UPDATE current school or platform; no DELETE.
- `users`: SELECT self, members of the current school, or platform; INSERT needs a school or platform context and only platform may set `is_platform_admin`; UPDATE self or platform.
- `sessions`: row visible/writable only for the owning user or when `token_hash` equals `app.session_hash`.
- `audit_events`: SELECT/INSERT current school or platform; append-only trigger.

## Result workflow

```
              ┌────────── return (reason) ─────────┐
              ▼                                    │
 draft ─submit▶ submitted ─start-review▶ under_review ─approve▶ approved ─publish▶ published
   ▲  ◀─────────── submit (after return) ──────────┘                                  │
   └──────────────── correction (reason, new revision) ───────────────────────────────┘
```

Tables: `result_sheets` (status, `revision`, `row_version`), `marks` (per enrollment, `row_version`), `result_events` (every transition + `create`: actor, time, from/to, reason; append-only), `result_versions` (immutable JSON snapshot at `submitted`, `approved`, `published`), `published_results` (what guardians see; one row per student per published revision, older revisions marked `superseded_at`).

Rules: `returned` sheets are editable again and re-submittable; `submit` requires every active enrollment in the section to have marks or an absence; `publish` computes grades from the exam's grading policy and writes `published_results` + a `published` snapshot in the same transaction as the status change.

## Seed data

`npm run petra -- seed-demo` (development only; refused when `NODE_ENV=production`; needs `DEV_SEED_PASSWORD`) registers and provisions `demo-school` on its own database and seeds fictional data: example.test e-mails, one year, Class 6 (sections A/B), 3 subjects, 4 students, 2 guardians with verified links, 2 teachers, a development-sample grading policy and one exam. Tests create their own schools through the same `seedSchool` function with unique codes.

## Backups / ops

Per-school export, restore-verification and offboarding procedures are operator commands (`petra export`, `petra restore`, `petra offboard-*`); see [SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md#backup-restore-and-export). They are **not scheduled or encrypted** and `pg_dump` run by the privileged role bypasses RLS. Rotate a school's database credential with `petra rotate-secret <slug>`; for the legacy shared role, re-run `npm run db:setup` and update `SHARED_DATABASE_URL`.
