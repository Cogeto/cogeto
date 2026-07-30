-- db-init: least-privilege Postgres identities (audit 2.0 SEC-1).
--
-- Run by the one-shot `db-init` compose service via psql AS THE CLUSTER
-- SUPERUSER, before migrate and before Zitadel. Idempotent: safe on every
-- `docker compose up`; passwords are re-synced from .env on each run, which is
-- what makes the three DB credentials rotatable by `cogeto configure
-- --regenerate`.
--
-- The three identities it provisions (spec: one per trust boundary):
--   cogeto_app      runtime role for app + worker. DML only; owns nothing,
--                   holds no DDL and no TRIGGER privilege, cannot reach the
--                   zitadel database. Table-level grants are applied by the
--                   migrate entrypoint AFTER migrations (it owns the tables).
--   cogeto_migrate  owns the cogeto database and every object in it; the only
--                   role that runs migrations (the migrate entrypoint).
--   zitadel_admin   Zitadel's bootstrap/migration admin (CREATEDB CREATEROLE,
--                   NOT superuser) — replaces the cluster superuser in
--                   ZITADEL_DATABASE_POSTGRES_ADMIN_*. Zitadel's runtime user
--                   (`zitadel`) is unchanged: it was already least-privilege.
--
-- Required psql vars (all injected by the db-init service from .env):
--   :app_password :migrate_password :zitadel_admin_password :zitadel_password
--
-- The superuser credential keeps working throughout — it simply stops being
-- used by any long-running service. It remains the break-glass credential and
-- the one this script runs under.

\set ON_ERROR_STOP on

-- ── Roles (create if absent, then converge attributes + password) ────────────
SELECT format('CREATE ROLE cogeto_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cogeto_app') \gexec
ALTER ROLE cogeto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD :'app_password';

SELECT format('CREATE ROLE cogeto_migrate LOGIN PASSWORD %L', :'migrate_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cogeto_migrate') \gexec
ALTER ROLE cogeto_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD :'migrate_password';

-- Zitadel's bootstrap admin needs CREATEDB + CREATEROLE for Zitadel's own
-- `start-from-init` (it creates/verifies the zitadel database, the runtime
-- user and its grants) — and nothing more. Not superuser.
SELECT format('CREATE ROLE zitadel_admin LOGIN CREATEDB CREATEROLE PASSWORD %L', :'zitadel_admin_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zitadel_admin') \gexec
ALTER ROLE zitadel_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD :'zitadel_admin_password';

-- Zitadel's runtime user. Zitadel's init would create it via zitadel_admin,
-- but pre-creating it here keeps the password in sync with .env on every boot
-- and lets us grant CONNECT explicitly (PUBLIC's blanket CONNECT is revoked
-- below).
SELECT format('CREATE ROLE zitadel LOGIN PASSWORD %L', :'zitadel_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zitadel') \gexec
ALTER ROLE zitadel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS PASSWORD :'zitadel_password';

-- ── Databases and database-level access ──────────────────────────────────────
-- Pre-create the zitadel database (owner: its admin). Zitadel's idempotent
-- init finds it and proceeds; on an instance provisioned before this script
-- existed the database is already there and this is a no-op.
SELECT 'CREATE DATABASE zitadel OWNER zitadel_admin'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zitadel') \gexec

-- The identity boundary in one statement each: nobody connects to a database
-- they were not explicitly granted. In particular cogeto_app cannot CONNECT to
-- zitadel, and the zitadel roles cannot CONNECT to cogeto.
REVOKE ALL ON DATABASE cogeto FROM PUBLIC;
REVOKE ALL ON DATABASE zitadel FROM PUBLIC;
GRANT CONNECT ON DATABASE cogeto TO cogeto_app, cogeto_migrate;
GRANT ALL ON DATABASE zitadel TO zitadel_admin;
GRANT CONNECT, TEMP ON DATABASE zitadel TO zitadel;

-- The application schema is owned by the migrate role. On PG 15+ this also
-- makes cogeto_migrate the effective owner of the `public` schema
-- (pg_database_owner) — i.e. the only non-superuser role that can CREATE in
-- it, which is exactly the migrations contract.
ALTER DATABASE cogeto OWNER TO cogeto_migrate;

\connect cogeto

-- ── Adopt pre-existing objects (upgrade path) ────────────────────────────────
-- A stack provisioned before this script ran its migrations as the superuser,
-- so every table/function/type is owned by `postgres` and cogeto_migrate could
-- not run the next migration. Reassign application objects (never
-- extension-owned ones) to cogeto_migrate. No-op on a fresh volume.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
    WHERE n.nspname IN ('graphile_worker') AND o.rolname = 'postgres'
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO cogeto_migrate', r.nspname);
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles o ON o.oid = c.relowner
    WHERE n.nspname IN ('public', 'graphile_worker')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND o.rolname = 'postgres'
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO cogeto_migrate', r.rel);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles o ON o.oid = p.proowner
    WHERE n.nspname IN ('public', 'graphile_worker')
      AND o.rolname = 'postgres'
      AND NOT EXISTS (
        SELECT FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO cogeto_migrate', r.fn);
  END LOOP;

  FOR r IN
    SELECT format('%I.%I', n.nspname, t.typname) AS typ
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_roles o ON o.oid = t.typowner
    WHERE n.nspname IN ('public', 'graphile_worker')
      AND t.typtype IN ('e', 'd')
      AND o.rolname = 'postgres'
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO cogeto_migrate', r.typ);
  END LOOP;
END $$;

-- ── Default privileges for everything cogeto_migrate creates later ───────────
-- Belt and braces: the migrate entrypoint also re-applies table-level grants
-- after every migration run (see infrastructure/migrations.ts), but default
-- privileges close the gap for any object created outside that path. TRUNCATE
-- is here for the demo reset (dev sandbox); the append-only tables get it
-- REVOKED explicitly in the migrate grant step.
ALTER DEFAULT PRIVILEGES FOR ROLE cogeto_migrate
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO cogeto_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cogeto_migrate
  GRANT USAGE, SELECT ON SEQUENCES TO cogeto_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cogeto_migrate
  GRANT EXECUTE ON FUNCTIONS TO cogeto_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cogeto_migrate
  GRANT USAGE ON TYPES TO cogeto_app;

SELECT 'db-init: roles, databases and default privileges converged' AS status;
