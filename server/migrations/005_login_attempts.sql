-- M-2: failed-login tracking per (account, source address), so one attacker cannot lock the owner out from everywhere.
-- (Role name `shikkha_app` is replaced by the per-school role when applied to a dedicated database.)
CREATE TABLE login_attempts (
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip              text        NOT NULL,
  failures        integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ip)
);
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_attempts_own ON login_attempts USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO shikkha_app;
