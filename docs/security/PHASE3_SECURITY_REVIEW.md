# Phase 3 security review (read-only audit)

|              |                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository   | `ak7shuvo/ShikkhaOS`                                                                                                                                                                                                                                           |
| Commit       | `af7d84ce35a4462075a7042a59d07bab637a5424` (`main`, merge of PR #2 on top of the Phase 2 merge `54bfd71`)                                                                                                                                                      |
| Audit date   | 2026-10-15                                                                                                                                                                                                                                                     |
| Method       | Source reading, `git` history scan, `npm audit`, GitHub Actions run/log inspection. **No application code, configuration, migration, branch or history was changed. No test suite was run in this audit** (see [Checks not performed](#checks-not-performed)). |
| Secret rules | No secret value, cookie, password, token or key is reproduced in this document.                                                                                                                                                                                |

## 1. Executive summary

The code merged into `main` has **no verified Critical vulnerability**. Authentication, session handling, tenant routing and the database-per-school boundary are implemented defensively and are backed by automated tests that passed in CI for the PR head (`0526ae1`, run #3). CI for the merge commit `af7d84c` (run #4) also completed **successfully** (all 15 steps, including the browser E2E and the negative control; step results read from the GitHub API, the run #4 log was not inspected).

The highest-priority issues are not injection or authorization bugs in the school API; they are **concentration of privilege and missing production controls**:

1. **Platform-admin accounts have no MFA, no password change/reset flow, no role separation and no re-authentication for sensitive actions** (H-1). One stolen credential suspends or alters any school, its subscription, branding and payments ledger.
2. **The API process can decrypt every school's database password** (H-2): a single code-execution bug in the API exposes all tenants.
3. **Backups are unencrypted and local** (H-3) and the **production network/TLS posture is unverified** (H-4).
4. **`TRUST_PROXY` is only warned about, not enforced, in production** (M-1), which breaks per-IP rate limiting behind a proxy.

Verified-good properties are listed in [section 4](#4-verified-controls-with-evidence). Everything not backed by code or a test is labelled **UNVERIFIED**.

Severity scale: **Critical** = remote compromise of data or accounts without prior access; **High** = serious impact or major missing control, exploitable with a plausible precondition; **Medium** = meaningful weakness needing specific conditions; **Low** = limited impact or defence-in-depth; **Informational** = no direct risk.

## 2. Scope

In scope (all at the commit above): `server/src` (auth, sessions, routes, tenancy, provisioning, operations, migrations runner), `server/migrations` and `server/control-migrations`, `web/src`, `e2e/`, `.github/workflows/ci.yml`, `package-lock.json` dependencies, `docs/`.

Out of scope / not available: any deployed environment, production or shared databases, network configuration (`pg_hba.conf`, firewalls, reverse proxy), the GitHub repository settings (branch protection, secret scanning, Dependabot), and an external penetration test.

## 3. Findings

Status key: **VERIFIED** = confirmed from code at the cited lines (and, where stated, by a passing test). **UNVERIFIED** = plausible risk not provable from this repository.

### Critical

None found.

### High

#### H-1 Platform-admin accounts: no MFA, no credential lifecycle, no role separation — VERIFIED

- Evidence: `server/src/routes/platform.ts:22-62` (password-only login); no endpoint exists to change or reset a platform-admin password (route list `platform.ts`: only login/logout/me plus school, subscription, release and audit routes); `server/src/context.ts:173-194` (`authenticatePlatform`/`platformAuthz`) grants every route to any active admin — there is no permission model for platform routes; admins are created only via the CLI (`server/src/scripts/petra.ts`, `platform-admin-create`, password from an environment variable).
- Impact: a phished or leaked platform-admin password gives full control of the control plane: suspend or reinstate any school (`platform.ts:157`), edit subscriptions, record payments, change terms (`:287`), change branding, release metadata and read the platform audit log. A suspended school is a denial of service for all its users. The attacker cannot read school data through this API (platform routes use only the control plane), which limits the blast radius.
- Reproduction (safe): read the code; on a disposable cluster, log in with a platform admin and observe that every `/api/platform/*` route is available with no second factor and no step-up.
- Remediation: TOTP MFA (enrolment, recovery codes, enforcement on login); a password-change endpoint that revokes other sessions; a small role model (`read-only`, `billing`, `operator`) enforced per route; step-up re-authentication for suspend/reinstate/terms/payments; optional IP allow-list at the proxy.

#### H-2 The API process can decrypt every tenant's database credential — VERIFIED (design)

- Evidence: `server/src/secrets.ts:5` (master key from `PETRA_MASTER_KEY` environment variable); `server/src/app.ts:44-53` constructs `SecretBox` and `TenantRouter` in the API process; `server/src/tenancy.ts` decrypts `db_secret_enc` for any registry row.
- Impact: any remote code execution, dependency compromise or environment disclosure in the API process exposes all school databases at once, undoing the per-school isolation. The control-plane role can also read and update the encrypted credentials.
- Reproduction: not applicable (architectural).
- Remediation (by effort): restrict who can read the process environment and use a secret manager with the file mounted read-only; move to an external KMS/HSM envelope key with per-use audit; split the credential-decrypting component from the request-handling process; keep the documented rotation and recovery procedure rehearsed.

#### H-3 Backups and exports are unencrypted and stored where they are created — VERIFIED

- Evidence: `server/src/operations.ts` (`exportSchool`: `pg_dump --format=custom`, file mode `0600`, no encryption); manifest HMAC signing is optional and keyed by an environment variable (`PETRA_BACKUP_SIGNING_KEY`) with no non-repudiation (documented in `docs/SCHOOL_PROVISIONING.md`). No scheduler or off-host copy exists.
- Impact: a copy of a dump is a full plaintext copy of a school's personal data (including children's data). Loss of the host loses the only backups.
- Remediation: encrypt dumps at rest (for example `age`/GPG with a key held off-host), ship to separate storage, schedule exports and a periodic restore verification, and treat the signing key as a secret stored away from the backups.

#### H-4 Production network and TLS posture is unverified; default is plaintext — UNVERIFIED (deployment)

- Evidence: `CONTROL_DB_SSL` and `SCHOOL_DB_SSL` default to `false` (`server/src/config.ts`); the TLS behaviour is verified only against a throw-away CA (`server/test/tls.test.ts`); `pg_hba.conf`, `listen_addresses`, firewall rules and the real certificate chain are documentation only (`docs/DATABASE_ISOLATION.md`). Host-name verification is tested for the control pool only.
- Impact: if deployed with defaults, database credentials and personal data cross the network in clear text.
- Remediation: make TLS mandatory in `NODE_ENV=production` (refuse to start when `CONTROL_DB_SSL`/`SCHOOL_DB_SSL` is false), add a deployment checklist with `hostssl` `pg_hba` rules and a post-deploy `pg_stat_ssl` check, and extend the host-name test to the school pool and `pg_dump` (`PGSSLMODE=verify-full`).

### Medium

#### M-1 `TRUST_PROXY` is only a warning in production — VERIFIED

- Evidence: `server/src/config.ts:95-98` (`console.warn` when empty in production); `server/src/app.ts:37` (`trustProxy`); rate limiting is keyed by client IP (`app.ts:75`, `routes/auth.ts:49`, `routes/platform.ts:22`, `routes/public.ts`).
- Impact: behind a reverse proxy with the setting empty, every request appears to come from the proxy address, so one noisy client exhausts the shared limit for everybody (self-inflicted denial of service). Set too wide, clients can spoof `X-Forwarded-For` and evade the per-IP limit (the per-account lockout still applies). The rate-limit counters are also in process memory, so they are per instance.
- Remediation: in production require `TRUST_PROXY` to be set explicitly (a number, `none`, or a CIDR list) and fail start-up otherwise; move the limiter to a shared store when running more than one instance; test the parsing (`server/test/config-proxy.test.ts` already covers `hops`).

#### M-2 Account lockout allows targeted lock-out, including of the only platform admin — VERIFIED

- Evidence: `server/src/routes/auth.ts:79` and `server/src/routes/platform.ts:36` increment a per-account failure counter and lock for `LOGIN_LOCK_MINUTES` regardless of source IP; the school login needs only a known slug and email.
- Impact: an attacker who knows an e-mail address can keep a user (or the single platform admin) locked out. There is no break-glass path except waiting or an operator action.
- Remediation: lock per (account, source IP) with a shorter global threshold, add progressive delay instead of a hard lock, and provide an audited operator unlock command; alert on repeated lockouts.

#### M-3 No Content-Security-Policy or framing protection for the web application — UNVERIFIED (deployment)

- Evidence: `server/src/app.ts:73` disables the API's CSP (acceptable for JSON); `web/index.html` has no CSP; the static host configuration is not in the repository (`docs/SECURITY.md` lists this as a known gap). No XSS sinks were found in `web/src` (no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or tokens in `localStorage`; the session cookie is `httpOnly`).
- Impact: a future XSS or a malicious framing page has no second line of defence.
- Remediation: ship a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`) and HSTS from the static host; add a header regression check to the E2E.

#### M-4 Shared (legacy) mode relies on row-level security alone — VERIFIED (design)

- Evidence: `docs/DATABASE_ISOLATION.md` (shared mode retained for migration/rollback); `server/src/routes/auth.ts:90-95` still has a code path for several schools sharing one user table.
- Impact: schools still in `db_mode='shared'` have weaker isolation than dedicated ones (RLS tests exist in `server/test/rls.test.ts`, but there is no database boundary).
- Remediation: migrate every production school and remove shared mode, following the removal criteria already documented.

### Low

#### L-1 `change-password` has no attempt counter — VERIFIED

`server/src/routes/auth.ts:171-185` verifies the current password but a wrong value does not increment `failed_login_count`; only the global per-IP limit applies. Impact: a thief of an active session can guess the current password at the global rate. Remediation: count and lock failures like login, and require re-authentication for password change after a long-idle session.

#### L-2 School administrators can remove or suspend the last administrator or themselves — VERIFIED

`server/src/routes/school.ts:197-210` (`PATCH /school/members/:id`) has no "last admin" or "self" guard. Impact: self-inflicted lock-out requiring operator `admin-reset`. Remediation: refuse to suspend/remove the last active `school_admin` and require a second confirmation for self-removal.

#### L-3 Operator-chosen initial passwords and console output — VERIFIED

`server/src/routes/school.ts:169,175` accepts an administrator-chosen `initial_password` with no forced change on first login; `server/src/scripts/petra.ts:114-115` prints the first admin's generated password once to the console. Impact: the secret can land in terminal history or a CI log if the command is run in an automated job. Remediation: force a password change at first login, and never run `provision` in CI without masking (`::add-mask::`).

#### L-4 Slug existence is observable — VERIFIED (by design)

`server/src/routes/public.ts:31-36` exposes branding for active, maintenance and suspended schools; `routes/auth.ts:59` returns `503 SCHOOL_MAINTENANCE` before credentials are checked, distinguishing a real slug from an unknown one. Impact: a list of customer school slugs can be enumerated. Remediation: accept as a documented trade-off for branded login, or return the generic failure for maintenance until credentials are verified.

#### L-5 Dependency findings in development tooling — VERIFIED (npm audit, 2026-10-15)

`npm audit --omit=dev` reports **0** vulnerabilities (runtime dependencies are clean). The full audit reports 6 (2 critical, 1 high, 3 moderate), all in development tooling: `vitest` (<=4.1.10) and its `tinypool`, `vite` (<=6.4.2) and `esbuild`; the repository uses `vite ^5.4` and `vitest ^2.1`. Typical advisories concern the Vitest UI server and the Vite dev server (file read/execution when exposed). Impact: limited to developer machines and CI, where the dev server binds to `127.0.0.1` for the E2E. Remediation: upgrade `vite`/`vitest` in a dedicated PR (major versions; fixes are reported as `vite@8.3.4`, `vitest@5.0.4`), never expose the dev servers, and enable Dependabot or equivalent.

#### L-6 CI hygiene — VERIFIED

`.github/workflows/ci.yml`: the PostgreSQL image is a floating tag (`postgres:16`, line 75) rather than a digest; throw-away secrets written to `GITHUB_ENV` (line 98) are visible to all later steps, including `npx playwright install --with-deps` (line 110) and third-party npm code; `.github/` contains only the workflow (no Dependabot, no code scanning, no `CODEOWNERS`). Mitigations already present: workflow `permissions: contents: read`, `persist-credentials: false`, both actions pinned to full SHAs on Node 24, `::add-mask::` for the generated master key and database passwords (the PR #2 CI log showed no unmasked master key and no key-shaped literal). Remediation: pin the image by digest, scope the secrets to the steps that need them, add Dependabot for `github-actions` and `npm`.

### Informational

- **I-1 SQL injection surface — VERIFIED by reading.** All query values are parameters. The only interpolated SQL fragments are constants (`routes/school.ts:116` `EXPORT_TABLES`, `operations.ts` table/database identifiers validated by regex, `shared-migration.ts` constant table specs) and one column list built from a `zod`-validated key set (`routes/platform.ts:303`). There is no negative test that tries to inject through `PATCH …/terms`; add one (section 6).
- **I-2 CSRF — VERIFIED.** `server/src/app.ts:77-82` rejects an unsafe-method request only when an `Origin` header is present and not allow-listed; requests without `Origin` are accepted and rely on `SameSite=Strict` cookies (`routes/auth.ts`, `routes/platform.ts`). Non-browser clients do not carry the victim's cookie, so this is acceptable; do not weaken `SameSite`.
- **I-3 Role-permission cache — VERIFIED.** `server/src/app.ts:51-66` caches role permissions per (school, schema version) with no invalidation; a change in `role_permissions` needs a restart or a schema bump. Not exploitable.
- **I-4 `SECURITY DEFINER` functions — VERIFIED by reading.** `server/migrations/001_init.sql:552-567` and `002_session_idle.sql` pin `search_path`, revoke `EXECUTE` from `PUBLIC` and grant it only to the application role.
- **I-5 Wrong operator hint — VERIFIED.** `POST /platform/schools` returns `next_step: 'An operator must run: npm run school:provision …'` (`routes/platform.ts:146`); the real command is `npm run petra -- provision <slug>`.
- **I-6 E2E negative control scope — VERIFIED.** `e2e/tests/smoke.spec.ts` simulates a broken logout by dropping the browser request (`E2E_SIMULATE_BROKEN_LOGOUT`); it proves the assertions can fail, but it does not mutate the server. A real server-side regression is still caught by the replay assertion (an old cookie must return 401). The E2E covers one browser and one flow.
- **I-7 No secrets in git history — VERIFIED.** A scan of `git log --all -p` added lines for private-key blocks and common token formats found none (pattern based, not a substitute for a dedicated scanner).

## 4. Verified controls (with evidence)

| Area                | Control                                                                                                                                                           | Evidence                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Passwords           | argon2id, constant-time unknown-user path, minimum 10 characters                                                                                                  | `server/src/passwords.ts`; `routes/auth.ts:49-95`                                                          |
| Session tokens      | 256-bit random token, only its SHA-256 stored, httpOnly + SameSite=Strict cookie, `Secure` enforced in production, idle timeout, TTL, per-user session cap        | `passwords.ts:22-23`; `routes/auth.ts:17-24`; `context.ts`; `config.ts:92-94`                              |
| Logout              | works in suspended/blocked/maintenance/offboarding states, deletes only the presented session, clears the cookie                                                  | `routes/auth.ts` (`/auth/logout`); `server/test/logout.test.ts` (10 tests); `e2e/tests/smoke.spec.ts` (CI) |
| Tenant isolation    | cookie's school id is a routing hint only; the token must exist in that school's own database; per-school database and role; school role cannot connect elsewhere | `context.ts` (`authenticate`); `server/test/db-access.test.ts`, `dedicated.test.ts`, `tenant.test.ts`      |
| Subscription gates  | blocked/read-only enforced server-side on every school route                                                                                                      | `context.ts` (`authz`); `server/test/subscriptions.test.ts`                                                |
| Retention           | 90-day minimum enforced in API, database CHECK and entitlement code                                                                                               | `routes/platform.ts:294`; `control-migrations/003_retention_minimum.sql`; `server/test/retention.test.ts`  |
| Migration safety    | per-school 64-bit advisory lock, audited recovery commands, no blind activate/discard                                                                             | `shared-migration.ts`; `server/test/migration-recovery.test.ts`                                            |
| Backup/restore      | row counts and content digests, scratch-database cleanup, retryable offboarding                                                                                   | `operations.ts`; `server/test/backup-hardening.test.ts`                                                    |
| Secrets             | AES-256-GCM bound to the school id, rotation with pending slot, compare-and-swap re-encryption                                                                    | `secrets.ts`; `server/test/secrets-rotation.test.ts`                                                       |
| Database ACLs       | `PUBLIC CONNECT` revoked on control, shared, maintenance and school databases; health check reads the real ACL                                                    | `db-access.ts`; `migrations/003_database_acl.sql`; `db-access.test.ts`                                     |
| Error handling/logs | generic 500s, DB constraint errors mapped to safe messages, cookie/authorization headers redacted from logs                                                       | `app.ts:35,87-110`                                                                                         |
| Destructive tests   | opt-in flag, cluster marker, loopback only, strict database-name patterns, cleanup limited to attributable objects; reused by the E2E setup and config            | `server/test/safety.ts`, `test-safety.test.ts`; `e2e/prepare.ts`, `e2e/playwright.config.ts`               |
| E2E isolation       | API started with an explicit minimal environment, never reuses a running server, credentials never printed, failure output contains booleans not tokens           | `e2e/start-api.mjs`, `e2e/playwright.config.ts`; CI run #3                                                 |
| CI                  | read-only token, SHA-pinned actions on Node 24, loopback-only throw-away PostgreSQL with TLS and per-run random passwords, master key masked                      | `.github/workflows/ci.yml`; run #3 log inspection (no unmasked key)                                        |

## 5. Production blockers and required mitigations

| #   | Blocker                                                            | Required before production                                                             |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B-1 | H-1 no MFA / credential lifecycle / RBAC for platform admins       | MFA enforced; password change; per-route roles; step-up for destructive actions        |
| B-2 | H-4 TLS optional and unverified; no `pg_hba`/firewall verification | TLS mandatory in production; `hostssl` rules; post-deploy `pg_stat_ssl` and ACL checks |
| B-3 | H-3 unencrypted, unscheduled, same-host backups                    | Encrypted off-host backups, schedule, restore drill, key recovery documented           |
| B-4 | H-2 master key in the API environment                              | Secret manager at minimum; KMS preferred; rehearsed key rotation and recovery          |
| B-5 | M-1 `TRUST_PROXY` not enforced; per-process rate limiter           | Fail start-up without an explicit value; shared limiter for multi-instance             |
| B-6 | M-3 no CSP/HSTS/framing control on the static host                 | Strict headers on the host; verified in E2E                                            |
| B-7 | M-4 shared mode                                                    | Remove after migrating all schools                                                     |
| B-8 | Legal review of retention and children's data                      | Counsel sign-off (not a code issue)                                                    |

Also still open from earlier phases: a monitoring/alerting pipeline, an independent penetration test and dependency/secret scanning in CI.

## 6. Prioritized remediation plan (small, independently testable PRs)

1. **PR-A: production start-up guards.** Refuse to start in production unless `TRUST_PROXY` is explicit and both DB TLS flags are true. Test: `config-proxy.test.ts` additions. _(M-1, H-4)_
2. **PR-B: platform-admin password change + session revocation.** New endpoint, revokes other sessions, audited. Test: API tests plus a lockout-counter test. _(H-1, L-1 pattern)_
3. **PR-C: platform-admin TOTP MFA.** Enrolment, verification at login, recovery codes, enforcement flag. Test: wrong/replayed code, recovery code single use, enrolment required. _(H-1)_
4. **PR-D: platform RBAC + step-up.** Roles on platform routes and re-authentication for suspend/reinstate/terms/payments. Test: per-route authorization matrix. _(H-1)_
5. **PR-E: lockout redesign.** Per-(account, IP) counters, operator unlock command, alert hook. Test: attacker from IP A cannot lock the owner on IP B. _(M-2)_
6. **PR-F: last-admin guard and forced first-login password change.** Test: cannot remove the last `school_admin`; first login requires change. _(L-2, L-3)_
7. **PR-G: encrypted backups.** `age`/GPG wrapper in `export`, restore decrypts, key handling documented. Test: ciphertext differs from plaintext, tamper detection, restore round-trip. _(H-3)_
8. **PR-H: dependency and CI hygiene.** Upgrade `vite`/`vitest`, pin the PostgreSQL image digest, scope CI secrets per step, add Dependabot. Test: CI green, `npm audit` clean. _(L-5, L-6)_
9. **PR-I: static-host security headers + E2E header check.** _(M-3)_
10. **PR-J: external secret manager / KMS design and migration.** Larger; plan separately. _(H-2)_

## 7. Recommended security regression tests

- Platform: login rejects without MFA when enforced; MFA code replay rejected; recovery code works once; password change revokes other platform sessions; every `/api/platform/*` route returns 403 for an under-privileged role.
- Authentication: wrong `change-password` attempts lock the account; a lockout from one IP does not lock the owner on another; logout still works for every school state (already present) and for the platform session.
- Tenant isolation: a cookie issued by school A is rejected by school B's database even with B's school id (partly present in `dedicated.test.ts`); platform session cookie is not accepted on school routes and vice versa (path `/api/platform`).
- Input: injection strings through `PATCH …/terms`, `school`/`email` login fields and `:id` parameters return 400 and never reach SQL (assert the stored row is unchanged).
- CSRF: a state-changing request with a foreign `Origin` returns 403 for school and platform routes; with `SameSite` unchanged in `Set-Cookie`.
- Secrets/logs: error responses and logs for a failed login, a failed restore and a failed provisioning contain no password, cookie, token, connection string or master key (capture the logger output in a test).
- Configuration: production start-up fails for empty `TRUST_PROXY`, `COOKIE_SECURE=false`, non-HTTPS origins, plaintext DB TLS.
- Backups: encrypted dump is not readable without the key; manifest tamper is detected with a key configured (present), and restore refuses an unsigned manifest when signing is required.
- CI/E2E: workflow lint that fails if an action is not pinned to a 40-character SHA or if `permissions` is missing; a server-side mutation negative control (a deliberately no-op logout handler built only in the test run) to prove the replay assertion fails.

## Checks not performed

- The server (274 tests) and web test suites were **not re-run** in this audit: they need the destructive disposable-cluster setup, which was out of scope for a read-only review. Test status is taken from CI run #3 (PR head `0526ae1`: success, 274 server tests, 3 web tests, 1 E2E, negative control failing as intended) and from the earlier local runs. CI run #4 on the merge commit `af7d84c` completed with conclusion `success` (step results only; its log was not read).
- No dynamic testing, fuzzing, penetration testing, or load testing was done.
- No scan with a dedicated secret scanner or SAST tool; only pattern searches and reading.
- GitHub repository settings (branch protection, required checks, secret scanning, Dependabot alerts) were not inspected.
- No review of a deployed environment, reverse proxy, TLS certificates, `pg_hba.conf`, or operating-system hardening.
- The mobile/desktop client builds (EXE, Linux, Android) do not exist and were not assessed.
