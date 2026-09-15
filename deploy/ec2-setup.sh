#!/usr/bin/env bash
#
# Trippy - one-shot EC2 (Ubuntu 24.04) deployment.
#
# Trippy is an npm-workspaces monorepo with two deployables:
#   - apps/web  : a Vite-built static React client (served straight off disk)
#   - apps/api  : a long-lived Hono JSON API (Node process, run via tsx)
# and shared packages under packages/*. apps/mobile (Expo) is NOT deployed.
#
# This script installs Node + Caddy, checks the app out to /opt/trippy, builds
# the web client, runs the API as a hardened systemd service on 127.0.0.1:<port>,
# and puts Caddy in front for automatic HTTPS. Caddy serves the built web client
# as static files and reverse-proxies only /api to the API process, so the whole
# app is same-origin: no CORS, and the session cookie stays first-party.
#
# If you do not pass a DOMAIN we default to a free "<public-ip>.sslip.io"
# hostname, which still gets a real Let's Encrypt certificate.
#
# Usage (run as root, from a checkout of this repo so the script is present):
#
#   export GITHUB_TOKEN='github_pat_...'          # required to clone the private repo
#   # optional but recommended:
#   #   export DOMAIN='trippy.dxu.info'           # point its DNS A record at this box first
#   #   export ACME_EMAIL='you@example.com'       # Let's Encrypt expiry notices
#   # optional provider / mail secrets (any that are set are written to the env file):
#   #   export GOOGLE_PLACES_KEY='...'            # place search (else keyless OSM/Photon)
#   #   export GOOGLE_MAPS_KEY='...'              # maps JS + server-side routing
#   #   export MAIL_FROM='trips@trippy.dxu.info'  # turns on email verification
#   #   export AWS_ACCESS_KEY_ID='...' AWS_SECRET_ACCESS_KEY='...' SES_REGION='us-east-1'
#   #   export RESEND_API_KEY='...'               # used only if SES keys are absent
#   #   export TRIPPY_REGISTER_LIMIT='5'          # signups per IP before backoff
#   #   export GIT_REF='main'
#   sudo -E bash deploy/ec2-setup.sh
#
# sudo -E preserves your exported variables. The script never prints a secret and
# is idempotent: safe to re-run.
#
set -euo pipefail

# ---- config / params -------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/NickTheTurtle/trippy.git}"
GIT_REF="${GIT_REF:-main}"
APP_DIR="/opt/trippy"
DATA_DIR="/var/lib/trippy"
ENV_FILE="/etc/trippy.env"
APP_USER="trippy"
NODE_MAJOR="24"           # Node 24.x. node:sqlite needs >= 22.5; 24 is the LTS-track target.
PORT="${PORT:-5175}"
WEB_DIST="${APP_DIR}/apps/web/dist"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (use: sudo -E bash deploy/ec2-setup.sh)" >&2
  exit 1
fi

log() { echo -e "\n\033[1;36m==>\033[0m $*"; }

# ---- discover the public IP / domain --------------------------------------
log "Discovering public address"
# IMDSv2 first (works on EC2), then fall back to a public echo service.
PUBLIC_IP=""
TOKEN="$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)"
if [[ -n "$TOKEN" ]]; then
  PUBLIC_IP="$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
