# School provisioning and operations runbook

All commands run on an **operator host** that has `PROVISIONER_DATABASE_URL` (privileged) in its environment, in addition to the normal `.env`. The API server never has that variable. Entry point: `npm run petra -- <command>` (`server/src/scripts/petra.ts`). Passwords are printed once and never stored.

## One-time platform setup

```bash
npm install && cp .env.example .env            # fill in every placeholder
npm run petra -- generate-master-key           # put the output in PETRA_MASTER_KEY (secret manager)
createdb petra_control                          # as a PostgreSQL admin
npm run control:setup                           # creates role petra_control_app
npm run control:migrate                         # applies server/control-migrations/*.sql
PLATFORM_ADMIN_EMAIL=ops@example.org PLATFORM_ADMIN_PASSWORD='…≥10 chars…' npm run petra -- platform-admin-create
```

## Provisioning a new school

1. **Register** (platform console → _Create school_, `POST /api/platform/schools`, or `npm run petra -- register <slug> <name> <admin-email> <admin-name> [monthly|annual]`). Creates the registry row (`requested`), default branding and a trial subscription (`TRIAL_DAYS`, default 30). **No database exists yet** and the school cannot log in.
2. **Provision**: `npm run petra -- provision <slug>`. Steps (each idempotent; the recorded `provisioning_step` only advances):

   | Step           | Action                                                                                                                                                     |
   | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `db_created`   | `CREATE DATABASE sk_<id>` if missing; `REVOKE ALL … FROM PUBLIC`                                                                                           |
   | `role_created` | Generate the credential, **store it encrypted in the registry first**, then create/alter the login role (restricted attributes, timeouts), `GRANT CONNECT` |
   | `migrated`     | Apply `server/migrations/*.sql` with the per-school role substituted for the role placeholder; lock down `public` schema                                   |
   | `seeded`       | Insert the school row and the first School Admin (random 20-char password, printed once)                                                                   |
   | `active`       | Health check using the school's own credential; registry becomes `active`                                                                                  |

   A per-school advisory lock prevents concurrent runs. On any error the registry becomes `failed` with a sanitised `provisioning_error` (secrets redacted); **re-run the same command** to resume.

3. Hand the first-admin e-mail, the school slug and the initial password to the school over a secure channel. The admin must change the password after the first login (_Account_ page).

### Recovery matrix (all covered by `provisioning.test.ts`)

| Situation                                                                     | Result / action                                                                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Crash after any step                                                          | Status `failed`; re-run `provision` — completes, no duplicate database, role or admin                                                  |
| Crash after the first admin row was written but before the password was shown | Re-run succeeds without creating a second admin; the initial password is unrecoverable → `npm run petra -- admin-reset <slug> <email>` |
| Credential stored but role not yet created                                    | Re-run uses the stored credential (registry is authoritative)                                                                          |
| Two operators run `provision` at once                                         | One gets `ProvisioningBusyError` (or finds it finished); no duplicates                                                                 |
| Provisioner connection unreachable                                            | `failed` with sanitised error; re-run when reachable                                                                                   |
| School in `archived`/`offboarding`                                            | Refused                                                                                                                                |

## Per-school migrations and health

```bash
npm run petra -- migrate <slug>        # or --all  (applies pending server/migrations to dedicated schools)
npm run petra -- health <slug>         # or --all  (exit code 2 if any school is unhealthy)
```

Migrations are forward-only SQL files, applied in a transaction per file with an advisory lock; a failing file rolls back and leaves the school on its previous version (tested). Roll out new migrations school by school (`migrate <slug>`) before `--all`. `health` connects **as the school's own role** and checks: connect, lands on the registered database/role, role not privileged, exactly one `schools` row matching the registry, no `CONNECT` privilege on any other `sk_*` database, migrations current.

## Credential rotation and support

```bash
npm run petra -- rotate-secret <slug>
npm run petra -- reencrypt-secrets      # after a master-key change
npm run petra -- admin-reset <slug> <email>
```

