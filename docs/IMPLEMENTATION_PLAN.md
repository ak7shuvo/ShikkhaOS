# Implementation plan and roadmap

## Phase 1 — foundation (commit `ca0a19a`)

| Area                                                                 | Status                   |
| -------------------------------------------------------------------- | ------------------------ |
| Repo structure, config validation, lint/format/typecheck/build       | Done                     |
| Schema + migration runner, restricted DB role, RLS                   | Done                     |
| Auth (argon2id, sessions, lockout, rate limit), RBAC, platform scope | Done                     |
| School profile/settings, members, licence metadata, audit trail      | Done (API + UI)          |
| Academic structure, students/enrolments, guardians, assignments      | Done (API + UI)          |
| Exams, marks entry + validation, grading policies                    | Done (API + UI)          |
| Result workflow, snapshots, corrections                              | Done (API + UI)          |
| Guardian portal (linked students, exams, published results)          | Done (API + UI)          |
| Tenant isolation, workflow, guardian, auth, validation tests         | Done (80 server + 3 web) |
| UI: responsive shell, Bengali/English, reusable components           | Done                     |
| Browser E2E tests of all UI flows                                    | **Not done**             |
| CI pipeline, deployment automation                                   | **Not done**             |

## Phase 2 — Petra commercial multi-school architecture (branch `feat/phase-2-db-per-school`)

| Area                                                                                                                | Status                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Audit of Phase 1 and migration plan                                                                                 | Done ([PHASE2_ARCHITECTURE.md](PHASE2_ARCHITECTURE.md))               |
| Control plane (registry, branding, subscriptions, platform admins, releases, build profiles, platform audit)        | Done (schema, API, minimal console UI)                                |
| Database-per-school with per-school roles; registry-routed `TenantRouter`                                           | Done, tested on real roles/databases                                  |
| Idempotent provisioning, crash recovery, per-school migrate/health, credential rotation                             | Done, tested                                                          |
| Encrypted credentials (AES-256-GCM, env master key), rotation procedures                                            | Done (no KMS)                                                         |
| Subscription lifecycle: monthly/annual, trial/grace/read-only/blocked, exact boundaries, manual payments, retention | Done, tested (no payment gateway)                                     |
| Data export, backup/restore/verify, offboarding with guards                                                         | Done as operator procedures, tested locally; no scheduling/encryption |
| Shared→dedicated migration with verification and rollback; shared mode retained only for that                       | Done, tested                                                          |
| Session idle timeout/cap, change-password, trusted-proxy handling                                                   | Done (proxy verified with simulated headers only)                     |
| Branding configuration; per-school build profile generator                                                          | Done (configuration only)                                             |
| EXE / Linux package / Android APK builds                                                                            | **Not done** — no wrapper projects, builds, signing or launch tests   |
| TLS, `pg_hba`/firewall, KMS, MFA for platform admins, shared rate-limit store, monitoring, CI, backups scheduling   | **Not done** — production blockers                                    |

## Deferred (not implemented)

1. Account lifecycle for school users: password reset, e-mail verification, MFA; platform-admin MFA and password management.
2. Idempotency-key table for retried writes; shared-store rate limiting; verified reverse-proxy deployment.
3. Student portal (activate the reserved role), report cards/PDF, class-wide result summaries, GPA aggregation across subjects.
4. Payment gateway, invoices, reminders, self-service renewal, per-plan limits.
5. Logo upload/storage (currently an `https://` URL).
6. Audit-log viewer with filters; data erasure tooling beyond the offboarding procedure.
7. Attendance, timetable, fees, notifications.
8. Per-school custom roles.
9. Token-based sessions for native clients, Capacitor/Tauri projects, signed builds, offline marks entry with synchronisation (design in [ARCHITECTURE.md](ARCHITECTURE.md#designed-for-later-phases--not-implemented)).
10. Removal of shared mode (criteria in [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md#removing-shared-mode)).

## Roadmap for clients and offline

1. **Token mode for native clients**: `POST /auth/token` returning a short-lived bearer + refresh token; same authorization pipeline.
2. **Android APK**: wrap the SPA with Capacitor; secure storage for the token; no new business logic.
3. **Desktop**: Tauri (or Electron) wrapper of the same SPA.
4. **Offline marks entry**: IndexedDB drafts, batch sync with idempotency keys, per-row conflict UI using the existing `expected_version`, rejection handling for revoked permissions and locked/published sheets. Design in [ARCHITECTURE.md](ARCHITECTURE.md#offline-first-teacher-marks-entry-planned). **None of this exists yet.**
