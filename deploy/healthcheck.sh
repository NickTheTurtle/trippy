#!/usr/bin/env bash
#
# Local watchdog for the Trippy API. Run on a short systemd timer.
#
# systemd's Restart=on-failure already handles a process that CRASHES. This
# covers the other failure: a process that is still alive but has stopped
# serving (event-loop wedged, deadlocked, stuck on a bad connection). We curl
# the health endpoint the app already exposes and, after a few CONSECUTIVE
# failures, restart the service.
#
# What this catches: a hung/wedged API on this box that no longer answers
# /api/health on loopback.
# What it does NOT catch: Caddy or TLS problems, DNS, a full disk, or the whole
# box being gone. Those are the external uptime check's job (see deploy/README.md).
# We deliberately hit the API directly on loopback, not through Caddy, so this
# watchdog reacts to the API alone and does not restart it for a Caddy fault.
#
set -euo pipefail

PORT="${PORT:-5175}"
URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
SERVICE="${TRIPPY_SERVICE:-trippy.service}"
THRESHOLD="${HEALTH_FAIL_THRESHOLD:-3}"
# /run is tmpfs: the counter resets on reboot, which is what we want.
STATE="${HEALTH_STATE_FILE:-/run/trippy-health.fails}"

log() { logger -t trippy-health -- "$*" 2>/dev/null || true; echo "$*"; }

body="$(curl -fsS --max-time 5 "$URL" 2>/dev/null || true)"
if printf '%s' "$body" | grep -q '"ok":true'; then
  rm -f "$STATE"
  exit 0
fi

fails=0
[[ -f "$STATE" ]] && fails="$(cat "$STATE" 2>/dev/null || echo 0)"
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
fails=$((fails + 1))
echo "$fails" > "$STATE"
log "health check failed (${fails}/${THRESHOLD}) at ${URL}"

if [[ "$fails" -ge "$THRESHOLD" ]]; then
  log "restarting ${SERVICE} after ${fails} consecutive failed health checks"
  systemctl restart "$SERVICE" || log "restart of ${SERVICE} failed"
  rm -f "$STATE"
fi
exit 0
