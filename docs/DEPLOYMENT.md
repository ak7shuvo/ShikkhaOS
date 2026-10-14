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

Secrets: inject `PETRA_MASTER_KEY` and database URLs from a secret manager or a root-owned `0600` environment file; never commit them, never put them in container images or build logs. [configurable, not verified]

## Checklist

| Item                                                                             | Status                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Control-plane and per-school privileges, cross-database isolation                | [verified locally] (tests on real roles/databases)                                  |
| Idempotent provisioning, crash recovery, per-school migrate/health, rotation     | [verified locally]                                                                  |
| Backup/restore/verify and offboarding guards                                     | [verified locally]; scheduling, off-host storage, dump encryption [not implemented] |
| TLS server-side and `SCHOOL_DB_SSL=true` with certificate verification           | [configurable, not verified]                                                        |
| `pg_hba.conf` per-school/per-network rules; private `listen_addresses`; firewall | [configurable, not verified]                                                        |
| `REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC`                     | [configurable, not verified]                                                        |
| Reverse proxy with `TRUST_PROXY` set to the real hop count/CIDRs                 | [simulated in tests only]                                                           |
| Shared (multi-instance) rate-limit store                                         | [not implemented] (in-memory per process)                                           |
| Master key in a secret manager; documented recovery                              | [env var only; no KMS]                                                              |
| Platform-admin MFA / IP allow-list                                               | [not implemented]                                                                   |
| Security headers on the static host (CSP)                                        | [not implemented]                                                                   |
| Monitoring, alerting, log shipping, CI, dependency scanning                      | [not implemented]                                                                   |
| Daily `petra sweep`, nightly `petra export`                                      | [not scheduled]                                                                     |
| Load / capacity test                                                             | [not done]                                                                          |

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
