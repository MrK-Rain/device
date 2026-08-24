-- ═══════════════════════════════════════════════════════════════════════════
--  CONTROL TESTS — asserts every stated control actually enforces.
--
--  Run against a throwaway database. Exits non-zero if any control fails,
--  because a test that cannot fail a build is not a test.
--
--    psql -v ON_ERROR_STOP=1 -f db/tests/001_control_tests.sql
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
SET search_path = registry, public;

-- ── Guard ──────────────────────────────────────────────────────────────────
--  This suite writes and deletes rows with a T- serial prefix. Running it
--  against production would be destructive, so it refuses unless explicitly
--  told the target is disposable.
DO $$
BEGIN
  IF coalesce(current_setting('registry.test_mode', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'refusing to run: this suite writes and deletes T-* rows'
      USING HINT = 'set registry.test_mode=on to confirm the target is disposable';
  END IF;
END $$;

-- ── Idempotent reset of this suite's own fixtures only ─────────────────────
--  T-* is this suite's own prefix; TEST-* is the seed script's (db/seed/
--  test_devices.sql) and this suite's own §8 fixture for
--  registry.assert_no_test_data(). They don't collide -- 'T-%' requires a
--  literal '-' as the second character, which 'TEST-%' does not have.
DELETE FROM registry.device_notes
  WHERE device_id IN (SELECT id FROM registry.devices WHERE serial LIKE 'T-%' OR serial LIKE 'TEST-%');
DELETE FROM registry.device_status_history
  WHERE device_id IN (SELECT id FROM registry.devices WHERE serial LIKE 'T-%' OR serial LIKE 'TEST-%');
DELETE FROM registry.devices WHERE serial LIKE 'T-%' OR serial LIKE 'TEST-%';

CREATE TEMP TABLE _results (
  seq     serial PRIMARY KEY,
  section text NOT NULL,
  label   text NOT NULL,
  ok      boolean NOT NULL,
  detail  text
);

-- Recording is privileged; the statement under test is not.
--
-- These have to be separate functions. §5 runs under SET ROLE, and a
-- technician has no rights on this temp table, so recording needs definer
-- rights. But if expect() itself were SECURITY DEFINER the tested statement
-- would run as the owner and every permission check would trivially pass —
-- which is exactly what happened on the first attempt: four role-separation
-- tests reported the technician could do things they cannot.
CREATE FUNCTION pg_temp.record(
  p_section text, p_label text, p_ok boolean, p_detail text
) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO pg_temp._results (section, label, ok, detail)
  VALUES (p_section, p_label, p_ok, p_detail)
$$;

-- SECURITY INVOKER (the default), so p_sql runs with the caller's rights.
CREATE FUNCTION pg_temp.expect(
  p_section text, p_label text, p_sql text, p_want_error boolean
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    PERFORM pg_temp.record(p_section, p_label, p_want_error,
                           'raised: ' || left(SQLERRM, 88));
    RETURN;
  END;
  PERFORM pg_temp.record(p_section, p_label, NOT p_want_error,
    CASE WHEN p_want_error THEN 'allowed, and should not have been' END);
END $$;

-- Assertions go through this rather than inline DO blocks: nesting a $x$
-- block inside the $$ argument of expect() confuses the lexer.
CREATE FUNCTION pg_temp.assert(p_cond boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_cond, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_msg;
  END IF;
END $$;

CREATE FUNCTION pg_temp.note(p_section text, p_label text, p_detail text)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_temp.record(p_section, p_label, true, p_detail)
$$;

SET registry.actor = 'controltests@ci';
SET registry.actor_role = 'manager';

-- ── 1. Identifier validation ───────────────────────────────────────────────
SELECT pg_temp.expect('identifiers', 'IMEI must be 15 digits',
  $$INSERT INTO devices (serial,device_type,imei) VALUES ('T-IMEI-SHORT','loop','12345')$$, true);
SELECT pg_temp.expect('identifiers', 'IMEI rejects non-digits',
  $$INSERT INTO devices (serial,device_type,imei) VALUES ('T-IMEI-ALPHA','loop','35209900176148X')$$, true);
SELECT pg_temp.expect('identifiers', 'ICCID must be 18-20 digits',
  $$INSERT INTO devices (serial,device_type,iccid) VALUES ('T-ICCID-LONG','loop','123456789012345678901234')$$, true);
SELECT pg_temp.expect('identifiers', 'unknown device type refused',
  $$INSERT INTO devices (serial,device_type) VALUES ('T-BADTYPE','tablet')$$, true);
SELECT pg_temp.expect('identifiers', 'unknown status refused',
  $$INSERT INTO devices (serial,device_type,status) VALUES ('T-BADSTAT','loop','lost')$$, true);
SELECT pg_temp.expect('identifiers', 'valid device accepted',
  $$INSERT INTO devices (serial,device_type,imei,iccid)
    VALUES ('T-OK-001','loop','490154203237518','8944500912345678901')$$, false);
SELECT pg_temp.expect('identifiers', 'duplicate serial refused, punctuation-insensitive',
  $$INSERT INTO devices (serial,device_type) VALUES ('t ok 001','loop')$$, true);
SELECT pg_temp.expect('identifiers', 'duplicate IMEI refused',
  $$INSERT INTO devices (serial,device_type,imei) VALUES ('T-OK-002','101','490154203237518')$$, true);
SELECT pg_temp.note('identifiers', 'Luhn advisory flags recorded',
  (SELECT 'imei_check_ok=' || imei_check_ok || ' iccid_check_ok=' || iccid_check_ok
   FROM devices WHERE serial = 'T-OK-001'));

-- ── 2. Personal-data screening, server side ────────────────────────────────
SELECT pg_temp.expect('personal data', 'note containing an email refused',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Escalated to tech@rian.co.za for parts' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'note containing a SA mobile number refused',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Called 082 555 1234 to arrange the swap' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'note containing a SA ID number refused',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Handover ref 8001015009087 signed' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'note containing a street address refused',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Collected from 14 Mill Road depot' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'note containing a date of birth refused',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'DOB on the paperwork did not match' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'serial containing an email refused',
  $$INSERT INTO devices (serial,device_type) VALUES ('T-a@b.co','loop')$$, true);
SELECT pg_temp.expect('personal data', 'clean repair note accepted',
  $$INSERT INTO device_notes (device_id,body,kind)
    SELECT id,'Replaced antenna lead, reflashed firmware 2.4.1, passed loop test on 2026-07-25 at 14:30','repair'
    FROM devices WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.expect('personal data', 'a date in a note is not read as a phone number',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Bench tested 2026-07-25, retest due 2026-10-01' FROM devices WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.expect('personal data', 'a grouped ICCID is not read as a phone number',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'SIM printed 8944 5009 1234 5678 901 matches the label' FROM devices WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.expect('personal data', 'advisory phrase requires a named acknowledger',
  $$INSERT INTO device_notes (device_id,body)
    SELECT id,'Box had a subscriber label on it, removed' FROM devices WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('personal data', 'advisory phrase accepted once acknowledged',
  $$INSERT INTO device_notes (device_id,body,advisory_findings,advisory_ack_by)
    SELECT id,'Box had a subscriber label on it, removed',
           ARRAY['advisory:personal_data_phrase'],'controltests@ci'
    FROM devices WHERE serial='T-OK-001'$$, false);

-- ── 3. Immutability and attribution ────────────────────────────────────────
SELECT pg_temp.expect('immutability', 'serial cannot be edited',
  $$UPDATE devices SET serial='T-OK-999' WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('immutability', 'created_by cannot be rewritten',
  $$UPDATE devices SET created_by='someone_else' WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('immutability', 'status change allowed',
  $$UPDATE devices SET status='refurb' WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.note('immutability', 'status history written by trigger',
  (SELECT string_agg(coalesce(from_status,'(new)')||' -> '||to_status, ', ' ORDER BY id)
   FROM device_status_history WHERE device_id=(SELECT id FROM devices WHERE serial='T-OK-001')));
SELECT pg_temp.expect('immutability', 'soft delete requires a reason',
  $$UPDATE devices SET deleted_at=now(), deleted_by='controltests@ci' WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('immutability', 'soft delete accepted with a reason',
  $$UPDATE devices SET deleted_at=now(), deleted_by='controltests@ci',
      delete_reason='control test lifecycle check' WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.expect('immutability', 'serial reusable after soft delete',
  $$INSERT INTO devices (serial,device_type) VALUES ('T-OK-001','loop')$$, false);

RESET registry.actor;
SELECT pg_temp.expect('attribution', 'write without an actor refused',
  $$INSERT INTO devices (serial,device_type) VALUES ('T-NOACTOR','loop')$$, true);
SET registry.actor = 'controltests@ci';

-- ── 4. Audit log ───────────────────────────────────────────────────────────
SELECT pg_temp.expect('audit', 'audit entry accepted',
  $$SELECT registry.audit('search','devices',NULL,'{"q":"345678","hits":6}'::jsonb)$$, false);
SELECT pg_temp.expect('audit', 'unknown action refused',
  $$SELECT registry.audit('exfiltrate','devices')$$, true);
SELECT pg_temp.expect('audit', 'audit rows cannot be updated',
  $$UPDATE registry.audit_log SET actor='someone_else' WHERE actor='controltests@ci'$$, true);
SELECT pg_temp.expect('audit', 'audit rows cannot be deleted',
  $$DELETE FROM registry.audit_log WHERE actor='controltests@ci'$$, true);
SELECT pg_temp.note('audit', 'monthly partitions present',
  (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='registry' AND c.relname ~ '^audit_log_[0-9]{6}$'));

-- ── 5. Role separation ─────────────────────────────────────────────────────
SET ROLE registry_technician;
SELECT pg_temp.expect('roles', 'technician may not register a device',
  $$INSERT INTO devices (serial,device_type) VALUES ('T-TECH','loop')$$, true);
SELECT pg_temp.expect('roles', 'technician may not change an IMEI',
  $$UPDATE devices SET imei='490154203237518' WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('roles', 'technician may not soft delete',
  $$UPDATE devices SET deleted_at=now() WHERE serial='T-OK-001'$$, true);
SELECT pg_temp.expect('roles', 'technician may change status',
  $$UPDATE devices SET status='repair' WHERE serial='T-OK-001'$$, false);
SELECT pg_temp.expect('roles', 'technician may add a note',
  $$INSERT INTO device_notes (device_id,body) SELECT id,'Bench check complete, no fault found'
    FROM devices WHERE serial='T-OK-001' AND deleted_at IS NULL$$, false);
SELECT pg_temp.expect('roles', 'technician may not read the audit log',
  $$SELECT count(*) FROM registry.audit_log$$, true);
RESET ROLE;

SET ROLE registry_readonly;
SELECT pg_temp.expect('roles', 'read-only may not add a note',
  $$INSERT INTO device_notes (device_id,body) SELECT id,'should not be possible'
    FROM devices WHERE serial='T-OK-001' AND deleted_at IS NULL$$, true);
SELECT pg_temp.expect('roles', 'read-only may search',
  $$SELECT count(*) FROM registry.search_devices('T-OK')$$, false);
RESET ROLE;

-- ── 6. Search correctness ──────────────────────────────────────────────────
SELECT pg_temp.expect('search', 'exact serial found and ranked as exact',
  $$SELECT pg_temp.assert(EXISTS (
      SELECT 1 FROM registry.search_devices('T-OK-001') WHERE match_kind = 'serial_exact'),
      'exact serial did not match')$$, false);
SELECT pg_temp.expect('search', 'punctuation in the query is ignored',
  $$SELECT pg_temp.assert(EXISTS (
      SELECT 1 FROM registry.search_devices('t.ok.001')), 'normalised serial did not match')$$, false);
SELECT pg_temp.expect('search', 'fragments under 3 characters return nothing',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM registry.search_devices('T')), 'short fragment was allowed to scan')$$, false);
SELECT pg_temp.expect('search', 'soft-deleted rows excluded from the live view',
  $$SELECT pg_temp.assert(
      (SELECT count(*) FROM registry.v_devices WHERE serial = 'T-OK-001') = 1,
      'live view did not return exactly the undeleted row')$$, false);
SELECT pg_temp.expect('search', 'a quote in the query does not break the dynamic SQL',
  $$SELECT count(*) FROM registry.search_devices(chr(39) || ' OR 1=1 --')$$, false);
SELECT pg_temp.expect('search', 'a backslash in the query does not break the dynamic SQL',
  $$SELECT count(*) FROM registry.search_devices('a\b' || chr(92))$$, false);

-- ── 6b. Note search (migration 002) ────────────────────────────────────────
-- Searches the note added in §5, which belongs to the live T-OK-001. The
-- earlier 'antenna' note sits on the copy §3 soft-deletes, so it is correctly
-- invisible here — an earlier version of this test asserted the opposite and
-- failed, which is the function behaving properly.
SELECT pg_temp.expect('note search', 'finds a device by a word in its history',
  $$SELECT pg_temp.assert(EXISTS (
      SELECT 1 FROM registry.search_notes('bench')
      WHERE serial = 'T-OK-001'), 'word search did not find the live note')$$, false);
SELECT pg_temp.expect('note search', 'stems, so a plural matches the singular',
  $$SELECT pg_temp.assert(EXISTS (
      SELECT 1 FROM registry.search_notes('faults')), 'stemming did not apply')$$, false);
SELECT pg_temp.expect('note search', 'quoted phrase is accepted, not a syntax error',
  $$SELECT count(*) FROM registry.search_notes('"bench check"')$$, false);
SELECT pg_temp.expect('note search', 'punctuation-only input returns nothing rather than raising',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM registry.search_notes('&&& !!!')), 'garbage input was not handled')$$, false);
SELECT pg_temp.expect('note search', 'empty terms do not scan the table',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM registry.search_notes('')), 'empty query returned rows')$$, false);
SELECT pg_temp.expect('note search', 'soft-deleted devices excluded from note results',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM registry.search_notes('antenna') s
      JOIN registry.devices d ON d.id = s.device_id WHERE d.deleted_at IS NOT NULL),
      'a soft-deleted device appeared in note search')$$, false);
SELECT pg_temp.expect('note search', 'the oversized trigram index on bodies is gone',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname='registry'
      AND indexname='device_notes_body_trgm'), 'trigram index on note bodies still present')$$, false);

-- ── 6c. Audit partition headroom (migration 004) ───────────────────────────
--  registry.audit() runs inside every read and write. If partitions run out,
--  the whole register stops, so headroom is a control, not housekeeping.
SELECT pg_temp.expect('audit partitions', 'at least two months of headroom remain',
  $$SELECT pg_temp.assert(registry.audit_partition_headroom() >= 2,
      'audit partitions are running out; schedule ensure_audit_partitions_ahead')$$, false);
SELECT pg_temp.expect('audit partitions', 'the default partition is empty',
  $$SELECT pg_temp.assert(
      (SELECT count(*) FROM registry.audit_log_unpartitioned) = 0,
      'rows have landed in the default partition, so rotation has stopped')$$, false);
SELECT pg_temp.expect('audit partitions', 'creating partitions is idempotent',
  $$SELECT pg_temp.assert(
      (SELECT count(*) FROM registry.ensure_audit_partitions_ahead(3) WHERE created) = 0,
      'a second call created partitions that should already exist')$$, false);
SELECT pg_temp.note('audit partitions', 'health',
  (SELECT 'headroom=' || months_headroom || 'mo partitions=' || monthly_partitions
          || ' default_rows=' || rows_in_default
     FROM registry.v_audit_partition_health));

-- ── 7. Data minimisation ───────────────────────────────────────────────────
--  The strongest guarantee that this register holds no individual data is
--  that there is nowhere to put any. Asserted against the live catalog rather
--  than by grepping the migration, which cannot tell a column definition from
--  a local variable or a comment.
SELECT pg_temp.expect('data minimisation', 'no column name implies personal data',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'registry'
        AND column_name ~* '(^|_)(name|surname|email|phone|msisdn|address|passport|dob|customer|subscriber|holder)($|_)'
    ), 'a column implying personal data exists in the registry schema')$$, false);
