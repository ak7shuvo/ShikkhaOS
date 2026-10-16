-- M-2 (platform): failed-login tracking per (administrator, source address), so one attacker cannot lock the owner out from everywhere.
CREATE TABLE platform_login_attempts (
  admin_id        uuid        NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  ip              text        NOT NULL,
  failures        integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, ip)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_login_attempts TO petra_control_app;
