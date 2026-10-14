# Implementation plan and roadmap

## Phase 1 — foundation (this repository state)

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

## Deferred to Phase 2 (not implemented)

1. Account lifecycle: change/reset password, email verification, MFA, session list/revoke.
2. Idempotency-key table for retried writes; shared-store rate limiting; `trustProxy` configuration.
3. Student portal (activate the reserved role), report cards/PDF, class-wide result summaries, GPA aggregation across subjects.
4. Licence enforcement beyond status/date (`max_students`), billing — payments are out of scope.
5. Logo upload/storage (currently an `https://` URL).
6. Audit-log viewer with filters; data export/erasure tooling.
7. Attendance, timetable, fees, notifications.
8. Per-school custom roles (permissions are fixed per role today).

## Roadmap for clients and offline

1. **Token mode for native clients**: `POST /auth/token` returning a short-lived bearer + refresh token; same authorization pipeline.
2. **Android APK**: wrap the SPA with Capacitor; secure storage for the token; no new business logic.
3. **Desktop**: Tauri (or Electron) wrapper of the same SPA.
4. **Offline marks entry**: IndexedDB drafts, batch sync with idempotency keys, per-row conflict UI using the existing `expected_version`, rejection handling for revoked permissions and locked/published sheets. Design in [ARCHITECTURE.md](ARCHITECTURE.md#offline-first-teacher-marks-entry-planned). **None of this exists yet.**
