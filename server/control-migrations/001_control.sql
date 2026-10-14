-- Petra control plane. Holds NO school academic data and NO school user accounts.
-- Requires role petra_control_app (created by `npm run control:setup`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petra_control_app') THEN
    RAISE EXCEPTION 'Role petra_control_app is missing. Run "npm run control:setup" first.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------- platform admins (Petra staff only)
CREATE TABLE platform_admins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  full_name          text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_admins_updated BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  admin_id     uuid NOT NULL REFERENCES platform_admins(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

-- ---------------------------------------------------------------- school registry
-- The ONLY place that maps a school to its database. Rows are written by platform admins and the
-- provisioning tooling; nothing here is ever taken from a school user's request.
CREATE TABLE schools (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name                    text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  status                  text NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested','provisioning','active','maintenance','suspended','offboarding','archived','failed')),
  -- 'dedicated' = own database (default for every new school). 'shared' = Phase 1 shared database,
  -- kept ONLY as a migration/rollback path.
  db_mode                 text NOT NULL DEFAULT 'dedicated' CHECK (db_mode IN ('shared','dedicated')),
  db_host                 text,
  db_port                 integer,
  db_name                 text UNIQUE CHECK (db_name IS NULL OR db_name ~ '^sk_[a-f0-9]{12}$'),
  db_role                 text UNIQUE CHECK (db_role IS NULL OR db_role ~ '^sk_[a-f0-9]{12}_app$'),
  db_secret_enc           text,
  db_secret_pending_enc   text,
  provisioning_step       text NOT NULL DEFAULT 'requested'
                          CHECK (provisioning_step IN ('requested','db_created','role_created','migrated','seeded','active')),
  provisioning_error      text,
  admin_email             citext,
  admin_name              text,
  schema_version          text,
  migrated_from_shared_at timestamptz,
  created_by              uuid REFERENCES platform_admins(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (db_mode = 'shared' OR status IN ('requested','provisioning','failed','archived') OR (db_name IS NOT NULL AND db_role IS NOT NULL AND db_secret_enc IS NOT NULL))
);
CREATE TRIGGER schools_updated BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE school_branding (
  school_id     uuid PRIMARY KEY REFERENCES schools(id),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
  logo_url      text CHECK (logo_url IS NULL OR logo_url ~ '^https://'),
  primary_color text NOT NULL DEFAULT '#0b6b4f' CHECK (primary_color ~ '^#[0-9a-f]{6}$'),
  accent_color  text NOT NULL DEFAULT '#08523c' CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER school_branding_updated BEFORE UPDATE ON school_branding FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- subscriptions
CREATE TABLE plans (
  code          text PRIMARY KEY,
  label         text NOT NULL,
  period_months integer NOT NULL CHECK (period_months > 0),
  active        boolean NOT NULL DEFAULT true
);
INSERT INTO plans (code, label, period_months) VALUES ('monthly','Monthly',1), ('annual','Annual',12);

CREATE TABLE subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL UNIQUE REFERENCES schools(id),
  plan_code      text NOT NULL REFERENCES plans(code),
  -- Stored status is the administrative intent; the effective access level is always derived
  -- from dates by server/src/entitlements.ts, so correctness never depends on a scheduler.
  status         text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','expired','suspended','cancelled')),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  grace_days     integer NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 90),
  readonly_days  integer NOT NULL DEFAULT 30 CHECK (readonly_days BETWEEN 0 AND 365),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 0 AND 3650),
  legal_hold     boolean NOT NULL DEFAULT false,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Manual payment ledger. No payment processor is integrated; platform admins record receipts.
CREATE TABLE subscription_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools(id),
  plan_code       text NOT NULL REFERENCES plans(code),
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method          text NOT NULL,
  reference       text NOT NULL,
  received_on     date NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  recorded_by     uuid REFERENCES platform_admins(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, reference)
);

CREATE TABLE subscription_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id),
  event       text NOT NULL,
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES platform_admins(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_school_idx ON subscription_events (school_id, created_at);

-- ---------------------------------------------------------------- releases and build profiles
CREATE TABLE app_releases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version               text NOT NULL UNIQUE CHECK (version ~ '^\d+\.\d+\.\d+$'),
  channel               text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta')),
  min_supported_version text NOT NULL CHECK (min_supported_version ~ '^\d+\.\d+\.\d+$'),
  notes                 text,
  published_by          uuid REFERENCES platform_admins(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_build_profiles (
  school_id    uuid NOT NULL REFERENCES schools(id),
  platform     text NOT NULL CHECK (platform IN ('android','windows','linux')),
  app_id       text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$'),
  app_name     text NOT NULL CHECK (length(app_name) BETWEEN 2 AND 40),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, platform)
);

-- ---------------------------------------------------------------- platform audit (append-only)
CREATE TABLE platform_audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES platform_admins(id),
  school_id   uuid REFERENCES schools(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_school_idx ON platform_audit_events (school_id, created_at DESC);
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON subscription_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER subscription_payments_immutable BEFORE UPDATE OR DELETE ON subscription_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- privileges
GRANT USAGE ON SCHEMA public TO petra_control_app;
GRANT SELECT ON plans TO petra_control_app;
GRANT SELECT, INSERT, UPDATE ON platform_admins, schools, school_branding, subscriptions, school_build_profiles TO petra_control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_sessions TO petra_control_app;
GRANT SELECT, INSERT ON subscription_payments, subscription_events, platform_audit_events, app_releases TO petra_control_app;
