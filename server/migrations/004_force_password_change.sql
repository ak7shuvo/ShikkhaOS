-- L-3: accounts created with an administrator-chosen or generated initial password must change it at first login.
-- (Role name `shikkha_app` is replaced by the per-school role when applied to a dedicated database.)
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

DROP FUNCTION auth_session_by_hash(text);
CREATE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, active_school_id uuid, expires_at timestamptz, last_seen_at timestamptz,
               user_status text, is_platform_admin boolean, email citext, full_name text, preferred_language text,
               must_change_password boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT s.id, s.user_id, s.active_school_id, s.expires_at, s.last_seen_at, u.status, u.is_platform_admin, u.email, u.full_name, u.preferred_language,
          u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = p_hash $$;
REVOKE ALL ON FUNCTION auth_session_by_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_by_hash(text) TO shikkha_app;
