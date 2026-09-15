#!/usr/bin/env bash
#
# Back up Trippy's SQLite database.
#
# The database runs in WAL mode, so at any instant the committed state is split
# between app.db and its app.db-wal sibling (app.db-shm is a coordination file).
# A naive "cp app.db" while the service is running therefore captures a
# torn, half-written database. There are two correct ways to handle that, and
# this script uses the safe online one by default:
#
#   1. PREFERRED (default): sqlite3 ".backup". This uses SQLite's online backup
#      API, which produces a single, internally consistent app.db that already
#      folds in everything committed to the WAL. It is safe to run against a
#      live writer, and the output stands alone: it needs no -wal/-shm sibling.
#
#   2. FALLBACK (--raw, or when sqlite3 is missing): a plain file copy. This is
#      only consistent if it copies ALL THREE files together - app.db,
#      app.db-wal and app.db-shm - because the committed state lives across
#      them. Copying app.db alone loses whatever is still in the WAL. This is a
#      lesson learned the hard way; do not shortcut it.
#
# Usage:
#   sudo bash /opt/trippy/deploy/backup.sh [DEST_DIR] [--raw]
#
# DEST_DIR defaults to /var/backups/trippy. Backups are timestamped.
#
set -euo pipefail

DATA_DIR="/var/lib/trippy"
DB="${TRIPPY_DB:-${DATA_DIR}/app.db}"
DEST_DIR="/var/backups/trippy"
MODE="online"

# Args, in any order: a --raw flag and/or a destination directory.
for arg in "$@"; do
  if [[ "$arg" == "--raw" ]]; then
    MODE="raw"
  else
    DEST_DIR="$arg"
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$DB" ]]; then
  echo "No database at ${DB}. Set TRIPPY_DB or pass the right path." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

if [[ "$MODE" == "online" ]] && command -v sqlite3 >/dev/null 2>&1; then
  OUT="${DEST_DIR}/app-${STAMP}.db"
  echo "==> Online backup (sqlite3 .backup) -> ${OUT}"
  # .backup is safe while the service is writing and yields a standalone file.
  sqlite3 "$DB" ".backup '${OUT}'"
  # Prove the snapshot is readable and not corrupt before trusting it.
  if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
    echo "Integrity check FAILED on ${OUT}. Keeping it for inspection but treat it as suspect." >&2
    exit 1
  fi
  gzip -f "$OUT"
  echo "==> Done: ${OUT}.gz (integrity check ok)"
else
  if [[ "$MODE" == "online" ]]; then
    echo "sqlite3 not found; falling back to a raw file copy of all WAL siblings." >&2
  fi
  OUT_DIR="${DEST_DIR}/raw-${STAMP}"
  echo "==> Raw copy (app.db + -wal + -shm) -> ${OUT_DIR}"
  mkdir -p "$OUT_DIR"
  # Copy every sibling that exists. All three matter in WAL mode.
  for suffix in "" "-wal" "-shm"; do
    [[ -f "${DB}${suffix}" ]] && cp -p "${DB}${suffix}" "${OUT_DIR}/"
  done
  echo "==> Done: ${OUT_DIR}"
  echo "    Note: a raw copy is only guaranteed consistent if taken with the"
  echo "    service stopped. For a hot backup, prefer the default sqlite3 mode."
fi

cat <<'EOF'

Restore procedure
-----------------
  sudo systemctl stop trippy

  # From an online (.backup) snapshot - restores a single standalone file.
  # Remove any stale WAL siblings first so SQLite does not replay them onto the
  # restored file.
  sudo rm -f /var/lib/trippy/app.db /var/lib/trippy/app.db-wal /var/lib/trippy/app.db-shm
  sudo sh -c 'gunzip -c /var/backups/trippy/app-YYYYMMDD-HHMMSS.db.gz > /var/lib/trippy/app.db'

  # OR from a raw copy - restore all three files together.
  # sudo cp /var/backups/trippy/raw-YYYYMMDD-HHMMSS/app.db*  /var/lib/trippy/

  sudo chown trippy:trippy /var/lib/trippy/app.db*
  sudo systemctl start trippy

Scheduling
----------
  Add a daily cron entry (root crontab: sudo crontab -e):
    15 4 * * *  /opt/trippy/deploy/backup.sh >/var/log/trippy-backup.log 2>&1
  For off-box durability, sync DEST_DIR to S3 (aws s3 sync) or rely on a
  scheduled EBS snapshot policy on the data volume. Keep whichever you choose
  in a different failure domain than the instance.
EOF
