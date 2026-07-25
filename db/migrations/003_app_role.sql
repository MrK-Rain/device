-- ═══════════════════════════════════════════════════════════════════════════
--  003 — application role
--
--  The API connects as one pooled role and assumes the caller's role per
--  transaction with SET LOCAL ROLE. The point of NOINHERIT is the failure
--  mode: registry_app holds membership of the three registry roles but
--  inherits none of their privileges, so a connection that has not yet
--  assumed a role can do nothing at all.
--
--  That means a forgotten SET LOCAL ROLE surfaces as "permission denied"
--  rather than as a request quietly running with the union of every
--  privilege the app has. Authorisation is enforced by Postgres against the
--  column-level grants in 001, not by application if-statements — so a bug
--  in the API cannot grant a technician the ability to edit an IMEI.
--
--  No password or LOGIN attribute is set here. Credentials never belong in a
--  migration. The DBA grants LOGIN out of band, or preferably attaches an
--  IAM / certificate authentication method:
--
--    ALTER ROLE registry_app LOGIN;                    -- then IAM auth, or
--    ALTER ROLE registry_app LOGIN PASSWORD '...';     -- from the secret store
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry_app') THEN
    CREATE ROLE registry_app NOLOGIN NOINHERIT;
  ELSE
    -- Enforce it even if the role predates this migration. Inheriting here
    -- would silently defeat the whole model.
    ALTER ROLE registry_app NOINHERIT;
  END IF;
END $$;

GRANT registry_technician TO registry_app;
GRANT registry_warehouse  TO registry_app;
GRANT registry_manager    TO registry_app;
GRANT registry_readonly   TO registry_app;

-- Needed before SET LOCAL ROLE can reach anything in the schema.
GRANT USAGE ON SCHEMA registry TO registry_app;

-- Deliberately NOT granted to registry_app itself: no SELECT, no INSERT, no
-- UPDATE on any table. Everything arrives through an assumed role.

COMMENT ON ROLE registry_app IS
  'API connection role. NOINHERIT by design: holds no privilege until SET LOCAL ROLE assumes a registry_* role for the authenticated caller.';

COMMIT;
