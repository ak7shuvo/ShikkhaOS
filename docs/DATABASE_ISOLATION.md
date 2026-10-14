# Database isolation (database-per-school)

## Model

Every school has a **dedicated logical PostgreSQL database** `sk_<12 hex of the school id>` and a **dedicated login role** `sk_<12 hex>_app`. Both names are derived by the server from the registry id and validated against `^sk_[a-f0-9]{12}(_app)?$` before use in DDL. They never come from request data.

| Principal                           | Where it lives                                                | Privileges                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sk_<id>_app` (school runtime role) | credential encrypted in `petra_control.schools.db_secret_enc` | `CONNECT` on its own database only; `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`; `CONNECTION LIMIT 20`; `statement_timeout 30s`; `idle_in_transaction_session_timeout 60s`; table grants identical to Phase 1's `shikkha_app` (no DELETE except sessions; INSERT-only on append-only tables). `PUBLIC` has no privileges on the database or its `public` schema. |
| `petra_control_app`                 | `CONTROL_DATABASE_URL`                                        | Least privilege on the control plane (see PHASE2_ARCHITECTURE.md §3).                                                                                                                                                                                                                                                                                                                |
| provisioner                         | `PROVISIONER_DATABASE_URL`, operator host only                | `CREATEDB`/`CREATEROLE`. **Never** configured in the API process. Also used for per-school migrations, export and offboarding.                                                                                                                                                                                                                                                       |
| legacy `shikkha_app`                | `SHARED_DATABASE_URL`                                         | Only while a school is `db_mode='shared'`.                                                                                                                                                                                                                                                                                                                                           |

Inside each school database the Phase 1 defences remain: RLS keyed on `app.school_id`, composite foreign keys, immutability triggers. The database holds exactly one `schools` row (the school's id from the registry). Users, memberships and sessions are per-school tables.

## Registry and routing

`petra_control.schools` is the **trusted server-side registry**. It is the only source of `db_host`, `db_port`, `db_name`, `db_role` and the encrypted password. `TenantRouter` (`server/src/tenancy.ts`):

- looks up a registry row by slug (login, public endpoints) or by school id (session cookie prefix);
- refuses non-`active` schools (`SCHOOL_SUSPENDED`, `SCHOOL_OFFBOARDED`, `SCHOOL_MAINTENANCE`, `TENANT_NOT_READY` / `TENANT_UNAVAILABLE`);
- creates a pool lazily per school (`SCHOOL_POOL_MAX` connections each), keeps at most `MAX_SCHOOL_POOLS` open (LRU eviction), and rebuilds a pool when the registry credential/host changes;
- on first connect verifies `current_database()` and `current_user` equal the registry values and that the role is not superuser / `BYPASSRLS` — a mismatched registry row cannot cross over (tested, including a credential copied from another school's row);
- converts connectivity/credential failures into a per-school `503 TENANT_UNAVAILABLE` without leaking host, database or role names, and drops the pool so the next request retries (tested: one school's database outage does not affect another).

Databases are **never created per request**. They are created only by the provisioning workflow ([SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md)).

## Secret management

- Per-school passwords are generated randomly (256-bit) and stored **encrypted** with AES-256-GCM (`server/src/secrets.ts`). The school id is bound as authenticated data, so a ciphertext copied to another school's row fails to decrypt.
- The master key is `PETRA_MASTER_KEY` (base64, 32 bytes), `PETRA_MASTER_KEY_ID` names it. It is **not** committed, **not** stored in any database, and must not be stored next to database backups. Generate with `npm run petra -- generate-master-key`.
- **This is not an external KMS.** Anyone who can read the API process environment can decrypt every school's credential. Use the platform's secret manager (or at minimum a root-owned `0600` environment file / systemd credential) to inject it.

### Backup and recovery of the master key

- Keep at least two independent copies of the key in separate secure locations controlled by different people (for example an organisational password vault and a sealed offline copy). Never place it in the same backup set as the control-plane database dump.
- Without the key the registry credentials are unreadable. Recovery path if the key is lost: with the privileged credential an operator can reset each school role's password (`ALTER ROLE`) and write a new encrypted credential; the school data is unaffected. This is slow and manual, so protect the key.

### Rotation

| Rotation                   | Procedure                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Master key                 | Set `PETRA_MASTER_KEY` to the new key and `PETRA_MASTER_KEY_ID` to a new id; set `PETRA_MASTER_KEY_PREVIOUS[_ID]` to the old one; restart; run `npm run petra -- reencrypt-secrets`; confirm all rows are on the new id; then remove the previous key.                                                       |
| School database credential | `npm run petra -- rotate-secret <slug>`: writes a new encrypted secret into a **pending** slot, runs `ALTER ROLE … PASSWORD`, then promotes it. A crash between the steps is safe: the router retries with the pending secret when the current one is rejected, and re-running the command resumes (tested). |
| Control-plane password     | `npm run control:setup` with the new `CONTROL_APP_PASSWORD`, then update `CONTROL_DATABASE_URL` and restart.                                                                                                                                                                                                 |

### Failure behaviour

| Failure                             | Behaviour                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PETRA_MASTER_KEY` missing/invalid  | API refuses to start (config validation).                                                                                             |
| Wrong key / tampered ciphertext     | That school's requests fail with `503 TENANT_UNAVAILABLE` (generic message); other schools keep working; nothing sensitive is logged. |
| School database down / role revoked | `503 TENANT_UNAVAILABLE` for that school only; recovers automatically when the database is back.                                      |
| Control plane down                  | No logins or authenticated requests for any school (the registry is needed on every request, apart from the short cache).             |