fi
[[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(curl -sf https://api.ipify.org 2>/dev/null || true)"
[[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(curl -sf https://ifconfig.me 2>/dev/null || true)"

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  if [[ -z "$PUBLIC_IP" ]]; then
    echo "Could not determine the public IP and no DOMAIN was provided." >&2
    exit 1
  fi
  DOMAIN="${PUBLIC_IP}.sslip.io"
fi
PUBLIC_URL="https://${DOMAIN}"
log "Using domain: ${DOMAIN}  (public IP: ${PUBLIC_IP:-unknown})"

# ---- swap ------------------------------------------------------------------
# Trippy builds six workspaces; the web client's Vite/Rollup pass peaks well
# above 1 GB while "rendering chunks". A t4g.micro/t3.micro has only 1 GB RAM
# and no swap by default, so the build is OOM-killed. Swap is not optional here.
TOTAL_RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SWAP_KB="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
if [[ "${SWAP_KB:-0}" -eq 0 && "${TOTAL_RAM_MB:-0}" -lt 2048 ]]; then
  log "Adding 2 GB swap (RAM is ${TOTAL_RAM_MB} MB, no swap present)"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  log "Swap OK (RAM ${TOTAL_RAM_MB} MB, swap ${SWAP_KB} KB)"
fi

# ---- base packages ---------------------------------------------------------
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg rsync sqlite3 \
  debian-keyring debian-archive-keyring apt-transport-https

# ---- Node.js (NodeSource) --------------------------------------------------
# node:sqlite is built in, so there is no native compile step; we only need a
# recent enough Node. >= 22.5 has node:sqlite; we target 24.x.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js already present: $(node -v)"
fi

# ---- Caddy (official apt repo) --------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
else
  log "Caddy already present: $(caddy version)"
fi

# ---- app user + directories ------------------------------------------------
log "Creating service user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"

# ---- fetch the code --------------------------------------------------------
CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # Inject the token only for the network operation; the stored remote stays clean.
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "Updating existing checkout in ${APP_DIR}"
  git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
  git -C "$APP_DIR" fetch --depth 1 origin "$GIT_REF"
  git -C "$APP_DIR" checkout -f "$GIT_REF"
  git -C "$APP_DIR" reset --hard "origin/${GIT_REF}"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
else
  log "Cloning ${REPO_URL} (ref ${GIT_REF}) into ${APP_DIR}"
  git clone --depth 1 --branch "$GIT_REF" "$CLONE_URL" "$APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"   # scrub token from .git/config
fi

# ---- build -----------------------------------------------------------------
# The API is run through tsx (it executes the TypeScript sources directly), so
# tsx and the workspace dev dependencies are needed at RUNTIME. That is why we
# run a full "npm ci" and NOT "npm ci --omit=dev". "npm run build" only has an
# effect in apps/web (the only workspace with a build script); it produces the
# static bundle in apps/web/dist. apps/mobile has no build script and is not
# served, so it is never built here.
log "Installing dependencies (full install; tsx is a runtime dependency)"
cd "$APP_DIR"
npm ci
log "Building the web client"
npm run build

if [[ ! -f "${WEB_DIST}/index.html" ]]; then
  echo "Build did not produce ${WEB_DIST}/index.html - aborting." >&2
  exit 1
fi

# node:sqlite is stable on some Node versions and behind --experimental-sqlite
# on others. Detect what this Node needs so the service starts without warnings
# or errors.
SQLITE_OPT=""
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  if node --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1; then
    SQLITE_OPT="--experimental-sqlite"
  fi
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

# ---- environment file ------------------------------------------------------
# Root-only. Written from the environment passed in; absent optional keys are
# simply left out, and the app degrades gracefully without them. No value is
# ever echoed to the console.
log "Writing ${ENV_FILE}"
umask 077
{
  echo "NODE_ENV=production"
  echo "PORT=${PORT}"
  echo "TRIPPY_DB=${DATA_DIR}/app.db"
  echo "APP_URL=${APP_URL:-$PUBLIC_URL}"
  echo "TRIPPY_REGISTER_LIMIT=${TRIPPY_REGISTER_LIMIT:-5}"
  [[ -n "$SQLITE_OPT" ]] && echo "NODE_OPTIONS=${SQLITE_OPT}"
} > "$ENV_FILE"

# Pass through any provider / mail secrets that are set, one per line, without
# printing them. Values are written verbatim.
append_if_set() {
  local name="$1"
  local val="${!name:-}"
  [[ -n "$val" ]] && printf '%s=%s\n' "$name" "$val" >> "$ENV_FILE"
}
for v in GOOGLE_PLACES_KEY GOOGLE_MAPS_KEY MAIL_FROM \
         AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
         SES_REGION AWS_REGION RESEND_API_KEY; do
  append_if_set "$v"
done

chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# ---- systemd service -------------------------------------------------------
# The API is run with "node --import tsx" so it executes the TypeScript entry
# point in a single process (no child fork), which keeps SIGTERM flowing to the
# app's own graceful-shutdown handler. WorkingDirectory is the repo root so
# tsx and the @trippy/* workspace packages resolve from /opt/trippy/node_modules.
log "Installing systemd service"
cat > /etc/systemd/system/trippy.service <<EOF
[Unit]
Description=Trippy API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node --import tsx apps/api/src/index.ts
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable trippy
systemctl restart trippy

# ---- Caddy: static web client + /api reverse proxy + auto HTTPS ------------
# On a real domain we send a strong HSTS (includeSubDomains; preload). On the
# sslip.io fallback we send a bare max-age only: sslip.io is a shared parent
# domain and we must not assert policy for hosts we do not control.
log "Configuring Caddy for ${DOMAIN}"
HSTS='Strict-Transport-Security "max-age=31536000"'
case "$DOMAIN" in
  *.sslip.io) : ;;  # keep the bare max-age
  *) HSTS='Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"' ;;
esac

{
  if [[ -n "${ACME_EMAIL:-}" ]]; then
    echo "{"
    echo "    email ${ACME_EMAIL}"
    echo "}"
  fi
  echo "${DOMAIN} {"
  echo "    encode zstd gzip"
  echo ""
  echo "    header {"
  echo "        ${HSTS}"
  echo "        X-Content-Type-Options \"nosniff\""
  echo "        Referrer-Policy \"strict-origin-when-cross-origin\""
  echo "        X-Frame-Options \"DENY\""
  echo "        # A Content-Security-Policy is intentionally left off until it is"
  echo "        # verified in a real browser: the app pulls Google Maps JS, Google"
  echo "        # static-map and place-photo images, and OSM tiles, so a tight CSP"
  echo "        # will blank the map or the cards. A tested starting point:"
  echo "        # Content-Security-Policy \"default-src 'self'; img-src 'self' data: https:; script-src 'self' https://maps.googleapis.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://maps.googleapis.com; frame-ancestors 'none'\""
  echo "        -Server"
  echo "    }"
  echo ""
  echo "    # The API process on loopback."
  echo "    handle /api/* {"
  echo "        reverse_proxy 127.0.0.1:${PORT}"
  echo "    }"
  echo ""
  echo "    # Everything else is the built single-page web client."
  echo "    handle {"
  echo "        root * ${WEB_DIST}"
  echo "        try_files {path} /index.html"
  echo "        file_server"
  echo "    }"
  echo "}"
} > /etc/caddy/Caddyfile

systemctl enable caddy
systemctl restart caddy

# ---- done ------------------------------------------------------------------
sleep 2
log "Deployment complete!"
cat <<EOF

  App URL:      ${PUBLIC_URL}
  API health:   ${PUBLIC_URL}/api/health
  Web (static): ${WEB_DIST}
  Data (SQLite):${DATA_DIR}/app.db

  Service:      sudo systemctl status trippy
  App logs:     sudo journalctl -u trippy -f
  Caddy logs:   sudo journalctl -u caddy -f

  Make sure your EC2 Security Group allows inbound 80 and 443 from anywhere
  (and 22 from your IP). The first HTTPS request may take a few seconds while
  Caddy obtains the certificate.

  If you configured mail, confirm APP_URL in ${ENV_FILE} is your public HTTPS
  origin so verification and reset links are correct.

  To update later:  sudo -E bash ${APP_DIR}/deploy/update.sh
EOF
