-- ═══════════════════════════════════════════════════════════════════════════
--  004 — audit partition safety net
--
--  Migration 001 created audit_log partitions for the current month plus two,
--  and left rotation to "a scheduled job" that does not exist yet. That is a
--  dated outage, not a gap in tidiness:
--
--    registry.audit() is called inside the same transaction as every read and
--    every write. An INSERT with no matching partition raises. So on the
--    first day after the last partition ends, every request against the
--    register fails — searches included.
--
--  Two changes.
--
--  1. A DEFAULT partition. Rows that would have raised land there instead.
--     This converts a total outage into a degraded state that needs cleaning
--     up, which is the difference between a page at 03:00 and a postmortem.
--
--  2. A headroom function so the shortfall is visible before it bites,
--     asserted in the control suite and suitable for an alert.
--
--  The default partition is a net, not a plan. Rows accumulating in it means
--  rotation has stopped, and CREATE TABLE ... PARTITION OF for a range that
--  overlaps rows already sitting in the default will FAIL until they are
--  moved out. Alert on it being non-empty; do not let it become normal.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = registry, public;

CREATE TABLE registry.audit_log_unpartitioned
  PARTITION OF registry.audit_log DEFAULT;

COMMENT ON TABLE registry.audit_log_unpartitioned IS
  'Safety net. Any row here means monthly rotation has stopped. Drain it before creating the overlapping partition, or the CREATE will fail.';


-- ── How many whole months of partitions remain after today ────────────────
CREATE FUNCTION registry.audit_partition_headroom()
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    max(
      (to_date(right(c.relname, 6), 'YYYYMM')
       + interval '1 month')::date
    ) - date_trunc('month', current_date)::date, 0
  ) / 30
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'registry'
    AND c.relname ~ '^audit_log_[0-9]{6}$'
$$;

COMMENT ON FUNCTION registry.audit_partition_headroom() IS
  'Approximate whole months of audit partitions remaining. Alert below 2.';


-- ── Create whatever is missing, up to n months ahead ──────────────────────
--  Call monthly from pg_cron, a Kubernetes CronJob, or whatever scheduler the
--  platform already runs. Idempotent, so running it daily is harmless and is
--  the safer choice: a job that runs monthly has twelve chances a year to be
--  silently broken.
CREATE FUNCTION registry.ensure_audit_partitions_ahead(p_months integer DEFAULT 3)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE plpgsql AS $$
DECLARE
  i     integer;
  month date;
  nm    text;
  had   boolean;
BEGIN
  FOR i IN 0..greatest(p_months, 1) LOOP
    month := (date_trunc('month', current_date) + make_interval(months => i))::date;
    nm    := format('audit_log_%s', to_char(month, 'YYYYMM'));
    had   := EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'registry' AND c.relname = nm
    );
    PERFORM registry.ensure_audit_partition(month);
    partition_name := nm;
    created := NOT had;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION registry.ensure_audit_partitions_ahead(integer) IS
  'Idempotent. Schedule daily. Example with pg_cron: SELECT cron.schedule(''audit-partitions'', ''17 2 * * *'', $$SELECT registry.ensure_audit_partitions_ahead(3)$$);';


-- ── Anything already caught by the net ────────────────────────────────────
CREATE VIEW registry.v_audit_partition_health AS
SELECT
  registry.audit_partition_headroom()                       AS months_headroom,
  (SELECT count(*) FROM registry.audit_log_unpartitioned)   AS rows_in_default,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'registry' AND c.relname ~ '^audit_log_[0-9]{6}$') AS monthly_partitions;

GRANT SELECT ON registry.v_audit_partition_health TO registry_manager;

-- Give the running system a year of runway immediately, so a scheduler that
-- is not configured on day one does not become an incident in month three.
SELECT registry.ensure_audit_partitions_ahead(12);

COMMIT;
