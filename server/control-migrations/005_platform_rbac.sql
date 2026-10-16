-- H-1 (continued): role separation and step-up for platform administrators.
-- Existing administrators keep full rights ('owner'); new, less privileged roles are opt-in.
ALTER TABLE platform_admins
  ADD COLUMN role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'operator', 'viewer'));
-- When the session last re-proved possession of the second factor; destructive actions require it to be recent.
ALTER TABLE platform_sessions ADD COLUMN step_up_at timestamptz;
