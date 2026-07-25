-- ═══════════════════════════════════════════════════════════════════════════
--  002 — note search: replace trigram with full text
--
--  Measured at 200,000 notes on PostgreSQL 16:
--
--    device_notes_body_trgm (GIN trigram)   214 MB
--    to_tsvector('english', body) (GIN)       3 MB
--
--  Seventy times the size for the wrong capability. Trigram is the right
--  index for identifier substrings — short, fixed-format, and searched by
--  fragment, which is exactly how a technician reads six digits off a SIM.
--  It is the wrong index for prose: an 80-character sentence yields ~78
--  trigrams, almost all of them common English sequences with long posting
--  lists. Extrapolated to 2M notes that index alone was heading for ~2GB.
--
--  Worse, nothing used it. search_devices() never touched note bodies, so the
--  index was pure write amplification and disk. This migration drops it, adds
--  full-text search, and exposes the capability so the index is earned.
--
--  Behaviour change worth knowing: full text matches whole words with
--  stemming, so 'antenna' finds 'antennas' but 'anten' finds nothing.
--  For prose that is the better trade. Identifier search is unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = registry, public;

-- ── Swap the index ─────────────────────────────────────────────────────────
-- CONCURRENTLY cannot run inside a transaction. On a live cluster with a
-- populated notes table, run these two statements outside this migration
-- instead; at that point the drop is instant and the create is the slow half.
DROP INDEX IF EXISTS registry.device_notes_body_trgm;

CREATE INDEX device_notes_body_fts ON registry.device_notes
  USING gin (to_tsvector('english', body));

COMMENT ON INDEX registry.device_notes_body_fts IS
  'Word search over repair notes. Deliberately not trigram: see migration 002.';


-- ── Expose it ──────────────────────────────────────────────────────────────
--  The workflow this serves: a manager suspecting a batch fault wants every
--  device whose history mentions a symptom, not one device by serial. Returns
--  devices, not notes, because the device is the unit of action.
CREATE FUNCTION registry.search_notes(
  p_terms  text,
  p_type   text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
) RETURNS TABLE (
  device_id   uuid,
  serial      text,
  device_type text,
  status      text,
  note_hits   bigint,
  last_hit_at timestamptz,
  excerpt     text
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  q tsquery;
BEGIN
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 500);

  -- websearch_to_tsquery tolerates whatever a person types: bare words,
  -- "quoted phrases", or-separated alternatives, leading minus to exclude.
  -- plainto_tsquery would choke on the punctuation; raw to_tsquery would
  -- raise a syntax error and hand the user a stack trace.
  q := websearch_to_tsquery('english', coalesce(p_terms, ''));
  IF q IS NULL OR numnode(q) = 0 THEN
    RETURN;                      -- nothing searchable; do not scan the table
  END IF;

  RETURN QUERY
  WITH hit AS (
    SELECT n.device_id AS did,
           count(*)          AS hits,
           max(n.created_at) AS last_at,
           (array_agg(left(n.body, 160) ORDER BY n.created_at DESC))[1] AS snippet
    FROM registry.device_notes n
    WHERE to_tsvector('english', n.body) @@ q
    GROUP BY n.device_id
  )
  SELECT v.id, v.serial, v.device_type, v.status,
         hit.hits, hit.last_at, hit.snippet
  FROM hit
  JOIN registry.v_devices v ON v.id = hit.did
  WHERE (p_type   IS NULL OR v.device_type = p_type)
    AND (p_status IS NULL OR v.status      = p_status)
  ORDER BY hit.last_at DESC, v.serial
  LIMIT p_limit OFFSET p_offset;
END $$;

COMMENT ON FUNCTION registry.search_notes IS
  'Find devices whose repair history mentions given terms. Accepts what a person types, including quoted phrases and -exclusions, via websearch_to_tsquery.';

GRANT EXECUTE ON FUNCTION registry.search_notes(text,text,text,int,int) TO
  registry_technician, registry_warehouse, registry_manager, registry_readonly;

COMMIT;
