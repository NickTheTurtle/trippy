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
# This is the "belt" to Litestream's "braces": Litestream (see ec2-setup.sh)
# gives continuous, point-in-time S3 replication, and this gives a daily, whole,
# self-contained snapshot you can hand around and restore without any tooling.
# Keep both. If S3 is configured it also copies each snapshot off-box, and it
# prunes old local snapshots so the disk does not fill.
#
# Usage:
#   sudo bash /opt/trippy/deploy/backup.sh [DEST_DIR] [--raw]
#
# DEST_DIR defaults to /var/backups/trippy. Backups are timestamped.
#
# Off-box upload (optional) uses these, normally from /etc/litestream.env:
#   LITESTREAM_S3_BUCKET / LITESTREAM_S3_REGION / LITESTREAM_S3_PREFIX  (or the
#   BACKUP_S3_* overrides). Credentials come from the EC2 instance role, or from
#   LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY. The app's SES keys
#   are deliberately NOT used here: S3-write and SES-send are different jobs with
#   different least-privilege policies.
#   BACKUP_RETENTION_DAYS controls local pruning (default 14).
#
set -euo pipefail

DATA_DIR="/var/lib/trippy"
DB="${TRIPPY_DB:-${DATA_DIR}/app.db}"
DEST_DIR="/var/backups/trippy"
MODE="online"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# Off-box target. Reuse the Litestream S3 settings by default so the bucket is
# configured in one place; BACKUP_S3_* overrides if you want a different target.
S3_BUCKET="${BACKUP_S3_BUCKET:-${LITESTREAM_S3_BUCKET:-}}"
S3_REGION="${BACKUP_S3_REGION:-${LITESTREAM_S3_REGION:-}}"
S3_PREFIX="${BACKUP_S3_PREFIX:-${LITESTREAM_S3_PREFIX:-trippy/app.db}}"

upload_to_s3() {
  # $1 = local file to upload. No-op unless a bucket is configured.
  local file="$1"
  [[ -z "$S3_BUCKET" ]] && return 0
  if ! command -v aws >/dev/null 2>&1; then
    echo "    Off-box upload skipped: aws CLI not installed." >&2
    return 0
  fi
  local dest="s3://${S3_BUCKET}/${S3_PREFIX}/snapshots/$(basename "$file")"
  local region_args=()
  [[ -n "$S3_REGION" ]] && region_args=(--region "$S3_REGION")
  echo "==> Uploading snapshot to ${dest}"
  # Map the DEDICATED backup keys (if any) into the names the AWS CLI reads, for
  # this call only, so the app's SES keys never leak in as the backup identity.
  # With no keys set we fall through to the EC2 instance role.
  if [[ -n "${LITESTREAM_ACCESS_KEY_ID:-}" && -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]]; then
    AWS_ACCESS_KEY_ID="$LITESTREAM_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$LITESTREAM_SECRET_ACCESS_KEY" \
      aws s3 cp "$file" "$dest" "${region_args[@]}"
  else
    aws s3 cp "$file" "$dest" "${region_args[@]}"
  fi
}

prune_local() {
  echo "==> Pruning local backups older than ${BACKUP_RETENTION_DAYS} days in ${DEST_DIR}"
  find "$DEST_DIR" -maxdepth 1 -name 'app-*.db.gz' -type f -mtime +"$BACKUP_RETENTION_DAYS" -print -delete 2>/dev/null || true
  find "$DEST_DIR" -maxdepth 1 -name 'raw-*' -type d -mtime +"$BACKUP_RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
}

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
  upload_to_s3 "${OUT}.gz"
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
  echo "    Note: --raw copies are not uploaded off-box; use the default mode"
  echo "    for the S3 copy."
fi

prune_local

# Optional dead-man's-switch ping. On a successful run we ping a URL (for
# example a Healthchecks.io check). If backups stop running, the pings stop and
# that external service alerts a human. This is the freshness signal that
# matters: it catches "the backup silently stopped" before a restore is needed.
# No secret is stored by this script; the URL comes from the environment.
if [[ -n "${BACKUP_PING_URL:-}" ]]; then
  curl -fsS -m 10 "$BACKUP_PING_URL" >/dev/null 2>&1 \
    && echo "==> Pinged backup dead-man switch" \
    || echo "    backup dead-man ping failed (non-fatal)" >&2
fi

cat <<'EOF'

Restore procedure
-----------------
  The tested, safe path is deploy/restore.sh, which restores to a temp file,
  integrity-checks it, moves the current database aside, and swaps it in:

    sudo bash /opt/trippy/deploy/restore.sh --from-snapshot \
      /var/backups/trippy/app-YYYYMMDD-HHMMSS.db.gz

    # Or restore continuous replication (latest, or a point in time):
    sudo bash /opt/trippy/deploy/restore.sh --from-litestream
    sudo bash /opt/trippy/deploy/restore.sh --from-litestream \
      --timestamp 2026-09-15T04:00:00Z

  The manual equivalent, if you ever need it:

    sudo systemctl stop trippy
    sudo rm -f /var/lib/trippy/app.db /var/lib/trippy/app.db-wal /var/lib/trippy/app.db-shm
    sudo sh -c 'gunzip -c /var/backups/trippy/app-YYYYMMDD-HHMMSS.db.gz > /var/lib/trippy/app.db'
    # OR from a raw copy - restore all three files together:
    # sudo cp /var/backups/trippy/raw-YYYYMMDD-HHMMSS/app.db*  /var/lib/trippy/
    sudo chown trippy:trippy /var/lib/trippy/app.db*
    sudo systemctl start trippy

Scheduling
----------
  ec2-setup.sh installs a systemd timer (trippy-backup.timer) that runs this
  daily. Check it with:
    systemctl list-timers trippy-backup.timer
    journalctl -u trippy-backup.service

  Off-box durability: Litestream (litestream.service) already streams the WAL to
  S3 continuously. This snapshot is the second, independent layer; set the
  LITESTREAM_S3_* variables to copy each snapshot off-box too. Keep whatever you
  choose in a different failure domain than the instance. See the "Backups and
  recovery" section of deploy/README.md.
EOF
