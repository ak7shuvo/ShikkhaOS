-- Only this database's application role may open sessions here (no PUBLIC CONNECT). Applies to dedicated school
-- databases (the placeholder role below is replaced by the per-school role) and to the legacy shared database
-- (role shikkha_app). Must be applied by the database owner or a superuser; `petra health` re-reads the real ACL.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO shikkha_app', current_database());
END $$;
