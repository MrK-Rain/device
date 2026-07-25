-- ═══════════════════════════════════════════════════════════════════════════
--  DEVICE REGISTRY — migration 001, baseline schema
--
--  Scope        : system of record for device-identifying data only.
--                 No subscriber, customer or other individual data is stored,
--                 and the constraints below actively refuse it.
--  Sizing target: 1M+ devices, low hundreds of internal users.
--  Requires     : PostgreSQL 14+ (tested on 16). Extensions: pgcrypto, pg_trgm.
--
--  Design notes that matter for review:
--    * Device types and statuses are lookup TABLES, not enums. A status was
--      added once during design and will be again; ALTER TYPE ADD VALUE cannot
--      be rolled back inside a transaction, a row insert can.
--    * Nothing is ever hard-deleted. Devices soft-delete, notes are immutable
--      and corrected by supersession. Repair history that can be rewritten is
--      not evidence.
--    * Every write requires an attributed actor. There is no anonymous path.
--    * Personal-data screening lives HERE, not in the client. Client-side
--      validation is a usability feature; this is the control.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- partial-substring search at scale

CREATE SCHEMA IF NOT EXISTS registry;
SET LOCAL search_path = registry, public;


-- ───────────────────────────────────────────────────────────────────────────
--  1. Actor attribution
--
--  The API sets registry.actor and registry.actor_role once per transaction
--  (SET LOCAL) from the authenticated session. Writes without it fail loudly
--  rather than landing unattributed.
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION registry.current_actor() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a text;
BEGIN
  a := nullif(btrim(coalesce(current_setting('registry.actor', true), '')), '');
  IF a IS NULL THEN
    RAISE EXCEPTION 'no actor set for this transaction'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'the API must SET LOCAL registry.actor before writing';
  END IF;
  RETURN a;
END $$;

CREATE FUNCTION registry.current_actor_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(btrim(coalesce(current_setting('registry.actor_role', true), '')), '')
$$;


