#!/usr/bin/env bash
#
# Trippy resource + backup-freshness monitor. Run on a systemd timer.
#
# This does not page anyone by itself (a single box cannot reliably alert about
# its own death). It logs to the journal, optionally posts to a webhook, and
# exits non-zero on a problem so `systemctl --failed` and the timer's status
# surface it. The human-paging layer is the external uptime check and, for
# backups, the dead-man's-switch ping wired into backup.sh. See deploy/README.md.
#
# Checks:
#   1. Disk usage on the data and backup filesystems (SQLite + WAL + snapshots +
#      journald share the 20 GiB volume; a full disk corrupts writes).
#   2. Litestream is still running, if it is installed (it can stop silently).
#   3. Backup freshness: the newest local snapshot, and the newest replicated S3
#      object when a bucket and the AWS CLI are available.
#
# Env (all optional, usually from /etc/trippy-monitor.env and /etc/litestream.env):
#   DISK_WARN_PCT (80) DISK_CRIT_PCT (90)
#   BACKUP_MAX_AGE_HOURS (26)          local snapshot staleness threshold
#   LITESTREAM_MAX_AGE_MINUTES (60)    replicated-object staleness threshold
#   ALERT_WEBHOOK_URL                  POSTed a one-line message on WARN/CRIT
#   LITESTREAM_S3_BUCKET / _PREFIX / _REGION
#
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/trippy}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/trippy}"
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-90}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
LITESTREAM_MAX_AGE_MINUTES="${LITESTREAM_MAX_AGE_MINUTES:-60}"
S3_BUCKET="${LITESTREAM_S3_BUCKET:-}"
S3_PREFIX="${LITESTREAM_S3_PREFIX:-trippy/app.db}"
S3_REGION="${LITESTREAM_S3_REGION:-}"

worst=0   # 0 ok, 1 warn, 2 crit
problems=()

note() {  # $1 = severity (WARN|CRIT), rest = message
  local sev="$1"; shift
  local msg="$*"
  problems+=("${sev}: ${msg}")
  logger -t trippy-monitor -- "${sev}: ${msg}" 2>/dev/null || true
  echo "${sev}: ${msg}"
  case "$sev" in
    CRIT) worst=2 ;;
    WARN) if [[ "$worst" -lt 1 ]]; then worst=1; fi ;;
  esac
}

disk_pct() {  # used percentage (integer) for the filesystem holding $1
  df -P "$1" 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $5 }'
}

check_disk() {
  local path="$1" pct
  [[ -e "$path" ]] || return 0
  pct="$(disk_pct "$path")"
  [[ -n "$pct" ]] || return 0
  if   [[ "$pct" -ge "$DISK_CRIT_PCT" ]]; then note CRIT "disk ${pct}% full on the filesystem holding ${path} (>= ${DISK_CRIT_PCT}%)"
  elif [[ "$pct" -ge "$DISK_WARN_PCT" ]]; then note WARN "disk ${pct}% full on the filesystem holding ${path} (>= ${DISK_WARN_PCT}%)"
  else echo "ok: disk ${pct}% on ${path}"
  fi
}

check_disk "$DATA_DIR"
# Only check the backup filesystem separately if it exists and differs.
if [[ -d "$BACKUP_DIR" ]]; then check_disk "$BACKUP_DIR"; fi

# ---- Litestream still running? ---------------------------------------------
if systemctl list-unit-files litestream.service >/dev/null 2>&1 \
   && systemctl is-enabled --quiet litestream 2>/dev/null; then
  if systemctl is-active --quiet litestream; then
    echo "ok: litestream.service active"
  else
    note CRIT "litestream.service is enabled but not active; S3 replication has stopped"
  fi
fi

# ---- local snapshot freshness ----------------------------------------------
if [[ -d "$BACKUP_DIR" ]]; then
  newest="$(find "$BACKUP_DIR" -maxdepth 1 -name 'app-*.db.gz' -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)"
  if [[ -z "$newest" ]]; then
    note WARN "no local snapshot (app-*.db.gz) found in ${BACKUP_DIR}"
  else
    age_h=$(( ( $(date +%s) - ${newest%.*} ) / 3600 ))
    if [[ "$age_h" -gt "$BACKUP_MAX_AGE_HOURS" ]]; then
      note WARN "newest local snapshot is ${age_h}h old (> ${BACKUP_MAX_AGE_HOURS}h); the daily backup may not be running"
    else
      echo "ok: newest local snapshot ${age_h}h old"
    fi
  fi
fi

# ---- replicated-object freshness (best effort) -----------------------------
if [[ -n "$S3_BUCKET" ]] && command -v aws >/dev/null 2>&1; then
  region_args=()
  [[ -n "$S3_REGION" ]] && region_args=(--region "$S3_REGION")
  line="$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive "${region_args[@]}" 2>/dev/null | sort | tail -1 || true)"
  if [[ -z "$line" ]]; then
    note WARN "no objects under s3://${S3_BUCKET}/${S3_PREFIX}/; Litestream may never have replicated"
  else
    # `aws s3 ls` prints: YYYY-MM-DD HH:MM:SS  <size>  <key>
    obj_epoch="$(date -d "$(echo "$line" | awk '{print $1" "$2}')" +%s 2>/dev/null || echo 0)"
    if [[ "$obj_epoch" -gt 0 ]]; then
      age_m=$(( ( $(date +%s) - obj_epoch ) / 60 ))
      if [[ "$age_m" -gt "$LITESTREAM_MAX_AGE_MINUTES" ]]; then
        note CRIT "newest replicated S3 object is ${age_m}m old (> ${LITESTREAM_MAX_AGE_MINUTES}m); replication looks stalled"
      else
        echo "ok: newest replicated S3 object ${age_m}m old"
      fi
    fi
  fi
fi

# ---- optional webhook ------------------------------------------------------
if [[ "$worst" -ge 1 && -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  host="$(hostname 2>/dev/null || echo trippy)"
  summary="trippy-monitor on ${host}: $(printf '%s; ' "${problems[@]}")"
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":"%s"}' "${summary//\"/\\\"}")" \
    "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || echo "warn: alert webhook POST failed (non-fatal)"
fi

if [[ "$worst" -ge 2 ]]; then exit 2; fi
if [[ "$worst" -ge 1 ]]; then exit 1; fi
echo "all checks ok"
exit 0
