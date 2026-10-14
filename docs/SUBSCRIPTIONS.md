# Subscriptions and licensing

Source of truth: the Petra control plane (`subscriptions`, `subscription_payments`, `subscription_events`). Logic: `server/src/entitlements.ts` (pure, unit-tested) and `server/src/entitlement-service.ts`. **No payment processor is integrated** and none is claimed: payments are recorded manually by a Petra platform administrator.

## Plans

| Code      | Period             |
| --------- | ------------------ |
| `monthly` | 1 calendar month   |
| `annual`  | 12 calendar months |

A period covers `period_start` … `period_end` **inclusive**; `period_end` is the last day of full access. A period is `start + N months − 1 day` (month-end clamped: 31 Jan + 1 month → 28/29 Feb). New schools start with a trial (`TRIAL_DAYS`, default 30) whose `period_end` is the trial end. Prices are not modelled; the ledger records the amount actually received.

## Access levels (derived from dates on every request)

Let `d` = today − `period_end` in whole calendar days, in `BILLING_TIMEZONE` (default `Asia/Dhaka`). Defaults per subscription: `grace_days = 7`, `readonly_days = 30`, `retention_days = 90` (all editable per school; the platform API validates ranges).

| `d`                 | Access level | Effective status                 | Behaviour                                                                                                                                                                                 |
| ------------------- | ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≤ 0                 | `full`       | `trial` / `active` / `cancelled` | Everything permitted                                                                                                                                                                      |
| 1 … 7               | `grace`      | `past_due`                       | **Full access**, `X-Subscription-Warning: RENEWAL_OVERDUE` header, warning banner in the UI                                                                                               |
| 8 … 37              | `read_only`  | `expired`                        | Reads and export allowed; every non-GET request returns `403 SUBSCRIPTION_READ_ONLY`; guardians can still read                                                                            |
| ≥ 38                | `blocked`    | `suspended`                      | All school routes return `403 SUBSCRIPTION_BLOCKED` (with `retention_until`); login explains why after credentials verify; `/auth/me`, `/auth/logout`, `/auth/change-password` still work |
| any                 | `blocked`    | `suspended`                      | Stored status `suspended` (manual suspension by Petra) blocks immediately                                                                                                                 |
| no subscription row | `blocked`    | —                                | Fail closed                                                                                                                                                                               |

Exact boundaries (day 0, 1, 7, 8, 37, 38) are unit-tested and exercised through the API with a movable clock (`entitlements.test.ts`, `subscriptions.test.ts`). Custom windows, including zero-length ones, are tested.

`GET /api/auth/me` returns the entitlement (level, status, warning, full/read-only/retention dates) so clients can communicate expiry clearly; the web UI shows a banner in grace/read-only and a full-screen notice when blocked.

## Data preservation, retention and deletion

- **No automatic deletion exists.** Lapse, read-only, blocked and `expired` never remove data (tested: nothing changes after 2000 days).
- Retention window: `period_end + retention_days` (default 90 days) — data is preserved and Petra can export it on request; the school admin can self-export while in the read-only period.
- **Deletion** is only possible through the explicit two-step offboarding procedure ([SCHOOL_PROVISIONING.md](SCHOOL_PROVISIONING.md#offboarding)), after the retention window, without legal hold, with a verified export, and with typed confirmation. `deletion_allowed_from` in the entitlement shows the first eligible day (`null` under legal hold).
- The 90-day default is a product decision and is **subject to applicable legal and contractual requirements**; review before relying on it.

## Renewal and payments

`POST /api/platform/schools/:id/subscription/payments` `{plan, amount_minor, currency, method, reference, received_on}`:

- Idempotent per `(school, reference)`: replays return the original period with `replayed: true`; concurrent duplicates produce exactly one renewal (tested).
- Early or on-time renewal extends from the day after the current `period_end`; renewal after lapse starts **today** (no back-dated free period).
- Sets the stored status to `active`, **except** a manual suspension, which payment never lifts. Lifting requires the explicit `…/reinstate` call with a reason; reinstating recomputes access from dates (an unpaid, lapsed account stays read-only/blocked).
- The payments ledger, event history and platform audit are append-only for the application role.

Other platform endpoints: `GET …/subscription`, `POST …/suspend`, `POST …/reinstate`, `POST …/cancel` (access continues to the period end, then the normal timeline), `PATCH …/terms` (`grace_days`, `readonly_days`, `retention_days`, `legal_hold`).

## Reporting sweeper

`npm run petra -- sweep` records derived transitions (`trial/active → past_due → expired`) into the stored status and `subscription_events`. It is idempotent, purely informational (enforcement never depends on it), never writes `suspended` for a lapse (that value is reserved for manual suspension), and never touches school data. Schedule it daily (cron/systemd timer) — not yet scheduled by this repository.

## Not implemented

Payment gateway integration, invoices, tax, proration, price lists, automatic reminder e-mails/SMS, dunning, self-service renewal by schools, per-plan feature limits (`max_students` was a Phase 1 column and is not enforced), cached-status propagation faster than `ENTITLEMENT_CACHE_SECONDS` on multiple instances.