SELECT pg_temp.expect('data minimisation', 'no id-number style column',
  $$SELECT pg_temp.assert(NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'registry'
        AND column_name ~* '(id_number|idnumber|national_id|date_of_birth)'
    ), 'an identity-document column exists in the registry schema')$$, false);
SELECT pg_temp.note('data minimisation', 'registry columns present',
  (SELECT count(*)::text || ' columns across ' || count(DISTINCT table_name)::text || ' relations'
   FROM information_schema.columns WHERE table_schema = 'registry'));

-- ── 8. Test data guard (migration 005) ─────────────────────────────────────
--  A synthetic IMEI with a correct check digit is indistinguishable from a
--  real one by inspection, so this has to be a structural check the deploy
--  pipeline can call, not a human remembering to look.
SELECT pg_temp.expect('test data guard', 'clean database passes',
  $$SELECT registry.assert_no_test_data()$$, false);
SELECT pg_temp.expect('test data guard', 'fixture: TEST-* device inserted',
  $$INSERT INTO devices (serial,device_type) VALUES ('TEST-GUARD-0001','loop')$$, false);
SELECT pg_temp.expect('test data guard', 'a single TEST-* row is caught',
  $$SELECT registry.assert_no_test_data()$$, true);
SELECT pg_temp.expect('test data guard', 'fixture: TEST-* device soft-deleted',
  $$UPDATE devices SET deleted_at=now(), deleted_by='controltests@ci',
      delete_reason='control test cleanup' WHERE serial='TEST-GUARD-0001'$$, false);
SELECT pg_temp.expect('test data guard', 'a soft-deleted TEST-* row is still caught',
  $$SELECT registry.assert_no_test_data()$$, true);
SELECT pg_temp.expect('test data guard', 'fixture: TEST-* device removed',
  $$DELETE FROM devices WHERE serial='TEST-GUARD-0001'$$, false);
SELECT pg_temp.expect('test data guard', 'guard clears once the row is gone',
  $$SELECT registry.assert_no_test_data()$$, false);

-- ── Report ─────────────────────────────────────────────────────────────────
\echo ''
\pset border 2
SELECT section, label, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       coalesce(detail, '') AS detail
FROM _results ORDER BY seq;

DO $$
DECLARE failed int; total int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO failed, total FROM _results;
  IF failed > 0 THEN
    RAISE EXCEPTION '% of % control tests FAILED', failed, total;
  END IF;
  RAISE NOTICE 'all % control tests passed', total;
END $$;
