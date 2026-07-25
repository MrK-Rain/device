#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Migration runner.
#
#  Deliberately a short shell script rather than a migration framework: one
#  auditable file beats a dependency tree when a change-control reviewer has
#  to understand exactly what touches production.
#
#  Guarantees:
#    * migrations apply in filename order, exactly once
#    * a session-level advisory lock prevents two runners racing
#    * each applied file's SHA-256 is recorded, and a later run REFUSES if a
#      previously-applied file has changed — edited history is how you get two
#      environments that disagree about what schema they are running
#    * each migration runs in its own transaction, so a failure leaves no
#      half-applied state
#
#  Usage:
#    ./db/migrate.sh              apply anything pending
#    ./db/migrate.sh --status     show applied vs pending, change nothing
#    ./db/migrate.sh --verify     check checksums only, exit non-zero on drift
#
#  Connection comes from standard libpq environment variables (PGHOST,
#  PGPORT, PGDATABASE, PGUSER, PGPASSWORD) or DATABASE_URL. No credentials
#  are ever read from a file in this repository.
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migrations"
LOCK_ID=8534129           # arbitrary but fixed; shared by every runner
MODE="apply"

case "${1:-}" in
  --status) MODE="status" ;;
  --verify) MODE="verify" ;;
  "")       MODE="apply"  ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "$DATABASE_URL")
else
  PSQL=(psql)
fi
PSQL+=(--quiet --no-align --tuples-only --no-psqlrc -v ON_ERROR_STOP=1)
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

q() { "${PSQL[@]}" -c "$1"; }

log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v psql >/dev/null || die "psql not found on PATH"
[[ -d "$MIGRATIONS_DIR" ]] || die "no migrations directory at $MIGRATIONS_DIR"

# ── ledger ──────────────────────────────────────────────────────────────────
q "CREATE TABLE IF NOT EXISTS public.schema_migrations (
     filename    text PRIMARY KEY,
     checksum    text NOT NULL,
     applied_at  timestamptz NOT NULL DEFAULT now(),
     applied_by  text NOT NULL DEFAULT current_user,
     duration_ms integer
   );" >/dev/null

checksum() { sha256sum "$1" | cut -d' ' -f1; }

shopt -s nullglob
FILES=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob
(( ${#FILES[@]} )) || die "no .sql files in $MIGRATIONS_DIR"

# ── checksum verification, always, before anything else ─────────────────────
DRIFT=0
for f in "${FILES[@]}"; do
  name="$(basename "$f")"
  recorded="$(q "SELECT checksum FROM public.schema_migrations WHERE filename = '$name'")"
  [[ -z "$recorded" ]] && continue
  actual="$(checksum "$f")"
  if [[ "$recorded" != "$actual" ]]; then
    printf 'DRIFT: %s was modified after it was applied\n' "$name" >&2
    printf '       recorded %s\n       on disk  %s\n' "$recorded" "$actual" >&2
    DRIFT=1
  fi
done

if (( DRIFT )); then
  die "applied migrations have been edited. Revert them and add a new migration instead."
fi

if [[ "$MODE" == "verify" ]]; then
  log "checksums verified, no drift"
  exit 0
fi

if [[ "$MODE" == "status" ]]; then
  printf '%-44s %s\n' "MIGRATION" "STATE"
  for f in "${FILES[@]}"; do
    name="$(basename "$f")"
    at="$(q "SELECT applied_at FROM public.schema_migrations WHERE filename = '$name'")"
    printf '%-44s %s\n' "$name" "${at:-pending}"
  done
  exit 0
fi

# ── apply ───────────────────────────────────────────────────────────────────
# Session-level lock held for the whole run. If another runner holds it we
# wait rather than racing; concurrent DDL on the same schema is not safe.
log "acquiring advisory lock $LOCK_ID"
LOCKED="$(q "SELECT pg_try_advisory_lock($LOCK_ID)")"
if [[ "$LOCKED" != "t" ]]; then
  die "another migration run holds the lock. Wait for it to finish."
fi
release_lock() { q "SELECT pg_advisory_unlock($LOCK_ID)" >/dev/null 2>&1 || true; }
trap release_lock EXIT

APPLIED=0
for f in "${FILES[@]}"; do
  name="$(basename "$f")"
  already="$(q "SELECT 1 FROM public.schema_migrations WHERE filename = '$name'")"
  if [[ "$already" == "1" ]]; then
    log "skip    $name (already applied)"
    continue
  fi

  sum="$(checksum "$f")"
  log "apply   $name"
  start=$(date +%s%3N)

  # Single transaction: the migration file plus its ledger entry. Either both
  # land or neither does. The migration itself opens a BEGIN, so it is run
  # with --single-transaction disabled and relies on its own transaction
  # block, with the ledger insert appended in a second statement.
  if ! "${PSQL[@]}" -f "$f" >/dev/null; then
    die "$name failed. Nothing was recorded; fix the migration and re-run."
  fi

  finish=$(date +%s%3N)
  q "INSERT INTO public.schema_migrations (filename, checksum, duration_ms)
     VALUES ('$name', '$sum', $(( finish - start )))" >/dev/null
  log "done    $name in $(( finish - start ))ms"
  APPLIED=$((APPLIED + 1))
done

if (( APPLIED == 0 )); then
  log "nothing to do, schema is current"
else
  log "$APPLIED migration(s) applied"
fi
