-- Only the control-plane runtime role may open sessions on this database. PostgreSQL grants CONNECT to PUBLIC by
-- default, which would let every school role connect here. Must be applied by the database owner or a superuser
-- (`petra health` / checkDatabaseAcls re-reads the real ACL, because REVOKE by a non-owner only warns).
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO petra_control_app', current_database());
END $$;
