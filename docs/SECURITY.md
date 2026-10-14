# Security

Describes what is implemented. Unimplemented items are listed under [Known limitations](#known-limitations).

## Authentication

- Email + password managed by the application. Hashes: **argon2id** (`@node-rs/argon2` defaults). Minimum length 10 for passwords set through the API.
- `POST /api/auth/login` sets cookie `sid`: random 256-bit token, `HttpOnly`, `SameSite=Strict`, `Secure` (default on in production; production refuses `COOKIE_SECURE=false`). Only the SHA-256 hash of the token is stored (`sessions.token_hash`). TTL `SESSION_TTL_HOURS` (default 12). Logout deletes the session row.
- Identical `401 INVALID_CREDENTIALS` for unknown email, wrong password, disabled and locked accounts; an Argon2 verification is still burned for unknown emails (timing equalisation).
- **Rate limiting:** `@fastify/rate-limit` — `LOGIN_RATE_LIMIT_PER_MINUTE` (default 10) per IP on login, `API_RATE_LIMIT_PER_MINUTE` globally. In-memory per process: behind several instances or a proxy, use a shared store and set `trustProxy` correctly (not configured yet).
- **Account lockout:** `LOGIN_MAX_FAILURES` (default 5) consecutive failures lock the account for `LOGIN_LOCK_MINUTES` (default 15); success resets the counter. (A lockout can be used to deny service to a known email; accepted trade-off for Phase 1.)
- Secrets: nothing is hardcoded. All configuration is validated at startup with zod (`server/src/config.ts`). `.env` is git-ignored; `.env.example` has placeholders only. No default users exist; demo users exist only when `db:seed` is run (refused in production) and use `DEV_SEED_PASSWORD` from your environment.
- Logging: request bodies, cookies and `Authorization` are never logged (redacted). Passwords are only held in memory during hashing; audit metadata contains no credentials (tested).

## CSRF / browser hardening

`SameSite=Strict` cookie, plus a server check that rejects non-GET requests whose `Origin` is not in `ALLOWED_ORIGINS`. `@fastify/helmet` headers (CSP disabled for now because the API serves JSON only; set a CSP on whatever serves `web/dist`). API responses carry `Cache-Control: no-store`.

## Authorization

Every protected route uses the `authz()` preHandler (server-side): valid session → active school derived from memberships → school `active` → licence `trial|active` and not past `ends_on` → required permissions. Missing session → 401; missing permission → 403; no school selected → 409 `SCHOOL_CONTEXT_REQUIRED`.

### Roles and permission boundaries

| Role (scope)                    | Permissions                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Platform Super Admin (platform) | `platform.schools.manage`, `platform.licenses.manage`. **No** school data access. Not a membership role.                            |
| School Admin                    | school.view/manage, members.manage, academic.view/manage, students.view, exams.manage, result.view, audit.view                      |
| Principal / Management          | school.view, academic.view, students.view, result.view, **result.review, result.publish, result.correct**, audit.view               |
| Exam Controller                 | school.view, academic.view, students.view, exams.manage, result.view, **result.review, result.publish, result.correct**             |
| Teacher                         | school.view, academic.view, **marks.enter, result.submit** — effective only for sheets matching an active `teacher_assignments` row |
| Guardian                        | `guardian.portal` — only students with a **verified** link to their own guardian profile                                            |
| Student (reserved)              | none; cannot be assigned through the API; no student endpoints                                                                      |

Additional rules enforced in code:

- Teacher access to a sheet requires an assignment for the same academic year, class, subject and (section or all sections). Sheets a teacher is not assigned to return **404**, not 403 (no existence oracle).
- A submitter cannot start review, approve or return their own submission (`SELF_REVIEW`).
- School admins can create accounts but cannot assign `student` or `platform_super_admin`.
- Platform admins cannot switch into a school and receive 409 on every school route.

## Tenant isolation

Layers, from outermost to innermost:

1. **Context from the server.** Active school = validated membership; never a client parameter.
2. **Application predicates.** Queries filter on `school_id` and verify related ids (e.g. enrollment ∈ sheet's section, class ↔ section) with explicit errors.
3. **PostgreSQL row-level security** (`FORCE` is not used; the API connects as `shikkha_app`, which is not the table owner). Every school-owned table has `USING/WITH CHECK (school_id = app_school_id())`. `app_school_id()` reads the transaction-local `app.school_id`. With no context, tables return zero rows. `schools`, `school_memberships`, `users`, `sessions`, `school_licenses`, `audit_events` have specific policies (see [DATABASE.md](DATABASE.md#row-level-security)).
4. **Composite foreign keys** `(school_id, id)` make cross-school references impossible even for privileged writers.
5. **Startup guard:** the API refuses to start if its DB role is a superuser or has `BYPASSRLS`.

`SECURITY DEFINER` functions (`auth_user_by_email`, `auth_session_by_hash`) exist only so authentication can run before a user context exists; they expose a fixed column list and have `search_path` pinned.

### What the tests prove

`server/test/rls.test.ts` (real policies via the restricted role): no context → no rows; school A context cannot read/update/insert school B rows; cross-school FK blocked; school context cannot create platform admins or schools; platform context sees schools but zero tenant rows; context does not leak across pooled connections.
`server/test/tenant.test.ts`: with real School B record IDs, a School A user gets 404/400/409 and nothing changes on read, marks write, workflow transition, enrollment, exam, guardian link, membership and teacher assignment endpoints; a client-supplied `school_id` (body/query/header) is ignored or rejected.

## Results integrity

- Transitions are checked against a fixed table (`workflow.ts`); anything else is `409 INVALID_TRANSITION`.
- Every transition runs in one transaction holding a row lock (`SELECT … FOR UPDATE`) on the sheet, so concurrent identical requests produce exactly one success (tested with parallel submit/publish).
- `marks_guard` trigger: marks cannot change unless the sheet is `draft`/`returned`, and cannot exceed the exam maximum — enforced even for the table owner.
- `published_results` rows are immutable except `superseded_at`; `result_events`, `result_versions`, `audit_events` are append-only (triggers; the app role also has no UPDATE/DELETE grant on them).
- Corrections: only `result.correct` holders, reason mandatory; the sheet starts a new revision, guardians keep seeing the previously published revision until the corrected one is published, and old revisions are retained.

## Dependencies

Minimal runtime dependencies: `fastify`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@node-rs/argon2`, `pg`, `zod`; web: `react`, `react-dom`, `react-router-dom`. `npm audit --omit=dev` reports 0 vulnerabilities at the time of writing (react-router-dom 7.x). `npm audit` including dev tooling still reports moderate advisories in vitest/esbuild/vite dev servers (development only; upgrade to vitest 4+/vite 6+ in Phase 2). Re-run it for current state.

## Known limitations

- No password reset, email verification, MFA or "change password" endpoint yet. Initial passwords set by an admin are the user's real password until a change flow exists.
- Rate limiting is per-process memory; `trustProxy` is off (client IP behind a proxy would be the proxy). Configure before deploying behind a load balancer.
- Account existence can be inferred by an admin creating a member with a duplicate email (409).
- Student/guardian personal data is stored unencrypted at the application level (disk/DB encryption is the deployer's responsibility); no data-retention or export/erase tooling.
- The guardian-only restriction is enforced in the API queries (verified link join), not by a dedicated RLS policy.
- The licence check performs one extra query per request.
- Audit log has no UI filters/pagination beyond the latest 100 events.
- No automated penetration test or dependency-review pipeline; no CI configured in this repository.
- Production topology (TLS termination, same-site hosting of UI and API, backups) is documented only as requirements, not automated.