## Database-level access control (`CONNECT`)

PostgreSQL grants `CONNECT` to `PUBLIC` on every new database. This repository closes it, and the closure is **verified against the real ACL**, not assumed:

| Database                        | `PUBLIC` | Who may `CONNECT`                                                          | Applied by                                                                                         |
| ------------------------------- | -------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| control plane (`petra_control`) | revoked  | `petra_control_app` (+ owner/superuser)                                    | control migration `002_database_acl.sql`; `petra harden-db-access`                                 |
| legacy shared database          | revoked  | `shikkha_app` (+ owner/superuser)                                          | school migration `003_database_acl.sql` (placeholder role substituted by the runner); same command |
| each school database `sk_<id>`  | revoked  | `sk_<id>_app` only                                                         | provisioning; migration `003`; `petra migrate`                                                     |
| `postgres`                      | revoked  | the connecting provisioner role + `PETRA_OPERATOR_ROLES` (comma-separated) | `petra harden-db-access`; `petra provision` runs it first (`--skip-acl` to skip)                   |
| `template1`                     | revoked  | superusers/owner only                                                      | `petra harden-db-access` (`CREATE DATABASE` copies the template without connecting to it)          |

`npm run petra -- harden-db-access` is idempotent, re-reads `aclexplode(coalesce(datacl, acldefault('d', datdba)))` afterwards, and **exits non-zero with the exact SQL to run** if `PUBLIC` can still connect. That matters because a `REVOKE` by a role that does not own the database only raises a _warning_ in PostgreSQL. `petra health` prints a `cluster-acl` line (exit 2 when open), and every school health check includes `no_connect_privilege_on_other_databases` (the school role itself is asked via `has_database_privilege`), which gates the transition to `active`.

**Privileges the DB operator must apply separately** (this repository cannot do it with a role that is not the database owner or a superuser): `REVOKE ALL ON DATABASE postgres, template1 FROM PUBLIC` and `GRANT CONNECT ON DATABASE postgres TO <provisioner and operator roles>`; the same for any other pre-existing database (monitoring, marker, other applications) that school roles must not reach. Run `harden-db-access` with the cluster owner's credential once per cluster, then use the lower-privileged provisioner afterwards. Databases created by other tooling later start with `PUBLIC CONNECT` again (PostgreSQL has no default-privilege setting for database-level `CONNECT`), so re-run the command or make the creation procedure revoke it.

Evidence: `db-access.test.ts` (real roles: school, control and shared roles each denied everywhere except their own database; health-check detection; a non-owner `REVOKE` is reported instead of passing; a non-superuser provisioner can provision, health-check, export and restore after hardening).

## Network access (requirements — not configured or verified by this repository)

The privileges above are tested. The following controls are **deployment configuration and have not been verified here**:

1. PostgreSQL listens only on a private interface (`listen_addresses`), reachable only from the API hosts and the operator host (firewall / security group).
2. `pg_hba.conf` restricts each school role to its own database and the API source network, using `scram-sha-256`, e.g. `hostssl sk_aaaaaaaaaaaa sk_aaaaaaaaaaaa_app 10.0.1.0/24 scram-sha-256` (one line per school, or a prefix pattern with a role name regex), and `hostssl petra_control petra_control_app …`. Reject everything else.
3. TLS enabled on the server with a certificate whose name matches the host the API uses; set `CONTROL_DB_SSL=true`, `SCHOOL_DB_SSL=true` and, for a private CA, `DB_SSL_CA_FILE=/path/to/ca.pem` (certificate **and** host name are always verified). Operator tools use libpq: set `PGSSLMODE=verify-full` and `PGSSLROOTCERT`. Trusted-CA success and untrusted-CA failure are tested against a disposable TLS server (`tls.test.ts`); the real production certificate chain and `pg_hba` `hostssl` rules are not.
4. `postgres`/`template1` `CONNECT` — implemented and verified, see the section above (cluster-level ownership of the command is yours).
5. The provisioner credential exists only on the operator host.

## Evidence (automated tests, real PostgreSQL roles and databases)

