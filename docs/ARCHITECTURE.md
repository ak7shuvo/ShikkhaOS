# Architecture

## Stack (what actually exists)

| Layer     | Choice                                               | Why / trade-off                                                                                                                                   |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| API       | Node 22, TypeScript, **Fastify 5**, zod              | Small, fast, schema-validated. Fewer batteries than NestJS, but far less ceremony; the domain is mostly SQL + rules.                              |
| DB access | `pg` with hand-written SQL                           | Row-level security needs per-transaction `set_config`; raw SQL keeps that explicit. Cost: no ORM type inference (types are manual).               |
| Database  | **PostgreSQL** (tested on 16)                        | Transactions, FKs, RLS, partial/composite indexes, triggers.                                                                                      |
| Passwords | `@node-rs/argon2` (argon2id)                         | Maintained, prebuilt binaries, no node-gyp.                                                                                                       |
| Sessions  | Opaque random token; SHA-256 hash stored server-side | Revocable instantly (membership/user/school changes apply on the next request). Cost: a DB lookup per request vs. stateless JWTs.                 |
| Web       | React 18, Vite, React Router, plain CSS              | No UI framework or state library: fewer dependencies for a mostly form/table application. Hand-rolled i18n (two dictionaries, key parity tested). |
| Tests     | Vitest + `fastify.inject` against real PostgreSQL    | Proves RLS/constraints/triggers for real.                                                                                                         |

Deliberately **not** used: monorepo tooling (two npm workspaces only), microservices, ORM, GraphQL, JWT, UI kits, a state-management library.

## Shape

```
Browser (React) ──/api (JSON, cookie)──▶ Fastify ──▶ PostgreSQL
                                   authz preHandler          RLS + constraints + triggers
```

One backend and one database serve all schools. A school is a row in `schools`; every school-owned row carries `school_id`.

### Request pipeline

1. `onRequest`: reject unsafe-method requests whose `Origin` header is not in `ALLOWED_ORIGINS`.
2. `authz(...)` preHandler: resolves the cookie to a session (via a `SECURITY DEFINER` lookup), loads the user's **active memberships from the DB**, derives active school, roles and permissions, checks school status and licence, then checks required permissions.
3. The handler runs inside `schoolTx` / `platformTx`: one transaction with `app.user_id`, `app.school_id` (and `app.platform` only on platform routes) set via `set_config(..., true)`. PostgreSQL RLS then confines every statement to that school.
4. Routes also add explicit `school_id = $x` predicates and ownership checks (defence in depth, and clear 404s).

### Tenant context

The school comes only from `sessions.active_school_id`, which can only be set to a school where the user holds an active membership (`/auth/switch-school` validates it, and `authenticate` re-validates on every request). No endpoint accepts a `school_id` as authority; a client-sent one is ignored or rejected by strict schemas (tested).

### Platform vs school scope

`platform_super_admin` is a flag on `users` (not a school membership; a trigger forbids granting it that way). Platform routes run with `app.platform = on`, which opens only `schools`, `school_licenses`, `school_memberships`, `users` and `audit_events` — **not** student, marks or result tables. A platform admin therefore cannot read school academic data (tested). School admins cannot change platform fields (code, status, licence).

### Roles and permissions

Role → permission mapping lives in the database (`roles`, `role_permissions`, seeded by migration) and is loaded when the API starts. A user's permissions are the union across their active roles in the active school. See [SECURITY.md](SECURITY.md#roles-and-permission-boundaries).

### Result workflow

State machine in `server/src/workflow.ts`; the unit of work is a **result sheet** = exam × subject × section. See [DATABASE.md](DATABASE.md#result-workflow).

### Grading configuration

Grades come only from a school-defined `grading_policies.bands` JSON (`min_percent`, `grade`, optional `grade_point`; must include a 0 floor). An exam with no policy publishes `grade = null`. Policies are immutable; exams reference one. The seed creates a clearly labelled **development sample** (`is_dev_sample = true`: A ≥ 80, B ≥ 60, C ≥ 40, else F) used only by demos and tests — it is not an official scale and no application code assumes it. Percentages are rounded to 2 decimals before band matching.

## Frontend

Navigation and controls are derived from `/auth/me` (`permissions`). The UI hides controls a user cannot use, but **all enforcement is server-side**. Reusable components: `Button`, `TextField`, `SelectField`, `DataTable` (horizontal scroll on small screens, captions for assistive tech), `StatusBadge`, `Spinner`, `EmptyState`, `ErrorBanner`/`Notice`, `Card`, `Async` (loading/error wrapper), `useAction` (busy/error/done).

Language: Bengali default with an English switch; stored in `localStorage` and `users.preferred_language`. API error codes map to localized messages (`error.<CODE>`).

## Designed for later phases — NOT implemented

### Android APK and desktop

The web app is a plain SPA over a JSON API, so it can be wrapped (Capacitor for Android; Tauri/Electron for desktop). Wrapping needs (a) a token-based session mode for non-browser origins, since the `SameSite=Strict` cookie will not work from `capacitor://`, and (b) secure OS storage for the token. No wrapper or build exists today.

### Offline-first teacher marks entry (planned)

- A local store (IndexedDB) would hold **drafts only**: `{sheet_id, enrollment_id, obtained, is_absent, base_version, client_op_id}`.
- Sync would call `PUT marks` with an `Idempotency-Key` per batch (new server table; replays return the stored response), making duplicate requests harmless. Today, creating a sheet is idempotent and a repeated mark write simply re-applies the same values, but there is no key table yet.
- **Conflicts:** each mark already supports `expected_version` (optimistic concurrency → `409 STALE_MARK`). A client would show a per-row merge screen; the server never silently last-write-wins when a version is supplied.
- **Revoked permissions / reassignment:** sync re-runs the same membership and assignment checks as online. Rejected entries stay locally as "needs attention" and are never dropped silently.
- **Published/locked protection:** the server (API + DB trigger `marks_guard`) rejects writes unless the sheet is `draft`/`returned`. Offline clients learn this on sync and must surface it.
- Submission, review, approval and publication remain **online-only**.

### Scale-out

Stateless API instances behind a load balancer; sessions already live in PostgreSQL. Reporting queries can later move to a read replica.
