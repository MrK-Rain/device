-- ═══════════════════════════════════════════════════════════════════════════
--  TEST DEVICE SEED — ten synthetic devices for exercising validation and
--  search against something other than an empty table.
--
--  Every serial carries a TEST- prefix so registry.assert_no_test_data()
--  (migration 005) can find and refuse them in any environment that must
--  not hold seed data. Extenders deliberately carry no IMEI/ICCID -- a
--  register where every row is fully populated never tests the "not
--  recorded" path.
--
--    PGOPTIONS="-c registry.seed_mode=on" psql -v ON_ERROR_STOP=1 \
--      -f db/seed/test_devices.sql
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET search_path = registry, public;

-- ── Guard ──────────────────────────────────────────────────────────────────
--  This is for an empty, disposable database only -- never alongside real
--  devices, and never run twice against the same target.
DO $$
BEGIN
  IF coalesce(current_setting('registry.seed_mode', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'refusing to seed: this script writes 10 TEST-* devices'
      USING HINT = 'set registry.seed_mode=on to confirm the target is disposable';
  END IF;

  IF EXISTS (SELECT 1 FROM registry.devices WHERE serial_norm NOT LIKE 'TEST%') THEN
    RAISE EXCEPTION 'refusing to seed: non-test devices already present in registry.devices'
      USING HINT = 'this seed is for an empty or fully-disposable database only';
  END IF;

  IF EXISTS (SELECT 1 FROM registry.devices WHERE serial_norm LIKE 'TEST%') THEN
    RAISE EXCEPTION 'refusing to seed: TEST-* devices already present'
      USING HINT = 'already seeded -- nothing to do';
  END IF;
END $$;

BEGIN;

SET LOCAL search_path = registry, public;
SET LOCAL registry.actor = 'seed-script@rian.co.za';
SET LOCAL registry.actor_role = 'manager';

-- ── Ten devices, every type and every status at least once ─────────────────
--  IMEIs and ICCIDs below are synthetic but Luhn-valid -- see the assertion
--  block after the insert, which checks that against the schema's own
--  registry.luhn_valid() rather than trusting these literals by inspection.
INSERT INTO registry.devices (serial, device_type, status, imei, iccid) VALUES
  ('TEST-0001', 'loop',       'stock',    '356789012345672', '8941100000000000105'),
  ('TEST-0002', 'loop_phone', 'deployed', '490154203237518', '8941100000000000279'),
  ('TEST-0003', '101',        'repair',   '012345678901237', '8941100000000000345'),
  ('TEST-0004', '101a',       'refurb',   '358921000000120', '8941100000000000410'),
  ('TEST-0005', '101pro',     'rma',      '862345019876545', '8941100000000000584'),
  ('TEST-0006', 'extender',   'retired',  NULL,               NULL),
  ('TEST-0007', 'extender',   'stock',    NULL,               NULL),
  ('TEST-0008', 'loop',       'deployed', '352099001761457', '8941100000000000659'),
  ('TEST-0009', '101',        'stock',    '010000000000016', '8941100000000000725'),
  ('TEST-0010', 'loop_phone', 'retired',  '998877665544339', '8941100000000000899');

-- Self-check against the schema's own generated columns: a typo here should
-- fail loudly rather than land a Luhn-invalid fixture that looks fine.
DO $$
DECLARE bad_count int;
BEGIN
  SELECT count(*) INTO bad_count FROM registry.devices
    WHERE serial_norm LIKE 'TEST%'
      AND ((imei IS NOT NULL AND NOT imei_check_ok)
        OR (iccid IS NOT NULL AND NOT iccid_check_ok));
  IF bad_count > 0 THEN
    RAISE EXCEPTION '% seeded device(s) have a Luhn-invalid IMEI or ICCID', bad_count;
  END IF;
END $$;

COMMIT;
