# Phase 2 architecture — Petra commercial multi-school platform

ShikkhaOS is a commercial product of Petra Software Solution. Petra operates the central platform; schools subscribe monthly or annually and each school gets its own branding, configuration and **dedicated logical PostgreSQL database with its own credentials**.

This document describes what exists in the repository on branch `feat/phase-2-db-per-school`. Items that are not built or not verified are listed explicitly in [Status and remaining blockers](#status-and-remaining-blockers).

## 1. Audit of the Phase 1 architecture (before this work)

| Area                                 | Phase 1 state                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database                             | One PostgreSQL database holding platform tables (`schools`, `users`, `sessions`, `school_memberships`, `school_licenses`, `roles`) and 17 school-owned tables, each with `school_id`.                                                                                                                                                      |
| Isolation                            | 16 RLS policies keyed on a transaction-local `app.school_id`, composite `(school_id, id)` foreign keys, append-only/immutability triggers. One runtime role (`shikkha_app`, `NOBYPASSRLS`).                                                                                                                                                |
| API connection model                 | One `pg.Pool` shared by all schools; every request wrapped in `withContext()` which sets `app.*` settings.                                                                                                                                                                                                                                 |
| Authorization context                | Cookie → `auth_session_by_hash()` (SECURITY DEFINER) → memberships → active school from `sessions.active_school_id` → permissions from DB role tables.                                                                                                                                                                                     |
| Accounts                             | Global `users` table, email unique across all schools; a user could belong to several schools and switch between them.                                                                                                                                                                                                                     |
| Platform admin                       | A flag on the same `users` table; platform routes ran inside the shared database with `app.platform = on`.                                                                                                                                                                                                                                 |
| Licensing                            | One `school_licenses` row per school, checked in the school database. No plans, billing period, grace or retention.                                                                                                                                                                                                                        |
| Weak points for the commercial model | A single credential reached every school's rows (an RLS/policy bug or SQL injection would cross tenants). No per-school credentials, backups, migrations or failure domains. No separation of platform administration from school data stores. Rate limiting and client IP used the TCP peer only. No idle session timeout or session cap. |

What was kept unchanged: the schema, RLS policies and triggers (they remain as a second layer inside every school database), the role/permission model, the result approval workflow, immutable history, guardian restrictions, and all route handlers other than authentication/platform/school-profile.

### Safest migration path (what was implemented)

Expand-and-contract, with Phase 1 behaviour preserved at each step:

1. **Add the control plane** (new database, own migration runner) — additive.
2. **Introduce a `TenantRouter` seam.** Every school route already ran through `schoolTx()`; it now takes its pool from the authenticated school's registry entry. A registry row has `db_mode = 'shared'` (Phase 1 database) or `'dedicated'`.
3. **Provision dedicated databases** with an idempotent operator workflow; new schools are always `dedicated`.
4. **Move existing schools** with `migrate-to-dedicated` (copy, verify by row counts and content digests, then atomic cut-over) and keep the shared copy as the rollback source.
5. **Remove shared mode** only after the criteria in [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md#removing-shared-mode) are met. Shared mode is **not** removed in this branch.

## 2. Target architecture

```
                        ┌────────────────────────── Petra control plane (PostgreSQL: petra_control) ─────────────────────────┐
                        │ schools (registry) · school_branding · plans · subscriptions · payments (manual ledger)          │
                        │ subscription_events · app_releases · school_build_profiles · platform_admins · platform_sessions │
                        │ platform_audit_events (append-only)                                                              │
                        └───────────────▲──────────────────────────────────────────────────────────────▲────────────────────┘
                                        │ petra_control_app (restricted)                               │ same restricted role
Browser / branded client ── /api ──▶ Fastify API ── TenantRouter ──▶ per-school pool ──▶ school_<id> database  (role sk_<id>_app)
  school slug + email + password        │            (registry row decides)                               RLS + constraints + triggers still apply
                                        └── platform routes use ONLY the control plane (no school credentials used)

Operator host (Petra staff)  ── `npm run petra -- …` ── PROVISIONER_DATABASE_URL (CREATEDB/CREATEROLE) ── never present in the API process
```

### Request path

1. Browser sends `sid=<school id>.<random token>`. The school id is only a **routing hint**; it is used to fetch the registry row.
2. `TenantRouter.byId()` → registry row; `assertRoutable()` rejects non-`active` statuses (suspended, offboarding, maintenance, not provisioned).
3. `poolFor(entry)` returns that school's pool. The connection parameters (host, port, database, role) come only from the registry row; the password is decrypted from `db_secret_enc` with the master key. On first use the router verifies `current_database()` / `current_user` equal the registry values and that the role is not a superuser and does not bypass RLS.
4. The session token hash is looked up **in that school's database**. A token is valid only in the school that issued it, and the session's `active_school_id` must equal the registry id; a forged prefix therefore fails (tested).
5. Subscription entitlement is derived from the control plane (`full | grace | read_only | blocked`) and enforced before permissions.
6. Handlers run via `schoolTx()` on the school's pool with the same `app.user_id` / `app.school_id` RLS context as Phase 1.

Nothing in a request (body, query, header) can select a database. Slugs are accepted only at login and on two public read-only endpoints, and are resolved through the registry (tested: headers such as `x-school-id`, `x-database`, `x-db-url`, query `school_id` and a forged cookie prefix are ignored/rejected).

### Accounts

Accounts are **per school**: a user exists only in one school database (`users`, `school_memberships`, `sessions`). The same e-mail in two schools is two independent accounts with independent passwords. There is no global credential store. Login requires `school` (slug), `email`, `password`. Platform (Petra) staff authenticate separately against the control plane (`platform_admins`, cookie `psid`, path `/api/platform`) and have no school database credentials in the API.

### Platform vs school administration

|                       | School admin                                                  | Platform admin (Petra)                                                                                    |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Authenticates against | the school's own database                                     | control plane                                                                                             |
| Cookie                | `sid` (path `/`)                                              | `psid` (path `/api/platform`)                                                                             |
| Can                   | manage school users, academic data, profile, branding, export | register schools, suspend/activate, subscriptions and payments, branding, releases, build profiles, audit |
| Cannot                | change slug, status, subscription, database mapping           | read any school's academic data or credentials through the API                                            |

Provisioning is **not** an API action. The API registers a school (`requested`); an operator runs `npm run petra -- provision <slug>` with the privileged credential.

## 3. Control plane

Defined in `server/control-migrations/001_control.sql`:

| Table                                                                    | Purpose                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schools`                                                                | Registry: slug, name, status (`requested, provisioning, active, maintenance, suspended, offboarding, archived, failed`), `db_mode`, host/port/db/role, encrypted credential (+ pending slot for rotation), provisioning step/error, schema version |
| `school_branding`                                                        | Display name, logo URL (https only), primary/accent colour (hex, validated for WCAG 4.5:1 contrast with white text)                                                                                                                                |
| `plans`, `subscriptions`, `subscription_payments`, `subscription_events` | Monthly/annual plans, per-school period/grace/read-only/retention terms, manual payment ledger (append-only), event history (append-only). See [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md)                                                                |
| `app_releases`, `school_build_profiles`                                  | Release metadata (latest/min supported version) and per-school app id/name per platform (android/windows/linux)                                                                                                                                    |
| `platform_admins`, `platform_sessions`                                   | Petra staff accounts and sessions                                                                                                                                                                                                                  |
| `platform_audit_events`                                                  | Append-only audit of platform actions (the app role has no UPDATE/DELETE)                                                                                                                                                                          |

The runtime role `petra_control_app` has least privilege: no DELETE anywhere except `platform_sessions`, INSERT-only on ledger/audit tables. It **can** read and update registry rows including encrypted credentials; compromise of the API process therefore exposes the encrypted credentials **and** the master key in memory (see blockers).

## 4. Branding and release configuration

- Branding is stored once in the control plane and edited by Petra (`PUT /api/platform/schools/:id/branding`) or by the school's own admin (`PUT /api/school/branding`, scoped to the authenticated school). The web UI applies colours as CSS variables and shows the display name/logo; the login page fetches public branding by slug (`GET /api/public/branding/:slug`).
- One web codebase. A branded client build is configured by **non-secret** values only: `VITE_SCHOOL_SLUG`, `VITE_APP_NAME`, `VITE_API_BASE_URL`. `npm run petra -- build-profile <slug> <https-api-url>` writes `builds/<slug>/{profile.json, web.env, capacitor.config.json, tauri.<platform>.conf.json}` from the control plane. **This prepares configuration; it does not build, sign or launch any EXE, Linux package or APK.** See [DEPLOYMENT.md](DEPLOYMENT.md#branded-desktop-and-android-clients).
- `GET /api/public/app-config/:slug?version=x.y.z` reports latest/min-supported release and whether the installed version must update (data only; no client uses it yet).

## 5. API changes versus Phase 1 (breaking)

| Change                                            | Notes                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login` requires `school`          | Unknown/unready schools return the same 401 as bad credentials.                                                                                                       |
| Cookie value is `<school id>.<token>`             | Old sessions are invalid; users sign in again.                                                                                                                        |
| `POST /api/auth/switch-school` removed            | A session belongs to exactly one school.                                                                                                                              |
| `/api/platform/*` now uses control-plane sessions | `POST /api/platform/auth/login`; Phase 1 platform admins can be imported (`import-platform-admins`). `PUT …/license` replaced by subscription endpoints.              |
| `DATABASE_URL` replaced                           | `CONTROL_DATABASE_URL` (+ optional `SHARED_DATABASE_URL`). `PETRA_MASTER_KEY` is required.                                                                            |
| New                                               | `POST /api/auth/change-password`, `GET /api/school/export`, `PUT /api/school/branding`, `/api/public/*`, subscription enforcement, idle-session timeout, session cap. |

`school_licenses` (Phase 1) is left in the school schema but is **no longer read**; subscriptions come from the control plane.

## 6. Verification performed

All run against a real PostgreSQL 16.15 with real roles and databases (nothing mocked):

| Check               | Result                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`      | pass                                                                                                                                                                                                     |
| `npm run typecheck` | pass (server + web)                                                                                                                                                                                      |
| `npm test`          | server: 15 files, 188 tests passed; web: 1 file, 3 tests passed                                                                                                                                          |
| `npm run build`     | pass (server `tsc`, web `vite build`)                                                                                                                                                                    |
| Manual smoke        | control-plane setup/migrate, `seed-demo` (dedicated database), `health --all`, API login by slug, platform login, public branding, Chromium rendering of the login, school settings and platform console |

New test areas: secret envelope; entitlement boundaries (unit and API with a movable clock); provisioning, idempotency, crash recovery after every step, concurrent runs, per-school migration, credential rotation including crash-between-steps recovery; role-level cross-database isolation; routing and forged-identifier rejection; full result workflow on dedicated databases; per-school outage isolation; shared→dedicated copy/verify/cut-over/rollback; backup, restore and tamper detection; offboarding guards; trusted-proxy rate limiting; platform/control-plane API.

Phase 1 suites (`workflow`, `rls`) are byte-identical to Phase 1. `tenant` and `guardian` differ only by the login slug and by platform endpoints now answering 401 to school sessions. `auth` and `platform` were rewritten for the new login/platform model: in `auth`, 3 Phase 1 tests (school switching, the multi-school picker, school licence status) were replaced by new-model equivalents; in `platform`, 4 Phase 1 tests were replaced, and the Phase 1 assertion that a platform admin's permission list is exactly `platform.*` was dropped because platform permissions are no longer enforced (a known gap). The Phase 1 exam-validation assertions (empty subject list, duplicate subject) were briefly lost and are restored. The two Phase 1 config tests moved to `config-proxy.test.ts`. The Phase 1 suites are **not** re-run against dedicated databases wholesale; `dedicated.test.ts` re-proves login, isolation, the complete workflow and the published-results guardian rule on dedicated databases (it does not repeat the guardian sibling/cross-school IDOR and pending/revoked-link cases).

## Status and remaining blockers

**Implemented and tested locally:** items in sections 2–5 above.

**Not production-ready.** Do not deploy to schools until at least the following are resolved or consciously accepted:

1. **TLS to the databases — configurable and tested against a disposable server; not verified for your deployment.** `CONTROL_DB_SSL`, `SCHOOL_DB_SSL` and `DB_SSL_CA_FILE` create pools with `{ rejectUnauthorized: true, ca }` (certificate and host name verified). `tls.test.ts` shows, on a disposable PostgreSQL with a throw-away CA, that the control pool, school pools (through the API) and `pg_dump` (`PGSSLMODE=verify-full`) connect with the trusted CA and fail with an untrusted CA, with no CA and for a host name the certificate does not cover. Caveats: a connection-string `sslmode` overrides these options in `pg`; by default every connection is still plaintext; the production certificate chain, certificate rotation and `hostssl` rules are untested.
2. **Network restriction** — `pg_hba.conf`, `listen_addresses` and firewall rules are documented but not configured or verified here. Database-level `CONNECT` is implemented and tested (`petra harden-db-access`, migrations `002`/`003`), but the command needs the cluster owner/superuser once per cluster and must be re-run for databases created by other tools. The tests prove PostgreSQL privileges, not network controls.
3. **Master key management** — environment variable only; no KMS/HSM; no automated backup/recovery of the key. Loss of the key makes stored school credentials unrecoverable (they can be re-issued by an operator with the privileged credential, see DATABASE_ISOLATION.md).
4. **Platform-admin hardening** — no MFA, no password reset/change flow for platform admins, no IP allow-list.
5. **Trusted proxy** — `TRUST_PROXY` logic is tested with simulated `X-Forwarded-For`; it has not been verified behind a real reverse proxy. Rate-limit counters are in process memory (not shared across instances).
6. **Backups** — export/restore/verify procedures (row counts + content digests, optional HMAC-signed manifests, cleanup and retry on failure) exist and were exercised locally; there is no scheduler, off-host storage, encryption of dumps, or restore-time objective. Manifest signing is a shared-secret MAC without non-repudiation. Dumps contain personal data in clear text on disk (mode 0600).
7. **Multi-instance behaviour** — registry/entitlement caches (default 10 s) mean a suspension propagates to other instances within the TTL; connection capacity planning (schools × `SCHOOL_POOL_MAX`) is manual; no PgBouncer.
8. **Monitoring/alerting/log shipping**, dependency scanning, and an external security review are absent. A minimal CI workflow exists (`.github/workflows/ci.yml`, disposable PostgreSQL service with TLS, marker/opt-in configuration, no secrets); it has been validated for YAML syntax only and has **not been run on GitHub**.
9. **Branded EXE / Linux / APK** — configuration generator only; no wrapper project, no build, no signing, no launch test. Native clients also need a token-based session mode (cookies are `SameSite=Strict`).
10. **Payments** — manual ledger only; no gateway, invoices, tax handling or reminder e-mails.
11. **Legal/contractual review** of the 90-day retention and deletion procedure is required before relying on it.
