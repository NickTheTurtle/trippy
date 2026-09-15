#!/usr/bin/env bash
#
# Restore Trippy's SQLite database, safely.
#
# A backup you have never restored is not a backup. This script is the tested
# path back, for both durability layers:
#
#   1. Litestream (continuous S3 replication). Restores the latest state, or any
#      point in time within the retention window with --timestamp.
#   2. A gzipped snapshot written by backup.sh (local or pulled back from S3).
#
# It is built to be hard to misuse:
#   - It restores to a TEMPORARY file first and integrity-checks it there. The
#     live database is only touched once the restored copy is proven good.
#   - It never overwrites the live database without an explicit --yes (or an
#     interactive "yes"), and it moves the current database aside first rather
#     than deleting it.
#   - It stops trippy.service before swapping and restarts it after, and fixes
#     ownership back to the service user.
#   - With --output it restores to a scratch path and touches nothing else, so
#     you can rehearse a restore against production data without risk. Use this
#     for the recovery drill (see deploy/README.md).
#
# Usage:
#   sudo bash /opt/trippy/deploy/restore.sh --from-litestream [--timestamp TS] [--yes]
#   sudo bash /opt/trippy/deploy/restore.sh --from-snapshot FILE.db.gz [--yes]
#   sudo bash /opt/trippy/deploy/restore.sh --from-litestream --output /tmp/drill.db
#
#   --from-litestream        Restore from the S3 replica via `litestream restore`.
#   --from-snapshot FILE     Restore from a gzipped (or plain) .db snapshot.
#   --timestamp TS           Point-in-time target, RFC3339 e.g. 2026-09-15T04:00:00Z
#                            (Litestream only). Restores the state as of that time.
#   --output PATH            Non-destructive: restore to PATH, verify, and stop.
#                            Does not stop the service or replace the live db.
#   --yes                    Skip the interactive confirmation (for the swap).
#
set -euo pipefail

DATA_DIR="/var/lib/trippy"
DB="${TRIPPY_DB:-${DATA_DIR}/app.db}"
APP_USER="trippy"
SERVICE="trippy.service"
LITESTREAM_YML="/etc/litestream.yml"
LITESTREAM_ENV="/etc/litestream.env"

SOURCE=""
SNAPSHOT=""
TIMESTAMP=""
OUTPUT=""
ASSUME_YES="no"

die() { echo "Error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-litestream) SOURCE="litestream" ;;
    --from-snapshot)   SOURCE="snapshot"; SNAPSHOT="${2:-}"; shift ;;
    --timestamp)       TIMESTAMP="${2:-}"; shift ;;
    --output)          OUTPUT="${2:-}"; shift ;;
    --yes|-y)          ASSUME_YES="yes" ;;
    -h|--help)         sed -n '2,40p' "$0"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "Run as root (sudo bash ${0})."
[[ -n "$SOURCE" ]] || die "Choose a source: --from-litestream or --from-snapshot FILE."
if [[ "$SOURCE" == "snapshot" ]]; then
  [[ -n "$SNAPSHOT" ]] || die "--from-snapshot needs a file path."
  [[ -f "$SNAPSHOT" ]] || die "Snapshot not found: ${SNAPSHOT}"
fi
if [[ -n "$TIMESTAMP" && "$SOURCE" != "litestream" ]]; then
  die "--timestamp only applies to --from-litestream."
fi

# ---- integrity + row-count helpers (sqlite3 if present, else node:sqlite) ---
db_integrity() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$1" 'PRAGMA integrity_check;'
  else
    node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);for(const r of d.prepare("PRAGMA integrity_check").all())console.log(Object.values(r)[0]);d.close();' "$1"
  fi
}

db_rowcounts() {
  if command -v sqlite3 >/dev/null 2>&1; then
    local t
    while IFS= read -r t; do
      [[ -z "$t" ]] && continue
      printf '    %-28s %s\n' "$t" "$(sqlite3 "$1" "SELECT count(*) FROM \"${t}\";")"
    done < <(sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  else
    node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);const ts=d.prepare("SELECT name FROM sqlite_master WHERE type=\x27table\x27 AND name NOT LIKE \x27sqlite_%\x27 ORDER BY name").all();for(const {name} of ts){const n=d.prepare(`SELECT count(*) c FROM "${name}"`).get().c;console.log("    "+name.padEnd(28)+" "+n);}d.close();' "$1"
  fi
}

# ---- work on a temp file on the SAME filesystem as the target --------------
# Same filesystem so the final move into place is an atomic rename, and so we
# fail early (here, not mid-swap) if the disk is full.
if [[ -n "$OUTPUT" ]]; then
  TARGET="$OUTPUT"
  WORK_DIR="$(dirname "$OUTPUT")"
  mkdir -p "$WORK_DIR"