- `provisioning.test.ts`: school A's role **cannot connect** to school B's database and vice versa; a school role cannot create databases, roles or tables; writes land only in the school's own database; `has_database_privilege` shows exactly one connectable school database.
- `dedicated.test.ts`: same e-mail in two schools = two independent accounts; a school-A user cannot log in via school B's slug; a session token cannot be replayed against another school by forging the cookie prefix; client-supplied identifiers are ignored; the full result workflow works end to end on dedicated databases; per-school failure isolation.
- `rls.test.ts`, `tenant.test.ts`: the Phase 1 RLS / IDOR suites (shared mode), unchanged.

## Shared mode (retained only for migration and rollback)

`db_mode='shared'` routes a school to `SHARED_DATABASE_URL` (the Phase 1 database). It is never assigned to newly provisioned schools (`registerSchool` creates `dedicated` rows; shared rows can only be created by tooling that supplies an existing school id). In shared mode, accounts are still checked for an active membership in the school being logged into.

`migrate-to-dedicated <slug>`:

1. Provisions the empty dedicated database (idempotent) without initial data.
2. Puts the school in `maintenance` (503 for everyone, optional quiesce wait for other API instances' registry caches).
3. Copies, in a single transaction on the target, users, then every school table in foreign-key order (via `jsonb_populate_recordset`), with `marks_guard_trg` suspended **inside that transaction only**. Credentials move only for real members; accounts that are merely referenced by history (removed members, Phase 1 platform administrators) become `disabled` stubs with no usable password.
4. Verifies, per table, the row count and an MD5 digest of the canonical row content against the shared source, plus the user count. Any mismatch aborts, rolls back and reopens the school on the shared database.
5. Flips the registry (`db_mode='dedicated'`, `migrated_from_shared_at`) and audits it. The shared rows are **left untouched**. Sessions do not move; users sign in again.

**Concurrency.** The whole lifecycle (steps 1–5, rollback and recovery) runs under a per-school PostgreSQL advisory lock held on a dedicated control-plane connection (`migrate:<school id>`). A second migrate, rollback or recovery for the same school fails immediately with "another migration or recovery holds the lock"; `migration-inspect` reports `migration_in_progress`. The lock is session-level, so a crashed process releases it automatically.

### Recovering a school left in `maintenance`

If the process dies (or the control plane is unreachable) between step 2 and the end, the school stays in `maintenance`. Nothing is activated or discarded automatically. The operator inspects, then names an action:

```bash
npm run petra -- migration-inspect <slug>                  # read-only: real registry + shared source + target database, re-verifies a copied target
npm run petra -- migration-recover <slug> <reopen-shared|complete-cutover|reopen-dedicated>
```

| Real state found                                                        | Recommendation / allowed actions                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| shared source intact, target empty or missing (crash during the copy)   | `reopen-shared` (the uncommitted copy died with its transaction)                     |
| shared source intact, target holds the school and **all tables verify** | `complete-cutover` (recommended) or `reopen-shared`                                  |
| shared source intact, target holds the school but **does not match**    | `reopen-shared` only; then re-run `migrate-to-dedicated --reset-target` deliberately |
| registry already `dedicated`, target holds the school                   | `reopen-dedicated`                                                                   |
| source missing from the shared DB, or dedicated target missing/empty    | `manual_review` — no action is accepted                                              |
| another migration/recovery is running                                   | `migration_in_progress` — no action is accepted                                      |

`migration-recover` re-runs the inspection under the same lock and refuses an action the _current_ state does not allow. `reopen-*` change only the registry status; `complete-cutover` re-verifies first; no data is deleted or overwritten and every recovery is written to the platform audit. Evidence: `migration-recovery.test.ts` (SIGKILL of a real child process mid-copy and after the commit, tampered target, concurrent attempts).
`rollback-to-shared <slug>` flips the registry back. It is refused if the dedicated database has audited writes since cut-over (they would be lost) unless `--accept-data-loss` is given.

### Removing shared mode

Delete the shared code path (`db_mode='shared'`, `SHARED_DATABASE_URL`, shared fixtures) only when **all** of the following hold, and record the evidence:

1. No row in `petra_control.schools` has `db_mode='shared'`.
2. Every migrated school has run on its dedicated database through at least one full billing period (or a period agreed with the school) without rollback.
3. For each school, `petra health` passes and the migration report (stored in `platform_audit_events`, action `school.migrated_to_dedicated`) shows every table matching.
4. A restore drill of a dedicated database from backup succeeded for at least one migrated school.
5. The shared database has been backed up, its copy of each migrated school's data retained for the agreed rollback window, and then deleted under the offboarding rules (legal review for personal data).
6. The Phase 1 shared-mode test suites have equivalent dedicated-mode coverage, or are rewritten against dedicated fixtures.

## Backup, restore, export, offboarding

See [SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md#backup-restore-and-export) and [#offboarding](SCHOOL_PROVISIONING.md#offboarding). Summary: per-school logical dumps (`pg_dump -Fc`) with a checksummed manifest (row counts **and** content digests, optionally HMAC-signed), restore only into a **new** database followed by verification against the manifest, a restore drill is part of the test suite, and deletion is a separate explicit, confirmed, retention-gated operation that requires a restore-verified final export.
