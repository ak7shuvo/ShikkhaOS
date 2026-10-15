-- Phase 2: expose last_seen_at so the API can enforce an idle-session timeout.
-- (Role name `shikkha_app` is replaced by the per-school role when applied to a dedicated database.)
DROP FUNCTION auth_session_by_hash(text);
CREATE FUNCTION auth_session_by_hash(p_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, active_school_id uuid, expires_at timestamptz, last_seen_at timestamptz,
               user_status text, is_platform_admin boolean, email citext, full_name text, preferred_language text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT s.id, s.user_id, s.active_school_id, s.expires_at, s.last_seen_at, u.status, u.is_platform_admin, u.email, u.full_name, u.preferred_language
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = p_hash $$;
REVOKE ALL ON FUNCTION auth_session_by_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_by_hash(text) TO shikkha_app;
