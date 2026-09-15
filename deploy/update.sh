#!/usr/bin/env bash
#
# Pull the latest code and redeploy Trippy on an EC2 box set up by ec2-setup.sh.
# The repo is public, so no token is needed. If the repo has been made private
# again (or you deploy a private fork), pass a token:
#
#   export GITHUB_TOKEN='github_pat_...'   # optional; only for a private repo
#   sudo -E bash /opt/trippy/deploy/update.sh
#
# This rebuilds the web client and restarts the API. It does NOT touch
# /etc/trippy.env, /var/lib/trippy, or the Caddyfile.
#
# Ordering matters. Everything slow (fetch, install, build) happens FIRST,
# while the old bundle is still being served and the old API is still running.
# Only the last two steps are user-visible: an atomic web-bundle swap (no blip),
# then the API restart (a short blip, see below). If the build fails, nothing
# user-visible has changed.
#
# Expected downtime per deploy:
#   - Web client (static): none. The bundle is swapped by an atomic symlink flip.
#   - API (/api/*): a few seconds while the process restarts (tsx cold start).
#     During that window Caddy returns 502 for /api; the page itself keeps
#     loading. Run deploys when a brief API blip is acceptable.
#
set -euo pipefail

# Never let git block on an interactive credential prompt (see ec2-setup.sh).
# A failure to reach the remote must be a fast, clean error, not a hang.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

APP_DIR="/opt/trippy"
DATA_DIR="/var/lib/trippy"
APP_USER="trippy"
GIT_REF="${GIT_REF:-main}"
WEB_DIST="${APP_DIR}/apps/web/dist"
WEB_ROOT="/var/www/trippy"
WEB_CURRENT="${WEB_ROOT}/current"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo -E bash ${APP_DIR}/deploy/update.sh)" >&2
  exit 1
fi

REPO_URL="$(git -C "$APP_DIR" remote get-url origin)"
# GITHUB_TOKEN is optional (public repo). When set, inject it into the network
# URL only; the stored remote is scrubbed back to the clean URL afterwards.
CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

# ---- slow work first (nothing user-visible changes here) -------------------
echo "==> Fetching latest ${GIT_REF}"
git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
git -C "$APP_DIR" fetch --depth 1 origin "$GIT_REF"
git -C "$APP_DIR" reset --hard "origin/${GIT_REF}"
git -C "$APP_DIR" remote set-url origin "$REPO_URL"   # scrub token

echo "==> Installing and rebuilding (full install; tsx is a runtime dependency)"
cd "$APP_DIR"
npm ci
npm run build

if [[ ! -f "${WEB_DIST}/index.html" ]]; then
  echo "Build did not produce ${WEB_DIST}/index.html - nothing swapped, nothing restarted." >&2
  exit 1
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

# ---- user-visible swap last ------------------------------------------------
# Atomic: Caddy keeps serving the previous release until the symlink flips to the
# fully-copied new one, so there is no window where a half-written bundle shows.
echo "==> Publishing the new web bundle (atomic swap)"
WEB_ROOT="$WEB_ROOT" bash "${APP_DIR}/deploy/publish-web.sh" "$WEB_DIST"

echo "==> Restarting the API (brief /api blip)"
systemctl restart trippy

# Litestream, if installed, replicates the database FILE and runs as its own
# service. A redeploy only restarts the API; it does not move or replace the
# database. So we must NOT stop Litestream here - stopping it would open a gap in
# the continuous replication precisely across the deploy. Leave it running and
# only make sure it did not die (and pick up any config change on disk).
if systemctl list-unit-files litestream.service >/dev/null 2>&1 \
   && systemctl is-enabled --quiet litestream 2>/dev/null; then
  systemctl is-active --quiet litestream || systemctl start litestream
  echo "==> Litestream is $(systemctl is-active litestream)"
fi

echo "==> Done. Logs: sudo journalctl -u trippy -f"
echo "    Roll back the web bundle without a rebuild:"
echo "      sudo bash ${APP_DIR}/deploy/publish-web.sh --rollback"
echo "    Roll back code + rebuild: re-run with GIT_REF=<older-sha>."
