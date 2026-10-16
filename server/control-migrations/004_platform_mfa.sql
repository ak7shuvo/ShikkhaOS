-- Platform-administrator MFA (TOTP) and credential lifecycle. See docs/SECURITY.md.
-- The TOTP secret is stored encrypted with the master key (AES-256-GCM, bound to the admin id); recovery codes only as hashes.
ALTER TABLE platform_admins
  ADD COLUMN password_changed_at    timestamptz,
  ADD COLUMN mfa_secret_enc         text,
  ADD COLUMN mfa_pending_secret_enc text,
  ADD COLUMN mfa_enabled_at         timestamptz,
  ADD COLUMN mfa_last_step          bigint,
  ADD CONSTRAINT platform_admins_mfa_state CHECK (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL);

-- A session is "MFA verified" only when the second factor was presented for THAT session.
ALTER TABLE platform_sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

CREATE TABLE platform_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES platform_admins(id),
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  UNIQUE (admin_id, code_hash)
);
CREATE INDEX platform_recovery_admin_idx ON platform_recovery_codes (admin_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON platform_recovery_codes TO petra_control_app;