See [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md#rotation).

## Backup, restore and export

```bash
npm run petra -- export <slug> /secure/backups            # <slug>-<timestamp>.dump + .manifest.json
npm run petra -- restore /secure/backups/<file>.manifest.json restore_<slug>_<date>
```

- `export` runs `pg_dump --format=custom --no-owner` with the privileged credential (password via `PGPASSWORD`, never on the command line), writes files with mode `0600`, records the SHA-256 of the dump, schema version and per-table row counts in a manifest, and audits the action.
- `restore` **only** restores into a database that does not exist yet. It verifies the dump checksum first, restores, then compares per-table row counts with the manifest and reports mismatches. If the school's role no longer exists (after offboarding) a `NOLOGIN` placeholder is created so the grants in the dump restore faithfully.
- Restoring _over_ a live school is deliberately not automated. Procedure: set the school `maintenance` (registry), restore into a scratch database, verify, point the registry at it or rename databases during the window, `health`, reopen. Practise this regularly; a restore drill was run in the automated tests (`operations.test.ts`) but **no scheduled backups, off-host copies or dump encryption exist yet**.
- A school-admin **self-service export** is available at `GET /api/school/export` (JSON of school data without credentials and sessions). It works during the read-only period and is blocked when the account is blocked; Petra can still export with `petra export` on request.

Recommended schedule (to be implemented by operations): nightly `export` per school, off-host encrypted copies, weekly automated restore verification, keep copies at least for the retention window.

## Subscription expiry: preservation and export

Nothing in the expiry logic deletes data. After the school is blocked (day 38 by default) data stays intact until an authorised operator performs the offboarding below. See [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md).

## Offboarding

Deletion is a deliberate two-step operator procedure and is **never** triggered by a failed payment, a lapse or a scheduler.

```bash
npm run petra -- offboard-start <slug> "<reason, e.g. contract ended>"     # users locked out, data preserved, reversible
npm run petra -- offboard-finalize <slug> /secure/final-exports --confirm <slug>   # IRREVERSIBLE
```

`offboard-finalize` refuses unless **all** hold: status is `offboarding`; slug confirmation matches; the school has a subscription record with **no legal hold**; today is after `period_end + retention_days` (default 90); a final export was written **and** restored into a scratch database whose table counts match the manifest. Only then it drops the database and role, nulls the stored credentials, sets the registry to `archived`, and records the export checksum in the audit trails. Subscription, payment and audit records are retained as business records. The 90-day window is a default for Petra's service; whether data may or must be kept longer or deleted sooner is subject to applicable law and your contract with the school, and needs legal review before use.

Before running `offboard-finalize`: confirm the school received its export, confirm no legal hold, and store the final export according to your retention policy. Shared-mode schools must first be migrated; the command refuses them.

## Shared → dedicated migration of a Phase 1 school

```bash
npm run petra -- import-platform-admins                 # Phase 1 platform admins → control plane (once)
npm run petra -- migrate-to-dedicated <slug>            # copy + verify + cut over (school is in maintenance meanwhile)
npm run petra -- health <slug>
npm run petra -- rollback-to-shared <slug>              # refused if writes happened since cut-over (--accept-data-loss to override)
```

Details and the removal criteria for shared mode: [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md#shared-mode-retained-only-for-migration-and-rollback). Run it first on a copy of production data and rehearse the rollback. Users are signed out at cut-over and must sign in with the school slug.

## Branded client configuration

```bash
npm run petra -- build-profile <slug> https://api.petra.example builds
```

Writes non-secret configuration only (see [DEPLOYMENT.md](DEPLOYMENT.md#branded-desktop-and-android-clients)). It builds nothing.

## Development convenience

`npm run petra -- seed-demo` (refused in production) registers and provisions `demo-school` on its own database and seeds fictional data; log in with slug `demo-school`, e-mails `admin|principal|controller|teacher|teacher2|guardian|guardian2@demo-school.example.test`, password = `DEV_SEED_PASSWORD`.