else
  TARGET="$DB"
  WORK_DIR="$DATA_DIR"
fi
TMP="$(mktemp "${WORK_DIR}/.restore-XXXXXX.db")"
cleanup() { rm -f "$TMP" "${TMP}-wal" "${TMP}-shm"; }
trap cleanup EXIT

# ---- announce the plan -----------------------------------------------------
echo "About to restore Trippy's database:"
if [[ "$SOURCE" == "litestream" ]]; then
  echo "    source:     Litestream replica (via ${LITESTREAM_YML})"
  echo "    origin db:  ${DB}"
  [[ -n "$TIMESTAMP" ]] && echo "    timestamp:  ${TIMESTAMP} (point-in-time)" || echo "    timestamp:  latest"
else
  echo "    source:     snapshot ${SNAPSHOT}"
fi
if [[ -n "$OUTPUT" ]]; then
  echo "    mode:       NON-DESTRUCTIVE drill -> ${TARGET}"
  echo "    service:    left running, live database untouched"
else
  echo "    mode:       REPLACE the live database at ${TARGET}"
  echo "    service:    ${SERVICE} will be stopped, swapped, and restarted"
  if [[ -f "$TARGET" ]]; then
    echo "    current db: exists; it will be moved aside to ${TARGET}.pre-restore-<stamp> (not deleted)"
  fi
fi
echo

if [[ "$ASSUME_YES" != "yes" ]]; then
  read -r -p "Type 'yes' to proceed: " reply
  [[ "$reply" == "yes" ]] || die "Aborted."
fi

# ---- produce the restored copy at $TMP -------------------------------------
if [[ "$SOURCE" == "litestream" ]]; then
  command -v litestream >/dev/null 2>&1 || die "litestream is not installed."
  [[ -f "$LITESTREAM_YML" ]] || die "Missing ${LITESTREAM_YML}."
  # Litestream needs the bucket/region/credentials from the environment.
  # shellcheck disable=SC1090
  [[ -f "$LITESTREAM_ENV" ]] && set -a && . "$LITESTREAM_ENV" && set +a
  echo "==> Restoring from Litestream"
  ts_args=()
  [[ -n "$TIMESTAMP" ]] && ts_args=(-timestamp "$TIMESTAMP")
  litestream restore -config "$LITESTREAM_YML" -o "$TMP" "${ts_args[@]}" "$DB"
else
  echo "==> Expanding snapshot ${SNAPSHOT}"
  case "$SNAPSHOT" in
    *.gz) gunzip -c "$SNAPSHOT" > "$TMP" ;;
    *)    cp -p "$SNAPSHOT" "$TMP" ;;
  esac
fi

# ---- verify BEFORE touching anything live ----------------------------------
echo "==> Integrity check"
if ! db_integrity "$TMP" | grep -q '^ok$'; then
  die "Integrity check FAILED on the restored copy. Nothing was changed."
fi
echo "    ok"
echo "==> Row counts in the restored copy:"
db_rowcounts "$TMP"

# ---- drill mode stops here -------------------------------------------------
if [[ -n "$OUTPUT" ]]; then
  mv -f "$TMP" "$TARGET"
  trap - EXIT
  echo
  echo "==> Drill restore written to ${TARGET} (verified). Live database untouched."
  echo "    Delete it when done:  rm -f ${TARGET}"
  exit 0
fi

# ---- swap into place -------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
echo "==> Stopping ${SERVICE}"
systemctl stop "$SERVICE" 2>/dev/null || echo "    (service was not running)"

if [[ -f "$TARGET" ]]; then
  echo "==> Moving current database aside to ${TARGET}.pre-restore-${STAMP}"
  mv -f "$TARGET" "${TARGET}.pre-restore-${STAMP}"
  # Stale WAL siblings must not be replayed onto the restored file.
  for suffix in "-wal" "-shm"; do
    [[ -f "${TARGET}${suffix}" ]] && mv -f "${TARGET}${suffix}" "${TARGET}${suffix}.pre-restore-${STAMP}"
  done
fi

echo "==> Installing restored database at ${TARGET}"
mv -f "$TMP" "$TARGET"
trap - EXIT
chown "${APP_USER}:${APP_USER}" "$TARGET"

echo "==> Starting ${SERVICE}"
systemctl start "$SERVICE"

echo
echo "==> Restore complete."
echo "    Restored:  ${TARGET}"
[[ -f "${TARGET}.pre-restore-${STAMP}" ]] && \
  echo "    Previous:  ${TARGET}.pre-restore-${STAMP} (delete once you trust the restore)"
echo "    Verify:    curl -s http://127.0.0.1:5175/api/health"
