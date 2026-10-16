# Security

Describes what is implemented on branch `feat/phase-2-db-per-school`. Unimplemented or unverified items are in [Known limitations and production blockers](#known-limitations-and-production-blockers). Test evidence: 188 server tests (real PostgreSQL roles/databases) and 3 web tests passed in the development environment; this does not by itself establish production readiness.

## Trust boundaries

| Boundary                        | Enforced by                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| School ↔ school                 | Separate database + separate credentials per school (registry-routed), RLS and composite FKs inside each database, per-school accounts and sessions  |
| School users ↔ Petra staff      | Different stores (school DB vs control plane), different cookies (`sid` vs `psid`, path `/api/platform`), platform API never uses school credentials |
| API ↔ privileged DB operations  | The API has no CREATEDB/CREATEROLE credential; provisioning/migration/export/offboarding run from the operator CLI with `PROVISIONER_DATABASE_URL`   |
| Client input ↔ tenant selection | Tenant comes from the registry row of the authenticated session; slugs only look rows up                                                             |

See [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md) for roles, secrets and the network requirements.

## Authentication

- Per-school accounts: `POST /api/auth/login` `{school, email, password}`. Passwords: **argon2id** (`@node-rs/argon2` defaults), minimum 10 characters when set through the API. Unknown school, unready school, unknown e-mail, wrong password, disabled and locked accounts all return the identical `401 INVALID_CREDENTIALS`, with an Argon2 verification burned for unknown users (timing equalisation). A blocked subscription or suspended school is revealed **only after** the credentials verified.
- Cookie `sid=<school id>.<256-bit random token>`: `HttpOnly`, `SameSite=Strict`, `Secure` (default in production; production refuses `COOKIE_SECURE=false`). Only the SHA-256 of the token is stored, in the school's own database. The school id prefix is a routing hint: the session must exist in that school's database **and** its `active_school_id` must equal the registry id (forged prefixes tested).
- Sessions: absolute TTL `SESSION_TTL_HOURS` (12), **idle timeout** `SESSION_IDLE_MINUTES` (120), at most `MAX_SESSIONS_PER_USER` (5; oldest evicted), logout deletes the row, `POST /api/auth/change-password` verifies the current password and revokes all other sessions. Membership/user/school/subscription changes take effect on the next request (subject to the registry cache TTL across instances).
- **Rate limiting:** `@fastify/rate-limit` per client IP: `LOGIN_RATE_LIMIT_PER_MINUTE` (10) on login endpoints, `API_RATE_LIMIT_PER_MINUTE` globally, 60/min on public endpoints. **Trusted proxy:** `TRUST_PROXY` empty means `X-Forwarded-For` is ignored (a spoofed header cannot evade limits — tested); a number trusts exactly that many proxy hops from the TCP peer; otherwise a list of proxy IPs/CIDRs. Counters are in process memory.
- **Lockout:** `LOGIN_MAX_FAILURES` (5) consecutive failures lock the account for `LOGIN_LOCK_MINUTES` (15), per school database / control plane.
- Platform admins: control-plane accounts with the same hashing, lockout, idle/absolute timeouts and session cap; separate cookie scoped to `/api/platform`.
- Secrets: nothing hard-coded; configuration validated at startup. Per-school database passwords are random 256-bit, stored AES-256-GCM encrypted (school id as AAD) with `PETRA_MASTER_KEY` from the environment. Logs redact cookies and authorization headers; request bodies are never logged; passwords never appear in responses or audit metadata (tested). Provisioning errors are sanitised (the credential is redacted).

## CSRF / browser hardening

`SameSite=Strict` cookies, plus rejection of non-GET requests whose `Origin` is not in `ALLOWED_ORIGINS`. `@fastify/helmet` headers (CSP disabled for the JSON API; set one on the static host). Responses under `/api` carry `Cache-Control: no-store`.

## Authorization

Every school route runs `authz()`: valid session in the registry-resolved school → school status (`active`) → **subscription entitlement** (`blocked` → 403, `read_only` → non-GET 403) → required permissions. Roles and permissions are unchanged from Phase 1 (teacher assignment checks, self-review ban, 404 instead of 403 for unassigned sheets, guardian verified-link restriction, reserved Student role). Platform routes require a platform session and nothing else.

### Roles and permission boundaries (school scope)

| Role                   | Permissions                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| School Admin           | school.view/manage, members.manage, academic.view/manage, students.view, exams.manage, result.view, audit.view              |
| Principal / Management | school.view, academic.view, students.view, result.view, **result.review, result.publish, result.correct**, audit.view       |
| Exam Controller        | school.view, academic.view, students.view, exams.manage, result.view, **result.review, result.publish, result.correct**     |
| Teacher                | school.view, academic.view, **marks.enter, result.submit** — only for sheets matching an active `teacher_assignments` row   |
| Guardian               | `guardian.portal` — only students with a **verified** link to their own guardian profile                                    |
| Student (reserved)     | none; cannot be assigned; no endpoints                                                                                      |
| Platform Super Admin   | not a school role; the control-plane API only (`/api/platform/*`) — no access to any school's academic data through the API |

## Tenant isolation (layers)

1. **Separate database and role per school**; the registry row selects the pool; first connect verifies database/role identity and that the role is unprivileged.
2. Authentication is evaluated **inside** the school database; tokens are not portable across schools.
3. Phase 1 layers inside each school database: application predicates, RLS on `school_id`, composite FKs, immutability/append-only triggers.
4. Startup guard: API refuses to start if the control or shared role is a superuser or bypasses RLS.
5. `SECURITY DEFINER` functions (`auth_user_by_email`, `auth_session_by_hash`) expose fixed column lists and pin `search_path`.

What the tests prove: school A's PostgreSQL role cannot connect to school B's database and vice versa, cannot create databases/roles/tables, and writes land only in its own database (`provisioning.test.ts`); API-level cross-school login, cookie forgery and identifier-injection attempts fail and the workflow/guardian rules hold on dedicated databases (`dedicated.test.ts`); the Phase 1 RLS and IDOR suites still pass in shared mode (`rls.test.ts`, `tenant.test.ts`).

## Results integrity

Unchanged from Phase 1 and carried into every dedicated database (also by the shared→dedicated copy, which preserves history and re-enables the guard trigger): fixed transition table, row-locked transactions (parallel submit/publish → exactly one success), `marks_guard` trigger, immutable `published_results` rows, append-only `result_events`/`result_versions`/`audit_events`, explicit corrections with reasons and new revisions.

## Audit logging

- School audit (`audit_events`, in each school database): school actions, including login, password change, export, branding.
- **Platform audit** (`platform_audit_events`, control plane, append-only for the app role): platform login, school registration/provisioning/status changes, subscription events, payments, branding, releases, build profiles, credential rotation, export, offboarding, shared→dedicated migration and rollback.
- Audit metadata never contains passwords, tokens or credentials.

## Subscription and data-protection controls

Entitlements are enforced server-side on every request (see [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md)). Expiry never deletes data; deletion only through the explicit, retention-gated, confirmed offboarding procedure with a restore-verified export.

## Dependencies

Runtime: `fastify`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@node-rs/argon2`, `pg`, `zod`; web: `react`, `react-dom`, `react-router-dom`. No new runtime dependency was added in Phase 2. `npm audit --omit=dev` reports 0 vulnerabilities at the time of writing (run it again before release). Dev tooling (vitest/vite/esbuild dev servers) has known moderate advisories that affect development machines only.

## Known limitations and production blockers

Do not treat local test results as production readiness. Open items:

1. **TLS** to PostgreSQL: `CONTROL_DB_SSL` / `SCHOOL_DB_SSL` (+ optional `DB_SSL_CA_FILE`) enable verified TLS (certificate and host name) for the control, shared and school pools; trusted-CA success and untrusted-CA failure are covered by `tls.test.ts` against a disposable TLS server (skipped, and reported as skipped, when the CA material is not configured). The default is still plaintext, and the production certificate chain, `hostssl` `pg_hba` rules and libpq settings for operator tools are **not verified**. **Network restriction** (`pg_hba`, firewall, private listen address) is documented only. `CONNECT` on the control, shared, maintenance and school databases **is** restricted and tested (DATABASE_ISOLATION.md), but a cluster owner must run `harden-db-access` once; databases created later by other tools start open.
2. **Master key** is an environment variable: no KMS/HSM, no automated recovery. Any reader of the API process environment can decrypt all school credentials. The control-plane role can read/update registry rows (including encrypted credentials).
3. **Platform admins** have TOTP MFA (mandatory in production, replay-protected, recovery codes, MFA reset only via the operator CLI) and a password-change flow, three roles (`owner`, `operator`, `viewer`) and a recent-second-factor step-up before destructive actions (mandatory in production), but no IP allow-list; a compromised `owner` account that also passes the second factor can still suspend/activate schools and rewrite branding and subscription data, and there is no separate approver for the most destructive actions.
4. **Trusted proxy** logic is verified only with simulated headers; **rate limiting** is per-process memory (not shared across instances); no CAPTCHA/IP reputation.
5. **Registry/entitlement cache** (default 10 s) delays suspension propagation across multiple API instances; maintenance mode waits `ENTITLEMENT_CACHE_SECONDS + 2` s in the CLI.
6. **Backups**: no scheduling, no off-host storage, **dumps and exports are unencrypted** (file mode 0600 only), no tested RPO/RTO. The offboarding export contains personal data. Manifests carry row counts and content digests and can be HMAC-signed with `PETRA_BACKUP_SIGNING_KEY` (shared-secret: tamper-_evident_ only against someone without the key, no non-repudiation; unsigned manifests are **not** tamper-proof). The key is an environment variable, like the master key.
7. **No password reset / e-mail verification / MFA for school users**; the first admin password is handed over by an operator. School admins can create accounts with a chosen initial password.
8. Lockout enables targeted denial of service against a known e-mail/school (accepted trade-off).
9. **Shared mode** still exists (migration/rollback path) and relies on Phase 1 RLS-only isolation for those schools; Phase 1's `school_licenses` table is unused legacy.
10. The guardian restriction is enforced in API queries (verified-link join), not by an extra RLS policy.
11. Cookie `SameSite=Strict` requires same-site hosting; native clients need a token mode (not implemented). No CSP is set by the API.
12. Search/log/metrics pipeline, intrusion detection, dependency scanning and an independent security review/penetration test are absent. A minimal CI workflow (lint, typecheck, server and web tests, build) exists in `.github/workflows/ci.yml`; it has not been run on GitHub from this environment. Logging of connection failures is minimal by design (no secrets), which also limits diagnosability.
13. Legal retention/deletion obligations (including for children's data) have not been reviewed.
