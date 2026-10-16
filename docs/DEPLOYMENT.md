# Deployment

> **Status: not production-ready.** This document describes the intended topology and the checklist. Items are marked **[verified locally]**, **[configurable, not verified]** or **[not implemented]**. See [PHASE2_ARCHITECTURE.md](PHASE2_ARCHITECTURE.md#status-and-remaining-blockers).

## Topology (initial scale: 1–20 schools)

```
Internet ─▶ reverse proxy / TLS ─▶ API (Node, 1–2 instances) ─▶ PostgreSQL (private network)
                 │                                                 ├─ petra_control
                 └─▶ static web build (web/dist)                   └─ sk_<id> × schools
Operator host (VPN / bastion) ── petra CLI ──────────────────────▶ PostgreSQL (privileged credential)
```

- Serve the web build and `/api` from the **same site** over HTTPS (cookies are `HttpOnly; Secure; SameSite=Strict`). The API does not serve static files. [configurable, not verified]
- One PostgreSQL server can host the control plane and all school databases at this scale. Each school is a separate logical database with its own role (failure/permission isolation, separate dumps and restores). It is not a separate server: a PostgreSQL server outage, host compromise or superuser access affects all schools — plan backups and access control accordingly.
- Connection budget: `schools × SCHOOL_POOL_MAX` (+ control pool) per API instance, each school role capped by `CONNECTION LIMIT 20`. Keep `max_connections` above the total; consider PgBouncer if you outgrow it. [not implemented]

## Environment

All variables are documented in `.env.example` and validated at startup (`server/src/config.ts`). Production refuses `COOKIE_SECURE=false` and non-`https://` `ALLOWED_ORIGINS`, and the API refuses to start if a database role is a superuser or bypasses RLS. The API process needs: `CONTROL_DATABASE_URL`, `PETRA_MASTER_KEY` (+ `_ID`), `ALLOWED_ORIGINS`, `TRUST_PROXY`, and optionally `SHARED_DATABASE_URL`. It must **not** receive `PROVISIONER_DATABASE_URL`, `CONTROL_MIGRATION_DATABASE_URL` or `MIGRATION_DATABASE_URL`.

### Required production settings (start-up fails otherwise)

With `NODE_ENV=production` the API and the `petra` CLI refuse to start unless **all** of the following hold. The error lists every problem at once and names settings only (never values, URLs, hosts or keys). Development and test (`NODE_ENV` `development`/`test`) are unchanged.

| Setting                                                                                                      | Requirement in production                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                                                                                                | **Must be set explicitly.** A hop count `1`-`10` (number of reverse proxies in front of the API), a comma-separated list of proxy IPs/CIDRs (or `loopback`/`linklocal`/`uniquelocal`), or `none` when the API is reached directly. Rejected: empty, `0`, `>10`, `true`, `*`, `/0` ranges, hostnames. |
| `CONTROL_DB_SSL`                                                                                             | Must be `true`: verified TLS (certificate **and** host name) for the control-plane pool and the optional legacy shared pool.                                                                                                                                                                         |
| `SCHOOL_DB_SSL`                                                                                              | Must be `true`: verified TLS for every per-school pool.                                                                                                                                                                                                                                              |
| `DB_SSL_CA_FILE`                                                                                             | Optional PEM file with the private CA that signed the database server certificates; must be a readable file. Without it the Node trust store is used.                                                                                                                                                |
| `CONTROL_DATABASE_URL`, `SHARED_DATABASE_URL`                                                                | Must **not** contain `sslmode`, `ssl`, `sslrootcert` or other TLS parameters. In node-postgres such a parameter replaces the pool's verified-TLS options (`sslmode=disable` = plaintext, `no-verify` = no certificate check, anything else drops `DB_SSL_CA_FILE`).                                  |
| `PROVISIONER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `CONTROL_MIGRATION_DATABASE_URL` (operator tools only) | Must include `sslmode=verify-full`. A private CA for these clients is trusted through `NODE_EXTRA_CA_CERTS`. `pg_dump`/`pg_restore` are run with `PGSSLMODE=verify-full` (and `PGSSLROOTCERT=$DB_SSL_CA_FILE` when set) regardless of the inherited environment.                                     |
| `COOKIE_SECURE`, `ALLOWED_ORIGINS`                                                                           | Unchanged: secure cookies, `https://` origins only.                                                                                                                                                                                                                                                  |

**Upgrading an existing deployment:** set `TRUST_PROXY` (use `none` if there is no reverse proxy), set `CONTROL_DB_SSL=true` and `SCHOOL_DB_SSL=true`, remove any `sslmode=` from `CONTROL_DATABASE_URL`/`SHARED_DATABASE_URL` and move a private CA into `DB_SSL_CA_FILE`, and add `sslmode=verify-full` to the operator URLs. The PostgreSQL server must offer TLS with a certificate whose name matches the host in the URLs and the registry's `db_host`. Scope: this guards the configuration; it does not verify your `pg_hba.conf`, firewall or certificate chain (still listed below as not verified).

Secrets: inject `PETRA_MASTER_KEY` and database URLs from a secret manager or a root-owned `0600` environment file; never commit them, never put them in container images or build logs. [configurable, not verified]

## Checklist

| Item                                                                                                                                      | Status                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Control-plane and per-school privileges, cross-database isolation                                                                         | [verified locally] (tests on real roles/databases)                                                     |
| Idempotent provisioning, crash recovery, per-school migrate/health, rotation                                                              | [verified locally]                                                                                     |
| Backup/restore/verify and offboarding guards                                                                                              | [verified locally]; dump encryption [verified locally]; scheduling, off-host storage [not implemented] |
| TLS server-side with `CONTROL_DB_SSL`/`SCHOOL_DB_SSL` (+ `DB_SSL_CA_FILE`)                                                                | [tested on a disposable server; your certificate chain not verified]                                   |
| `pg_hba.conf` per-school/per-network rules; private `listen_addresses`; firewall                                                          | [configurable, not verified]                                                                           |
| `npm run petra -- harden-db-access` (PUBLIC `CONNECT` revoked on control, shared, `postgres`, `template1`, school DBs; `health` verifies) | [implemented and tested; run once per cluster by the DB owner]                                         |
| `PETRA_BACKUP_ENCRYPTION_KEY` stored in a secret manager off the backup host (required for production exports)                            | [enforced by the CLI; key custody is yours]                                                            |
| `PETRA_BACKUP_SIGNING_KEY` stored apart from the backups                                                                                  | [optional; shared-secret HMAC, no non-repudiation]                                                     |
| CI (`.github/workflows/ci.yml`)                                                                                                           | [added; not yet run on GitHub]                                                                         |
| Reverse proxy with `TRUST_PROXY` set to the real hop count/CIDRs                                                                          | [simulated in tests only]                                                                              |
| Shared (multi-instance) rate-limit store                                                                                                  | [not implemented] (in-memory per process)                                                              |
| Master key in a secret manager; documented recovery                                                                                       | [env var only; no KMS]                                                                                 |
| Platform-admin MFA / IP allow-list                                                                                                        | [not implemented]                                                                                      |
| Security headers on the static host (CSP)                                                                                                 | [not implemented]                                                                                      |
| Monitoring, alerting, log shipping, dependency scanning                                                                                   | [not implemented]                                                                                      |
| Daily `petra sweep`, nightly `petra export`                                                                                               | [not scheduled]                                                                                        |
| Load / capacity test                                                                                                                      | [not done]                                                                                             |

## Release procedure (manual)

1. `npm ci && npm run lint && npm run typecheck && npm test && npm run build`.
2. Back up the control plane and every school (`petra export`).
3. Apply control-plane migrations: `npm run control:migrate`.
4. Deploy the API. Then migrate schools one at a time: `petra migrate <slug>`, `petra health <slug>`; then `--all`.
5. Deploy the web build.
   Migrations are forward-only; keep API and school schema versions compatible for the duration of a rollout (apply additive migrations first).

## Branded desktop and Android clients

**Not built.** What exists: one web codebase that reads `VITE_SCHOOL_SLUG`, `VITE_APP_NAME`, `VITE_API_BASE_URL` at build time, hides the school field when a slug is fixed, applies server-provided branding, and `petra build-profile` which writes `builds/<slug>/` with `profile.json`, `web.env`, `capacitor.config.json` (if an Android profile exists) and `tauri.<platform>.conf.json` for each desktop profile.

What is still required before any EXE, Linux package or APK can be claimed:

1. A Capacitor (Android) project and a Tauri (or Electron) project wrapping `web/dist` — neither exists in this repository.
2. Real builds with the generated configuration, code signing (Android keystore, Windows signing certificate), and installation + launch tests on devices/VMs.
3. A **token-based session mode** for native origins: the `SameSite=Strict` cookie does not work from `capacitor://` / `tauri://` origins, and `VITE_API_BASE_URL` pointing at a different site is not usable with the current cookie model.
4. Update/min-version handling in the client using `GET /api/public/app-config/:slug`.
5. Offline mode (Phase 3; design in [ARCHITECTURE.md](ARCHITECTURE.md#designed-for-later-phases--not-implemented)).
