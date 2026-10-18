# ShikkhaOS

**School Management & Academic Information System** — a commercial multi-school web platform by Petra Software Solution (one codebase; one dedicated database per school) with Bengali and English interfaces.

> Status: **Phase 2 in progress (branch `feat/phase-2-db-per-school`) — not production-ready.** Phase 1 features below are preserved. Items under "Not implemented" are planned, not built; production blockers are listed in [docs/PHASE2_ARCHITECTURE.md](docs/PHASE2_ARCHITECTURE.md#status-and-remaining-blockers).

## Implemented

- Multi-tenant core: schools (profile, branding, settings), per-school accounts and memberships, isolation by **separate database + role per school** plus PostgreSQL row-level security inside each database and application checks. Subscription/licensing in a Petra control plane (Phase 2).
- Authentication: email + password (argon2id), opaque server-side sessions in HttpOnly SameSite=Strict cookies, account lockout, login rate limiting.
- Server-enforced RBAC with 7 roles (Platform Super Admin, School Admin, Principal/Management, Exam Controller, Teacher, Guardian, Student — _reserved: no permissions, not assignable_).
- Academic data: academic years, classes, sections, subjects, students (permanent identity) with per-year enrolments, guardians with verified student links, teacher assignments.
- Exams, draft marks entry with validation, school-configurable grading policies.
- Result workflow `Draft → Submitted → Under Review → Returned | Approved → Published`, immutable history and snapshots, explicit auditable corrections.
- Guardian portal: linked students, exams, **published** results only.
- Web UI (React): responsive shell, Bengali/English switcher, reusable form/table/status/loading/empty/error components.
- SQL migrations, development seed, automated tests (see below).

## Not implemented

EXE / Linux / Android builds (configuration generator only), offline sync (design only), payment gateway, student portal, attendance, fees, notifications, logo file upload (logo is a URL), password reset / e-mail verification / MFA, per-school custom roles, PDF/Excel export, production deployment automation, TLS/network/KMS configuration (documented requirements).

## Phase 2: Petra multi-school platform (branch `feat/phase-2-db-per-school`)

ShikkhaOS is a commercial product of Petra Software Solution. Each school has its own **database, database role, accounts, branding and subscription**; a control-plane database holds the school registry, subscriptions and Petra staff accounts. Read first: [docs/PHASE2_ARCHITECTURE.md](docs/PHASE2_ARCHITECTURE.md) (includes the Phase 1 audit, what is verified, and the **list of production blockers** — this is not production-ready), then [DATABASE_ISOLATION](docs/DATABASE_ISOLATION.md), [SCHOOL_PROVISIONING](docs/SCHOOL_PROVISIONING.md), [SUBSCRIPTIONS](docs/SUBSCRIPTIONS.md), [DEPLOYMENT](docs/DEPLOYMENT.md).

Login now takes **school slug + email + password**. Petra staff use `/platform` (separate sign-in).

## Requirements

- Node.js ≥ 20 (developed on 22), npm ≥ 10
- PostgreSQL ≥ 14 (developed and tested on 16.15) and the `pg_dump`/`pg_restore` client tools. Docker is **not** required.
- An administrative PostgreSQL role allowed to create databases and roles (the "provisioner"), used only by the operator CLI and tests.

## Setup (development)

```bash
npm install
cp .env.example .env                              # fill in every placeholder
npm run petra -- generate-master-key              # paste into PETRA_MASTER_KEY
createdb petra_control                            # as a PostgreSQL admin
npm run control:setup && npm run control:migrate  # control-plane role + schema
PLATFORM_ADMIN_EMAIL=ops@example.org PLATFORM_ADMIN_PASSWORD='…min 10 chars…' npm run petra -- platform-admin-create
npm run petra -- seed-demo                        # OPTIONAL, development only: fictional demo school on its own database
```

New school (operator workflow, see [SCHOOL_PROVISIONING](docs/SCHOOL_PROVISIONING.md)):

```bash
npm run petra -- register greenfield "Greenfield School" admin@example.org "Admin Name"
npm run petra -- provision greenfield             # creates database + role, prints the first admin password once
npm run petra -- health greenfield
```

Demo logins (after `seed-demo`): school `demo-school`, e-mails `admin|principal|controller|teacher|teacher2|guardian|guardian2@demo-school.example.test`, password = `DEV_SEED_PASSWORD`.

## Run

```bash
npm run dev:server   # API on http://127.0.0.1:3000
npm run dev:web      # UI on http://localhost:5173 (proxies /api); platform console at /platform
```

Open `http://localhost:5173` (the origin must match `ALLOWED_ORIGINS`). Production: `npm run build`, then `npm start -w server`, and serve `web/dist` over HTTPS from the same site as `/api` ([DEPLOYMENT](docs/DEPLOYMENT.md)).

## Quality commands

```bash
npm run lint        # eslint + prettier --check
npm run typecheck   # tsc for server and web
npm test            # vitest: server (needs PostgreSQL + TEST_* env) and web
npm run build       # server (tsc) + web (vite)
```

Server tests run against a **real PostgreSQL** through restricted roles, so row-level-security policies and per-school database privileges are exercised rather than mocked. The test setup is **destructive** (it drops/recreates schemas and per-school databases) and refuses to start unless it can prove the target is a disposable test cluster: `PETRA_TEST_CLUSTER=disposable`, a matching cluster-marker database, loopback host, strictly test-named databases (see `.env.example` for the one-time preparation). Never point `TEST_*` at a development, staging or production cluster. The TLS tests (`server/test/tls.test.ts`) run only when `PETRA_TEST_TLS_CA` / `PETRA_TEST_TLS_UNTRUSTED_CA` are set (certificates from `scripts/ci/gen-test-certs.sh`, server with `ssl=on`); otherwise they are reported as skipped — except when `CI` is set, where missing or unreadable CA inputs fail the suite. `.github/workflows/ci.yml` runs lint, typecheck, server tests, web tests and build against a throw-away PostgreSQL 16 container bound to loopback with per-run random passwords and its own cluster marker; it contains no external database URL.

**Browser smoke E2E** (`e2e/`, Playwright + Chromium): one test logs in with the school slug, checks the grace-period renewal banner, logs out and proves the old session cookie is rejected by the server. It runs only against the same disposable test cluster as the server tests (`e2e/prepare.ts` and `e2e/playwright.config.ts` call the `server/test/safety.ts` guard; the API process is started by `e2e/start-api.mjs` with an explicit minimal environment, so no development/production URL can reach it, and running servers are never reused). Run it locally with the `TEST_*` variables from `.env.example` set: `npm run e2e` (needs `npx playwright install chromium` once). `npm run test:negative -w e2e` drops the logout request and **must fail** on the logout assertions; CI checks exactly that. Not covered: other pages, mobile/desktop clients, cross-browser runs.

## Test results

Last run in the development environment (PostgreSQL 16.15, Node 22.22), Phase 2 branch:

| Check               | Result                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run lint`      | pass (eslint + prettier)                                                                                |
| `npm run typecheck` | pass (server + web)                                                                                     |
| `npm test` (server) | 15 files, 188 tests passed (real PostgreSQL roles and per-school databases)                             |
| `npm test` (web)    | 1 file, 3 tests passed                                                                                  |
| `npm run build`     | pass (server `tsc`, web `vite build`)                                                                   |
| Manual smoke        | control-plane setup, `seed-demo`, `health --all`, API login by slug, platform login, Chromium rendering |

Not run / not verified: browser end-to-end tests of every UI form, TLS to PostgreSQL, `pg_hba`/firewall rules, a real reverse proxy, KMS, backups scheduling, EXE/Linux/APK builds. See the blockers in [docs/PHASE2_ARCHITECTURE.md](docs/PHASE2_ARCHITECTURE.md#status-and-remaining-blockers).

## Layout

```
server/            Fastify + TypeScript API, SQL migrations, tests
  migrations/      school schema (applied per school database): 001_init.sql, 002_session_idle.sql
  control-migrations/ Petra control plane schema
  src/tenancy.ts, provisioning.ts, shared-migration.ts, operations.ts, entitlements.ts, secrets.ts
  src/routes/      auth, platform, school, academic, results, guardian
  src/scripts/     petra (operator CLI), control-setup, control-migrate, db-setup/migrate (legacy shared DB)
  test/            integration tests against real PostgreSQL
web/               React + Vite + TypeScript UI (bn/en)
docs/              PHASE2_ARCHITECTURE, DATABASE_ISOLATION, SCHOOL_PROVISIONING, SUBSCRIPTIONS, DEPLOYMENT, SECURITY, ARCHITECTURE, DATABASE, IMPLEMENTATION_PLAN
```

## Documentation

[Phase 2 architecture](docs/PHASE2_ARCHITECTURE.md) · [Database isolation](docs/DATABASE_ISOLATION.md) · [Provisioning](docs/SCHOOL_PROVISIONING.md) · [Subscriptions](docs/SUBSCRIPTIONS.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](docs/SECURITY.md) · [Architecture (Phase 1)](docs/ARCHITECTURE.md) · [Database (school schema)](docs/DATABASE.md) · [Implementation plan & roadmap](docs/IMPLEMENTATION_PLAN.md)

## Desktop app

A Linux desktop shell (Electron around the unchanged web UI, school-branded via `petra build-profile`) lives in `desktop/`; architecture, security model, build/run instructions (including NixOS notes), tests and roadmap are in [docs/DESKTOP.md](docs/DESKTOP.md). It is a foundation: no Windows/Android build, signing, auto-update or offline mode yet.
