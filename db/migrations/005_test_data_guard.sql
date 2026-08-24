-- ═══════════════════════════════════════════════════════════════════════════
--  005 — test data guard
--
--  db/seed/test_devices.sql inserts synthetic devices, every serial prefixed
--  TEST-, for exercising validation and search against something other than
--  an empty table. A synthetic IMEI with a correct Luhn check digit is
--  indistinguishable from a real one by inspection, so the protection
--  against seed data reaching production cannot be visual review -- it has
--  to be a query the deploy pipeline can run and trust.
--
--  registry.assert_no_test_data() raises if any TEST-* device row exists,
--  including soft-deleted ones: a soft-deleted row still proves the database
--  once held seed data, which is exactly the leak this exists to catch.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = registry, public;

-- ── Safety net for the deploy pipeline ──────────────────────────────────────
CREATE FUNCTION registry.assert_no_test_data() RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  n      int;
  sample text;
BEGIN
  SELECT count(*) INTO n FROM registry.devices WHERE serial_norm LIKE 'TEST%';
  IF n = 0 THEN
    RETURN;
  END IF;

  SELECT string_agg(serial, ', ' ORDER BY serial) INTO sample
    FROM (SELECT serial FROM registry.devices
          WHERE serial_norm LIKE 'TEST%' ORDER BY serial LIMIT 5) s;

  RAISE EXCEPTION 'test data present: % TEST-* device row(s) found (e.g. %)', n, sample
    USING HINT = 'seeded fixtures must never reach this environment; '
                 'delete them, or the deploy pipeline is pointed at the wrong database';
END $$;

COMMENT ON FUNCTION registry.assert_no_test_data() IS
  'Safety net for the deploy pipeline. Raises if any TEST-* seeded device is present, including soft-deleted ones. Call before promoting a database to production traffic.';

GRANT EXECUTE ON FUNCTION registry.assert_no_test_data() TO registry_manager;

COMMIT;
