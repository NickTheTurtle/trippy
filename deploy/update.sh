#!/usr/bin/env bash
#
# Pull the latest code and restart Trippy on an EC2 box set up by ec2-setup.sh.
# For the private repo, pass a token:
#
#   export GITHUB_TOKEN='github_pat_...'
#   sudo -E bash /opt/trippy/deploy/update.sh
#
# This rebuilds the web client and restarts the API. It does NOT touch
# /etc/trippy.env, /var/lib/trippy, or the Caddyfile.
#
set -euo pipefail

APP_DIR="/opt/trippy"
DATA_DIR="/var/lib/trippy"
APP_USER="trippy"
GIT_REF="${GIT_REF:-main}"
WEB_DIST="${APP_DIR}/apps/web/dist"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo -E bash ${APP_DIR}/deploy/update.sh)" >&2
  exit 1
fi

REPO_URL="$(git -C "$APP_DIR" remote get-url origin)"
CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

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
  echo "Build did not produce ${WEB_DIST}/index.html - not restarting." >&2
  exit 1
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

echo "==> Restarting service"
systemctl restart trippy
echo "==> Done. Logs: sudo journalctl -u trippy -f"