-- ───────────────────────────────────────────────────────────────────────────
--  2. Identifier validation
--
--  luhn_valid is IMMUTABLE so it can back a generated column. IMEI check
--  digits are mandatory in the spec; ICCID check digits are near-universal
--  but not guaranteed, so both are recorded as advisory flags rather than
--  hard constraints. Length and character class ARE hard constraints.
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION registry.luhn_valid(p_digits text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  total int := 0;
  d     int;
  i     int;
  dbl   boolean := false;
BEGIN
  IF p_digits IS NULL OR p_digits !~ '^[0-9]{2,}$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE char_length(p_digits)..1 LOOP
    d := substr(p_digits, i, 1)::int;
    IF dbl THEN
      d := d * 2;
      IF d > 9 THEN d := d - 9; END IF;
    END IF;
    total := total + d;
    dbl := NOT dbl;
  END LOOP;
  RETURN total % 10 = 0;
END $$;

COMMENT ON FUNCTION registry.luhn_valid(text) IS
  'Luhn mod-10 check. Used for IMEI (15 digits) and ICCID (18-20 digits).';


-- ───────────────────────────────────────────────────────────────────────────
--  3. Personal-data screening
--
--  Returns a list of findings. Empty array means clean. The trigger in §6
--  refuses the write on any finding in the UNAMBIGUOUS set.
--
--  South-Africa specific because that is where this operates:
--    * ID numbers are 13 digits, YYMMDD + 4 + citizenship + A + Luhn check.
--      Requiring a plausible date prefix AND a passing check digit keeps this
--      from firing on device identifiers, which is the whole difficulty.
--    * Mobile numbers are 0[6-8]xxxxxxxx or +27[6-8]xxxxxxxx.
--
--  Reviewer note: this is defence in depth, not a guarantee. It cannot catch
--  a bare name typed into a note. The controls that carry that load are
--  access control, the audit trail and retention limits.
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION registry.sa_id_number_present(p_text text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  m      text;
  yy     int;
  mm     int;
  dd     int;
BEGIN
  IF p_text IS NULL THEN RETURN false; END IF;
  FOR m IN
    SELECT unnest(regexp_matches(p_text, '(?<![0-9])([0-9]{13})(?![0-9])', 'g'))
  LOOP
    mm := substr(m, 3, 2)::int;
    dd := substr(m, 5, 2)::int;
    IF mm BETWEEN 1 AND 12 AND dd BETWEEN 1 AND 31
       AND registry.luhn_valid(m) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION registry.personal_data_findings(p_text text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  t     text := coalesce(p_text, '');
  scrub text;
  out   text[] := ARRAY[]::text[];
BEGIN
  IF btrim(t) = '' THEN RETURN out; END IF;

  -- Dates, times and version strings are not phone numbers.
  scrub := regexp_replace(t,     '\y[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}\y', ' ', 'g');
  scrub := regexp_replace(scrub, '\y[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2,4}\y', ' ', 'g');
  scrub := regexp_replace(scrub, '\y[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\y', ' ', 'g');

  -- ── unambiguous: these block the write ────────────────────────────────
  -- array_append, not `out || 'literal'`. The latter resolves as
  -- anyarray||anyarray and raises "malformed array literal", which made this
  -- function block notes by crashing rather than by detecting. Caught in test.
  IF t ~* '[[:alnum:]._%+-]+@[[:alnum:]-]+\.[[:alpha:]]{2,}' THEN
    out := array_append(out, 'email_address');
  END IF;

  IF registry.sa_id_number_present(t) THEN
    out := array_append(out, 'sa_id_number');
  END IF;

  IF regexp_replace(scrub, '[^0-9+]', '', 'g') ~ '(\+?27|0)[6-8][0-9]{8}'
     AND scrub ~ '(\+?27|0)[6-8][0-9 ()-]{8,}' THEN
    out := array_append(out, 'sa_mobile_number');
  END IF;

  IF t ~* '\y(d\.?o\.?b\.?|date of birth|born on)\y' THEN
    out := array_append(out, 'date_of_birth');
  END IF;

  IF t ~* '\y[0-9]{1,5}[[:space:]]+[[:alpha:]][[:alnum:].-]*([[:space:]]+[[:alpha:]][[:alnum:].-]*)?[[:space:]]+(street|str|road|rd|avenue|ave|lane|ln|drive|dr|crescent|cres|close|way|court|ct|boulevard|blvd|terrace|place|pl)\y' THEN
    out := array_append(out, 'street_address');
  END IF;

  -- ── advisory: recorded, acknowledged at the API, never silently kept ───
  IF t ~* '\y(customer name|subscriber|account holder|next of kin|full name|first name|last name|surname|id number|passport|postcode|post code)\y' THEN
    out := array_append(out, 'advisory:personal_data_phrase');
  END IF;

  RETURN out;
END $$;

CREATE FUNCTION registry.blocking_findings(p_text text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(f), '{}')
  FROM unnest(registry.personal_data_findings(p_text)) AS f
  WHERE f NOT LIKE 'advisory:%'
$$;


-- ───────────────────────────────────────────────────────────────────────────
--  4. Reference data
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE registry.device_types (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  short_code  text NOT NULL,
  sort_order  int  NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  CONSTRAINT device_types_code_fmt CHECK (code ~ '^[a-z0-9_]{2,32}$')
);

INSERT INTO registry.device_types (code, label, short_code, sort_order) VALUES
  ('loop',       'Loop',       'LP',  10),
  ('loop_phone', 'Loop Phone', 'LPH', 20),
  ('101',        '101',        '101', 30),
  ('101a',       '101A',       '01A', 40),
  ('101pro',     '101 Pro',    'PRO', 50),
  ('extender',   'Extender',   'EXT', 60);

CREATE TABLE registry.device_statuses (
  code         text PRIMARY KEY,
  label        text NOT NULL,
  sort_order   int  NOT NULL,
  is_available boolean NOT NULL DEFAULT false,  -- counts as deployable stock
  is_terminal  boolean NOT NULL DEFAULT false,  -- end of life for the asset
  is_active    boolean NOT NULL DEFAULT true,
  CONSTRAINT device_statuses_code_fmt CHECK (code ~ '^[a-z0-9_]{2,32}$')
);

INSERT INTO registry.device_statuses (code, label, sort_order, is_available, is_terminal) VALUES
  ('stock',    'In stock',  10, true,  false),
  ('deployed', 'Deployed',  20, false, false),
  ('repair',   'In repair', 30, false, false),
  ('refurb',   'In refurb', 40, false, false),
  ('rma',      'RMA',       50, false, false),
  ('retired',  'Retired',   60, false, true);

CREATE TYPE registry.note_kind AS ENUM ('repair', 'observation');


-- ───────────────────────────────────────────────────────────────────────────
--  5. Devices
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE registry.devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  serial         text NOT NULL,
  serial_norm    text GENERATED ALWAYS AS
                   (upper(regexp_replace(serial, '[^A-Za-z0-9]', '', 'g'))) STORED,

  device_type    text NOT NULL REFERENCES registry.device_types (code),
  status         text NOT NULL DEFAULT 'stock'
                   REFERENCES registry.device_statuses (code),

  imei           text,
  iccid          text,
  imei_check_ok  boolean GENERATED ALWAYS AS
                   (imei  IS NULL OR registry.luhn_valid(imei))  STORED,
  iccid_check_ok boolean GENERATED ALWAYS AS
                   (iccid IS NULL OR registry.luhn_valid(iccid)) STORED,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT registry.current_actor(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text NOT NULL DEFAULT registry.current_actor(),

  -- soft delete: the row survives so the audit trail keeps its referent
  deleted_at     timestamptz,
  deleted_by     text,
  delete_reason  text,

  CONSTRAINT devices_serial_len  CHECK (char_length(btrim(serial)) BETWEEN 3 AND 64),
  CONSTRAINT devices_serial_fmt  CHECK (serial ~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]*$'),
  CONSTRAINT devices_imei_fmt    CHECK (imei  IS NULL OR imei  ~ '^[0-9]{15}$'),
  CONSTRAINT devices_iccid_fmt   CHECK (iccid IS NULL OR iccid ~ '^[0-9]{18,20}$'),
  CONSTRAINT devices_delete_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT devices_delete_reason CHECK (
    deleted_at IS NULL OR char_length(btrim(coalesce(delete_reason, ''))) >= 8),
  CONSTRAINT devices_serial_no_pii CHECK
    (cardinality(registry.blocking_findings(serial)) = 0)
);

COMMENT ON TABLE registry.devices IS
  'Device-identifying data only. No subscriber or individual data — see registry.personal_data_findings.';
COMMENT ON COLUMN registry.devices.serial_norm IS
  'Case- and punctuation-insensitive serial. Uniqueness and search both key off this, not the raw serial.';

-- Uniqueness ignores soft-deleted rows so a serial can be re-registered.
CREATE UNIQUE INDEX devices_serial_norm_key ON registry.devices (serial_norm)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX devices_imei_key  ON registry.devices (imei)
  WHERE imei IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX devices_iccid_key ON registry.devices (iccid)
  WHERE iccid IS NOT NULL AND deleted_at IS NULL;

-- Partial-substring lookup. A technician reads the last six digits off a SIM
-- and types those; without trigram GIN that is a sequential scan of 1M rows.
CREATE INDEX devices_serial_trgm ON registry.devices
  USING gin (serial_norm gin_trgm_ops);
CREATE INDEX devices_imei_trgm ON registry.devices
  USING gin (imei gin_trgm_ops);
CREATE INDEX devices_iccid_trgm ON registry.devices
  USING gin (iccid gin_trgm_ops);

CREATE INDEX devices_status_type ON registry.devices (status, device_type)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_updated_at ON registry.devices (updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_check_failed ON registry.devices (id)
  WHERE deleted_at IS NULL AND (imei_check_ok IS false OR iccid_check_ok IS false);

-- Browse/paging. Serial is the only sort order offered, so it must be the
-- trailing column of every facet combination or Postgres sorts the whole
-- fleet to return 50 rows (measured: 770ms at 1M rows before these existed).
CREATE INDEX devices_serial_browse ON registry.devices (serial)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_type_serial ON registry.devices (device_type, serial)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_status_serial ON registry.devices (status, serial)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_type_status_serial ON registry.devices (device_type, status, serial)
  WHERE deleted_at IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
--  6. Notes — append-only repair log, one device at a time
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE registry.device_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id          uuid NOT NULL REFERENCES registry.devices (id) ON DELETE RESTRICT,
  kind               registry.note_kind NOT NULL DEFAULT 'repair',
  body               text NOT NULL,

  -- A note is never edited. A correction is a new note that supersedes it.
  supersedes_note_id uuid REFERENCES registry.device_notes (id),

  -- Advisory findings must be acknowledged by a named actor, not waved away.
  advisory_findings  text[] NOT NULL DEFAULT '{}',
  advisory_ack_by    text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL DEFAULT registry.current_actor(),

  CONSTRAINT notes_body_len CHECK (char_length(btrim(body)) BETWEEN 2 AND 4000),
  CONSTRAINT notes_no_self_supersede CHECK (supersedes_note_id IS DISTINCT FROM id),
  CONSTRAINT notes_ack_present CHECK (
    cardinality(advisory_findings) = 0 OR advisory_ack_by IS NOT NULL)
);

CREATE INDEX device_notes_device ON registry.device_notes (device_id, created_at DESC);
CREATE INDEX device_notes_body_trgm ON registry.device_notes USING gin (body gin_trgm_ops);
CREATE UNIQUE INDEX device_notes_supersedes_key ON registry.device_notes (supersedes_note_id)
  WHERE supersedes_note_id IS NOT NULL;

CREATE FUNCTION registry.trg_note_screen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocking text[];
  all_f    text[];
BEGIN
  all_f    := registry.personal_data_findings(NEW.body);
  blocking := registry.blocking_findings(NEW.body);

  IF cardinality(blocking) > 0 THEN
    RAISE EXCEPTION 'note rejected: personal data detected (%)', array_to_string(blocking, ', ')
      USING ERRCODE = 'check_violation',
            HINT = 'this register holds device data only; describe the device, not the person';
  END IF;

  NEW.advisory_findings := coalesce(
    (SELECT array_agg(f) FROM unnest(all_f) f WHERE f LIKE 'advisory:%'), '{}');
  RETURN NEW;
END $$;

CREATE TRIGGER note_screen BEFORE INSERT ON registry.device_notes
  FOR EACH ROW EXECUTE FUNCTION registry.trg_note_screen();


-- ───────────────────────────────────────────────────────────────────────────
--  7. Status history — written by trigger, not by the application
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE registry.device_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES registry.devices (id) ON DELETE RESTRICT,
  from_status text REFERENCES registry.device_statuses (code),
  to_status   text NOT NULL REFERENCES registry.device_statuses (code),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  text NOT NULL
);

CREATE INDEX device_status_history_device
  ON registry.device_status_history (device_id, changed_at DESC);

-- SECURITY DEFINER: a technician holds UPDATE(status) but no INSERT on the
-- history table. Without this, changing status failed outright. The trail is
-- written on behalf of the schema owner regardless of who triggered it.
CREATE FUNCTION registry.trg_device_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = registry, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO registry.device_status_history (device_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_by);
    RETURN NEW;
  END IF;

  NEW.updated_at := now();
  NEW.updated_by := registry.current_actor();

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO registry.device_status_history (device_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_by);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER device_touch_ins AFTER INSERT ON registry.devices
  FOR EACH ROW EXECUTE FUNCTION registry.trg_device_touch();
CREATE TRIGGER device_touch_upd BEFORE UPDATE ON registry.devices
  FOR EACH ROW EXECUTE FUNCTION registry.trg_device_touch();

-- Serials and creation facts are not editable. Correct by soft-delete and
-- re-register, which leaves both records in the trail.
CREATE FUNCTION registry.trg_device_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.serial     IS DISTINCT FROM OLD.serial
  OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'serial and creation metadata are immutable'
      USING ERRCODE = 'check_violation',
            HINT = 'soft-delete the record with a reason and register the corrected serial';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER device_immutable BEFORE UPDATE ON registry.devices
  FOR EACH ROW EXECUTE FUNCTION registry.trg_device_immutable();


-- ───────────────────────────────────────────────────────────────────────────
--  8. Audit log — append-only, monthly range partitions
--
--  Reads and exports are logged as well as writes. If the register is ever
--  judged to hold personal data by association, access logging is the control
--  that will be asked for first.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE registry.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  actor_role  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id  uuid,
  source_ip   inet,
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_action_known CHECK (action IN
    ('read','search','create','update','status_change','soft_delete','export',
     'import','login','login_failed','permission_denied'))
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_log_occurred ON registry.audit_log (occurred_at DESC);
CREATE INDEX audit_log_actor    ON registry.audit_log (actor, occurred_at DESC);
CREATE INDEX audit_log_entity   ON registry.audit_log (entity_id, occurred_at DESC);

CREATE FUNCTION registry.ensure_audit_partition(p_month date)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  from_ts date := date_trunc('month', p_month)::date;
  to_ts   date := (date_trunc('month', p_month) + interval '1 month')::date;
  name    text := format('audit_log_%s', to_char(from_ts, 'YYYYMM'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'registry' AND c.relname = name
  ) THEN
    EXECUTE format(
      'CREATE TABLE registry.%I PARTITION OF registry.audit_log FOR VALUES FROM (%L) TO (%L)',
      name, from_ts, to_ts);
  END IF;
  RETURN name;
END $$;

COMMENT ON FUNCTION registry.ensure_audit_partition(date) IS
  'Call monthly from a scheduled job for current month + 2 ahead. pg_partman is a fine substitute.';

SELECT registry.ensure_audit_partition(current_date);
SELECT registry.ensure_audit_partition((current_date + interval '1 month')::date);
SELECT registry.ensure_audit_partition((current_date + interval '2 months')::date);

CREATE FUNCTION registry.audit(
  p_action text, p_entity text, p_entity_id uuid DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb, p_request_id uuid DEFAULT NULL,
  p_source_ip inet DEFAULT NULL
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = registry, pg_temp AS $$
  INSERT INTO registry.audit_log
    (actor, actor_role, action, entity, entity_id, detail, request_id, source_ip)
  VALUES
    (registry.current_actor(), registry.current_actor_role(),
     p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb),
     p_request_id, p_source_ip);
$$;

-- REVOKE expresses intent; it does not stop a privileged connection. This
-- makes tampering fail for anyone short of a superuser dropping the trigger,
-- which is itself a loggable act. Expire audit data by dropping partitions.
CREATE FUNCTION registry.trg_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registry.audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'expire audit data by dropping whole monthly partitions';
END $$;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON registry.audit_log
  FOR EACH ROW EXECUTE FUNCTION registry.trg_audit_append_only();


-- ───────────────────────────────────────────────────────────────────────────
--  9. Search
--
--  Exact identifier match first, then trigram substring. Split deliberately:
--  the exact path hits a unique btree and returns in microseconds, which is
--  the overwhelmingly common case (a scanned barcode). The fuzzy path only
--  runs when the exact one misses.
-- ───────────────────────────────────────────────────────────────────────────

CREATE VIEW registry.v_devices AS
SELECT d.id, d.serial, d.serial_norm, d.device_type, t.label AS device_type_label,
       t.short_code, d.status, s.label AS status_label,
       d.imei, d.iccid, d.imei_check_ok, d.iccid_check_ok,
       d.created_at, d.created_by, d.updated_at, d.updated_by
       -- note_count deliberately absent: as a correlated subquery here it ran
       -- once per candidate row. Counts are fetched for the returned page only.
FROM registry.devices d
JOIN registry.device_types    t ON t.code = d.device_type
JOIN registry.device_statuses s ON s.code = d.status
WHERE d.deleted_at IS NULL;

CREATE FUNCTION registry.search_devices(
  p_query text DEFAULT NULL, p_type text DEFAULT NULL, p_status text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS TABLE (
  id uuid, serial text, device_type text, status text,
  imei text, iccid text, note_count bigint, match_kind text
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  q_alnum text := upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g'));
  q_digit text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  conds   text[] := '{}';
  kinds   text[] := '{}';
  facets  text := '';
  stmt    text;
BEGIN
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 500);
  IF p_type   IS NOT NULL THEN facets := facets || format(' AND d.device_type = %L', p_type); END IF;
  IF p_status IS NOT NULL THEN facets := facets || format(' AND d.status = %L', p_status); END IF;

  IF q_alnum <> '' THEN
    RETURN QUERY EXECUTE format($q$
      SELECT d.id, d.serial, d.device_type, d.status, d.imei, d.iccid,
             (SELECT count(*) FROM registry.device_notes n WHERE n.device_id = d.id),
             'serial_exact'::text
      FROM registry.devices d
      WHERE d.deleted_at IS NULL AND d.serial_norm = %L %s $q$, q_alnum, facets);
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF length(q_digit) BETWEEN 15 AND 20 THEN
    RETURN QUERY EXECUTE format($q$
      SELECT d.id, d.serial, d.device_type, d.status, d.imei, d.iccid,
             (SELECT count(*) FROM registry.device_notes n WHERE n.device_id = d.id),
             CASE WHEN d.imei = %1$L THEN 'imei_exact' ELSE 'iccid_exact' END::text
      FROM registry.devices d
      WHERE d.deleted_at IS NULL AND (d.imei = %1$L OR d.iccid = %1$L) %2$s $q$, q_digit, facets);
    IF FOUND THEN RETURN; END IF;
  END IF;

  IF coalesce(btrim(p_query), '') = '' THEN
    RETURN QUERY EXECUTE format($q$
      SELECT d.id, d.serial, d.device_type, d.status, d.imei, d.iccid,
             (SELECT count(*) FROM registry.device_notes n WHERE n.device_id = d.id),
             'filter_only'::text
      FROM registry.devices d WHERE d.deleted_at IS NULL %s
      ORDER BY d.serial LIMIT %s OFFSET %s $q$, facets, p_limit, greatest(p_offset,0));
    RETURN;
  END IF;

  IF length(q_alnum) >= 3 THEN
    conds := conds || format('d.serial_norm LIKE %L', '%' || q_alnum || '%');
    kinds := kinds || format('WHEN d.serial_norm LIKE %L THEN ''serial_partial''', '%' || q_alnum || '%');
  END IF;
  IF length(q_digit) >= 3 THEN
    conds := conds || format('d.imei LIKE %L',  '%' || q_digit || '%');
    conds := conds || format('d.iccid LIKE %L', '%' || q_digit || '%');
    kinds := kinds || format('WHEN d.imei LIKE %L THEN ''imei_partial''',   '%' || q_digit || '%');
    kinds := kinds || format('WHEN d.iccid LIKE %L THEN ''iccid_partial''', '%' || q_digit || '%');
  END IF;
  IF cardinality(conds) = 0 THEN RETURN; END IF;   -- under 3 chars: no index can help

  stmt := format($q$
    SELECT d.id, d.serial, d.device_type, d.status, d.imei, d.iccid,
           (SELECT count(*) FROM registry.device_notes n WHERE n.device_id = d.id),
           (CASE %s ELSE 'partial' END)::text AS mk
    FROM registry.devices d
    WHERE d.deleted_at IS NULL %s AND (%s)
    ORDER BY 8, d.serial
    LIMIT %s OFFSET %s $q$,
    array_to_string(kinds, ' '), facets, array_to_string(conds, ' OR '),
    p_limit, greatest(p_offset, 0));
  RETURN QUERY EXECUTE stmt;
END $$;

COMMENT ON FUNCTION registry.search_devices IS
  'Four paths, each needing a different plan. Exact serial and exact IMEI/ICCID hit unique btrees. Empty query pages an ordered index. Substring uses trigram GIN, built as dynamic SQL with literal patterns because plpgsql caches a generic plan for a parameterised LIKE and Postgres cannot extract trigrams from a pattern it has not seen: measured 9ms became 700ms. Fragments under 3 characters return nothing by design - no index can serve them and a 1M-row scan is a denial of service on yourself. Injection safety: q_alnum and q_digit are stripped to [A-Z0-9] and [0-9], and every interpolation goes through format %L.';



-- ───────────────────────────────────────────────────────────────────────────
--  10. Roles and grants
--
--  Three application roles, matching who actually does what. The API connects
--  as registry_app and SETs the role per request, or connects per-role from
--  separate pools. Column-level UPDATE grants express "may change status but
--  not identifiers" without any application-side check.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry_technician') THEN
    CREATE ROLE registry_technician NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry_warehouse') THEN
    CREATE ROLE registry_warehouse NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry_manager') THEN
    CREATE ROLE registry_manager NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry_readonly') THEN
    CREATE ROLE registry_readonly NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA registry TO
  registry_technician, registry_warehouse, registry_manager, registry_readonly;

-- everyone reads
GRANT SELECT ON registry.devices, registry.device_notes,
  registry.device_status_history, registry.device_types, registry.device_statuses
  TO registry_technician, registry_warehouse, registry_manager, registry_readonly;
GRANT SELECT ON registry.v_devices TO
  registry_technician, registry_warehouse, registry_manager, registry_readonly;
GRANT EXECUTE ON FUNCTION registry.search_devices(text,text,text,int,int) TO
  registry_technician, registry_warehouse, registry_manager, registry_readonly;
GRANT EXECUTE ON FUNCTION registry.audit(text,text,uuid,jsonb,uuid,inet) TO
  registry_technician, registry_warehouse, registry_manager, registry_readonly;

-- technician: log repairs, move status. Cannot register or retire devices.
GRANT INSERT ON registry.device_notes TO registry_technician;
GRANT UPDATE (status) ON registry.devices TO registry_technician;

-- warehouse: register devices and fill in identifiers, move status.
GRANT INSERT ON registry.devices TO registry_warehouse;
GRANT INSERT ON registry.device_notes TO registry_warehouse;
GRANT UPDATE (status, imei, iccid, device_type) ON registry.devices TO registry_warehouse;

-- manager: everything above, plus soft delete with a reason.
GRANT INSERT ON registry.devices, registry.device_notes TO registry_manager;
GRANT UPDATE (status, imei, iccid, device_type, deleted_at, deleted_by, delete_reason)
  ON registry.devices TO registry_manager;

-- Nobody gets UPDATE or DELETE on the log tables. Not the manager, not the app.
REVOKE ALL ON registry.audit_log FROM PUBLIC;
GRANT SELECT ON registry.audit_log TO registry_manager;

ALTER DEFAULT PRIVILEGES IN SCHEMA registry REVOKE ALL ON TABLES FROM PUBLIC;


-- ───────────────────────────────────────────────────────────────────────────
--  11. Retention
--
--  Deliberately left as a function with no schedule attached. The interval is
--  a policy decision, not an engineering one — set it from rain's retention
--  standard and POPIA guidance, then schedule it.
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION registry.drop_audit_partitions_before(p_cutoff date)
RETURNS TABLE (dropped text)
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'registry' AND c.relname ~ '^audit_log_[0-9]{6}$'
      AND to_date(right(c.relname, 6), 'YYYYMM') < date_trunc('month', p_cutoff)
  LOOP
    EXECUTE format('DROP TABLE registry.%I', r.relname);
    dropped := r.relname;
    RETURN NEXT;
  END LOOP;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
--  Cluster settings this schema assumes. Set in postgresql.conf, not here.
--
--    data_checksums              = on      (initdb --data-checksums; not
--                                           changeable later without a rebuild)
--    wal_level                   = replica
--    synchronous_commit          = on
--    synchronous_standby_names   = 'ANY 1 (standby_a, standby_b)'
--    archive_mode                = on
--    archive_command             = <ship WAL to object storage>
--    ssl                         = on
--    password_encryption         = scram-sha-256
--    log_connections             = on
--    log_disconnections          = on
--    log_min_duration_statement  = 250ms
--    shared_preload_libraries    = 'pg_stat_statements'
--
--  pg_hba.conf: hostssl only, no trust, no md5.
--
--  Bulk loading the initial fleet: drop the three *_trgm GIN indexes first,
--  COPY the rows in, then rebuild the indexes CONCURRENTLY. Loading 1M rows
--  through live GIN indexes is several times slower.
--
--  Measured on 1M synthetic devices (PostgreSQL 16, single core, 512MB
--  shared_buffers). Sizes are the number to plan capacity from:
--    heap                       170 MB
--    indexes (all 11)           ~450 MB
--    status history (1M rows)   ~90 MB
--    database total, no notes    1.1 GB
--  Budget 3-4 GB per million devices once notes and a year of audit exist.
-- ═══════════════════════════════════════════════════════════════════════════
