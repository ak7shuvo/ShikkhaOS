-- Retention is a data-protection commitment: it can be extended per school (and a legal hold can suspend deletion
-- altogether) but never shortened below 90 days by configuration. Raise any lower stored value; this only ever
-- INCREASES protection. The same minimum is enforced in code (entitlements.ts MIN_RETENTION_DAYS).
UPDATE subscriptions SET retention_days = 90 WHERE retention_days < 90;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_retention_days_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_retention_days_check CHECK (retention_days BETWEEN 90 AND 3650);
