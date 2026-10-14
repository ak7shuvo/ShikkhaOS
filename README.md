# ShikkhaOS

**School Management & Academic Information System** — a multi-tenant (many schools, one codebase and database) web platform with Bengali and English interfaces.

> Status: **Phase 1 foundation.** Everything listed under "Implemented" exists and is covered by the tests described in [Test results](#test-results). Items under "Not implemented" are planned, not built. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Implemented

- Multi-tenant core: schools (profile, logo URL, address, contact, settings), licence metadata, memberships, per-school isolation enforced by PostgreSQL row-level security **and** application checks.
- Authentication: email + password (argon2id), opaque server-side sessions in HttpOnly SameSite=Strict cookies, account lockout, login rate limiting.
- Server-enforced RBAC with 7 roles (Platform Super Admin, School Admin, Principal/Management, Exam Controller, Teacher, Guardian, Student — _reserved: no permissions, not assignable_).
- Academic data: academic years, classes, sections, subjects, students (permanent identity) with per-year enrolments, guardians with verified student links, teacher assignments.
- Exams, draft marks entry with validation, school-configurable grading policies.
- Result workflow `Draft → Submitted → Under Review → Returned | Approved → Published`, immutable history and snapshots, explicit auditable corrections.
- Guardian portal: linked students, exams, **published** results only.
- Web UI (React): responsive shell, Bengali/English switcher, reusable form/table/status/loading/empty/error components.
- SQL migrations, development seed, automated tests (see below).

## Not implemented (Phase 2+)

Android APK, desktop client, offline sync (designed only — see ARCHITECTURE), student portal, attendance, fees/payments, notifications, logo file upload (logo is a URL), password reset / email verification / MFA, per-school custom roles, PDF/Excel export, production deployment automation.

## Requirements

- Node.js ≥ 20 (developed on 22), npm ≥ 10
- PostgreSQL ≥ 14 (developed and tested on 16.15). Docker is **not** required; any reachable PostgreSQL works.

## Setup

```bash
npm install
cp .env.example .env          # then edit every CHANGE_ME / OWNER_* value
```

Create empty databases (owner role must be allowed to create roles; a local superuser is fine for development):

```bash
createdb shikkhaos_dev
createdb shikkhaos_test       # disposable: its public schema is dropped & recreated by every test run
```

Then:

```bash
npm run db:setup     # creates the restricted runtime role `shikkha_app` (NOSUPERUSER, NOBYPASSRLS)
npm run db:migrate   # applies server/migrations/*.sql using MIGRATION_DATABASE_URL (owner)
npm run db:seed      # OPTIONAL, development only: one fictional demo school
```

Seeded logins are `<role>@demo-school.example.test` with the password you set in `DEV_SEED_PASSWORD` (`admin`, `principal`, `controller`, `teacher`, `teacher2`, `guardian`, `guardian2`). The seed refuses to run with `NODE_ENV=production`.

First platform administrator (no default account exists):

```bash
PLATFORM_ADMIN_EMAIL=you@example.org PLATFORM_ADMIN_PASSWORD='…min 10 chars…' npm run admin:create -w server
```

## Run

```bash
npm run dev:server   # API on http://127.0.0.1:3000
npm run dev:web      # UI on http://localhost:5173 (proxies /api to the API)
```

Open `http://localhost:5173` (the origin must match `ALLOWED_ORIGINS`). Production: `npm run build`, then `npm start -w server`, and serve `web/dist` over HTTPS from the same site as `/api` (see [docs/SECURITY.md](docs/SECURITY.md)). The API does not serve the static UI itself.

## Quality commands

```bash
npm run lint        # eslint + prettier --check
npm run typecheck   # tsc for server and web
npm test            # vitest: server (needs PostgreSQL + TEST_* env) and web
npm run build       # server (tsc) + web (vite)
```

Server tests run against a **real PostgreSQL** through the restricted role, so row-level-security policies are exercised rather than mocked. `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` (see `.env.example`) must point at a disposable database.

## Test results

Last run in the development environment (PostgreSQL 16.15, Node 22.22):

| Check               | Result                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `npm run lint`      | pass (eslint + prettier)                                         |
| `npm run typecheck` | pass (server + web)                                              |
| `npm test` (server) | 7 files, 80 tests passed                                         |
| `npm test` (web)    | 1 file, 3 tests passed                                           |
| `npm run build`     | pass (server `tsc`, web `vite build`)                            |
| Manual smoke        | migrate → seed → API login/list via curl; Bengali UI in Chromium |

Not run: browser end-to-end tests of every UI form (UI behaviour beyond login + sheet list was not driven automatically).

## Layout

```
server/            Fastify + TypeScript API, SQL migrations, tests
  migrations/      001_init.sql (schema, constraints, RLS, grants)
  src/routes/      auth, platform, school, academic, results, guardian
  src/scripts/     db-setup, migrate, seed, create-platform-admin
  test/            integration tests against real PostgreSQL
web/               React + Vite + TypeScript UI (bn/en)
docs/              ARCHITECTURE, SECURITY, DATABASE, IMPLEMENTATION_PLAN
```

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Database](docs/DATABASE.md) · [Implementation plan & roadmap](docs/IMPLEMENTATION_PLAN.md)
