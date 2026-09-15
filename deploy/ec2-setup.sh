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
#   #   export GITHUB_TOKEN='github_pat_...'      # only if the repo is private; public clones need no token
#   # optional but recommended:
#   #   export DOMAIN='trippy.dxu.info'           # point its DNS A record at this box first
#   #   export ACME_EMAIL='you@example.com'       # Let's Encrypt expiry notices
#   # optional provider / mail secrets (any that are set are written to the env file):
#   #   export GOOGLE_SERVER_KEY='...'            # secret Places and Routes key
#   #   export GOOGLE_MAPS_KEY='...'              # public browser Maps JavaScript key
#   #   export GOOGLE_PLACES_KEY='...'            # deprecated server key fallback
#   #   export MAIL_FROM='trips@trippy.dxu.info'  # turns on email verification
#   #   export AWS_ACCESS_KEY_ID='...' AWS_SECRET_ACCESS_KEY='...' SES_REGION='us-east-1'
#   #   export RESEND_API_KEY='...'               # used only if SES keys are absent
#   #   export TRIPPY_REGISTER_LIMIT='5'          # signups per IP before backoff
#   #   export TRIPPY_TRUSTED_PROXIES='1'         # Caddy proxy hop count; defaults to 1 here
#   #   export TRIPPY_PROVIDER_LIMIT='60'         # paid provider calls per user before backoff
#   #   export TRIPPY_PROVIDER_IP_LIMIT='240'     # paid provider calls per IP before backoff
#   #   export TRIPPY_ROUTING_LIMIT='300'         # paid routing calls per user before fallback
#   #   export GIT_REF='main'
#   # optional off-box durability (Litestream continuous S3 replication):
#   #   export LITESTREAM_S3_BUCKET='my-trippy-backups'   # enables Litestream
#   #   export LITESTREAM_S3_REGION='us-east-1'
#   #   export LITESTREAM_S3_PREFIX='trippy/app.db'       # bucket key prefix
#   #   # Credentials: prefer an EC2 instance role (nothing to set). Only if you
#   #   # cannot use a role, set DEDICATED S3-write keys (never the SES keys):
#   #   export LITESTREAM_ACCESS_KEY_ID='...' LITESTREAM_SECRET_ACCESS_KEY='...'
#   # optional monitoring / rehearsal knobs:
#   #   export ACME_STAGING='1'                   # use Let's Encrypt STAGING (rehearse TLS)
#   #   export ALERT_WEBHOOK_URL='https://...'    # monitor.sh POSTs alerts here
#   #   export BACKUP_PING_URL='https://hc-ping.com/...'  # dead-man ping on backup success
#   #   export SKIP_PREFLIGHT='1'                 # skip the preflight checks (not advised)
#   sudo -E bash deploy/ec2-setup.sh
#
# sudo -E preserves your exported variables. The script never prints a secret and
# is idempotent: safe to re-run.
#
set -euo pipefail

# Never let git block on an interactive credential prompt. Without this, an
# unattended run against a repo it cannot read non-interactively (for example a
# private repo with no GITHUB_TOKEN) would hang forever waiting for a username;
# instead we want a clean, fast failure. Applies to every network git call below.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

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
# Caddy serves the web client from a stable symlink that we flip atomically on
# each deploy (see publish-web.sh), so a rebuild never leaves a half-written
# bundle in the served path.
WEB_ROOT="/var/www/trippy"
WEB_CURRENT="${WEB_ROOT}/current"
HERE="$(cd "$(dirname "$0")" && pwd)"

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

# ---- preflight -------------------------------------------------------------
# Validate DNS, the token, disk, memory and required env BEFORE we change the
# system, so a misconfiguration fails here rather than halfway through. Skippable
# with SKIP_PREFLIGHT=1 for the rare case you must push past a warning.
if [[ "${SKIP_PREFLIGHT:-0}" == "1" ]]; then
  log "Skipping preflight (SKIP_PREFLIGHT=1)"
elif [[ -f "${HERE}/preflight.sh" ]]; then
  log "Running preflight checks"
  PUBLIC_IP="$PUBLIC_IP" DOMAIN="$DOMAIN" REPO_URL="$REPO_URL" bash "${HERE}/preflight.sh"
else
  log "preflight.sh not found next to this script; continuing without it"
fi

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
# GITHUB_TOKEN is optional: the repo is public, so the anonymous URL clones and
# fetches fine. Set GITHUB_TOKEN only if the repo has been made private again (or
# to deploy a private fork); when set, it is injected into the network URL only,
# and the stored remote is always scrubbed back to the clean anonymous URL.
CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # Inject the token only for the network operation; the stored remote stays clean.
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "Updating existing checkout in ${APP_DIR}"
  # On a re-run this checkout is owned by ${APP_USER} (the first run chowns it,
  # see below), but we are root here, so git would abort with "detected dubious
  # ownership". Scope a safe.directory exception to each command instead of
  # mutating root's global git config: it is explicit, leaves no state on the
  # box, and cannot accumulate duplicate entries across re-runs. Any objects git
  # writes as root are re-owned by the chown -R below.
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" remote set-url origin "$CLONE_URL"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch --depth 1 origin "$GIT_REF"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" checkout -f "$GIT_REF"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard "origin/${GIT_REF}"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" remote set-url origin "$REPO_URL"
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

# ---- publish the web bundle to the served path -----------------------------
# Caddy's root is the stable symlink ${WEB_CURRENT}. Publish the freshly built
# bundle into a timestamped release and flip the symlink atomically, so the
# served path is never a directory mid-copy. This also gives update.sh a
# rebuild-free rollback (flip back to the previous release).
log "Publishing the web bundle to ${WEB_CURRENT}"
mkdir -p "$WEB_ROOT"
WEB_ROOT="$WEB_ROOT" bash "${APP_DIR}/deploy/publish-web.sh" "$WEB_DIST"

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
warn_if_existing_env_name_unset() {
  local name="$1"
  if [[ -f "$ENV_FILE" ]]; then
    if grep -qE "^${name}=" "$ENV_FILE"; then
      if [[ -z "${!name:-}" ]]; then
        echo "Warning: ${ENV_FILE} already contains ${name}, but ${name} is not set to a non-empty value for this run." >&2
        echo "         ${ENV_FILE} is rewritten from scratch, so the existing ${name} value will not be preserved." >&2
      fi
    fi
  fi
  return 0
}

for v in APP_URL TRIPPY_REGISTER_LIMIT TRIPPY_TRUSTED_PROXIES TRIPPY_PROVIDER_LIMIT \
         TRIPPY_PROVIDER_IP_LIMIT TRIPPY_ROUTING_LIMIT \
         GOOGLE_SERVER_KEY GOOGLE_PLACES_KEY GOOGLE_MAPS_KEY MAIL_FROM \
         AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
         SES_REGION AWS_REGION RESEND_API_KEY; do
  warn_if_existing_env_name_unset "$v"
done

TRIPPY_TRUSTED_PROXIES_VALUE="${TRIPPY_TRUSTED_PROXIES:-1}"
if [[ -n "${TRIPPY_TRUSTED_PROXIES:-}" ]]; then
  log "Using operator supplied TRIPPY_TRUSTED_PROXIES=${TRIPPY_TRUSTED_PROXIES_VALUE}"
else
  log "Defaulting TRIPPY_TRUSTED_PROXIES=1 because this setup puts Caddy in front of the API"
fi

log "Writing ${ENV_FILE}"
umask 077
{
  echo "NODE_ENV=production"
  echo "PORT=${PORT}"
  echo "TRIPPY_DB=${DATA_DIR}/app.db"
  echo "APP_URL=${APP_URL:-$PUBLIC_URL}"
  echo "TRIPPY_REGISTER_LIMIT=${TRIPPY_REGISTER_LIMIT:-5}"
  echo "TRIPPY_TRUSTED_PROXIES=${TRIPPY_TRUSTED_PROXIES_VALUE}"
  if [[ -n "$SQLITE_OPT" ]]; then echo "NODE_OPTIONS=${SQLITE_OPT}"; fi
} > "$ENV_FILE"

# Pass through any provider / mail secrets that are set, one per line, without
# printing them. Values are written verbatim.
append_if_set() {
  local name="$1"
  local val="${!name:-}"
  if [[ -n "$val" ]]; then printf '%s=%s\n' "$name" "$val" >> "$ENV_FILE"; fi
}
for v in GOOGLE_SERVER_KEY GOOGLE_PLACES_KEY GOOGLE_MAPS_KEY MAIL_FROM \
         AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
         SES_REGION AWS_REGION RESEND_API_KEY \
         TRIPPY_PROVIDER_LIMIT TRIPPY_PROVIDER_IP_LIMIT TRIPPY_ROUTING_LIMIT; do
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

# ---- Litestream: continuous S3 replication (optional, primary durability) ---
# Litestream streams the SQLite WAL to S3, giving point-in-time recovery to
# within seconds. It is the primary off-box durability layer. It is OPTIONAL and
# fail-soft: with no S3 bucket set we skip it cleanly, so a first deploy without
# S3 still succeeds. Set LITESTREAM_S3_BUCKET and re-run to turn it on later.
#
# Version is PINNED, not "latest": a backup tool must not silently change its
# on-disk format or CLI under you on a redeploy. 0.3.x is the long-term stable
# line with a settled config schema and restore CLI; the 0.5 line is a rewrite
# (new on-disk format, changed config defaults) we deliberately do not adopt
# automatically. Bump this only after testing a restore against the new version.
LITESTREAM_VERSION="0.3.13"
LITESTREAM_ENV="/etc/litestream.env"
LITESTREAM_YML="/etc/litestream.yml"

if [[ -z "${LITESTREAM_S3_BUCKET:-}" ]]; then
  log "Litestream: LITESTREAM_S3_BUCKET not set - skipping off-box replication."
  echo "    Set LITESTREAM_S3_BUCKET (and LITESTREAM_S3_REGION) and re-run to enable it."
else
  log "Installing Litestream v${LITESTREAM_VERSION}"
  # arm64 on t4g.micro, amd64 on t3.micro. dpkg reports the Debian arch, which
  # matches the suffix Litestream uses on its .deb assets.
  DEB_ARCH="$(dpkg --print-architecture)"
  case "$DEB_ARCH" in
    arm64|amd64) : ;;
    *) echo "Unsupported architecture for Litestream: ${DEB_ARCH}" >&2; exit 1 ;;
  esac
  if ! litestream version 2>/dev/null | grep -q "${LITESTREAM_VERSION}"; then
    LS_DEB="litestream-v${LITESTREAM_VERSION}-linux-${DEB_ARCH}.deb"
    LS_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${LS_DEB}"
    TMP_DEB="$(mktemp --suffix=.deb)"
    curl -fsSL "$LS_URL" -o "$TMP_DEB"
    apt-get install -y "$TMP_DEB"
    rm -f "$TMP_DEB"
  else
    log "Litestream already at v${LITESTREAM_VERSION}"
  fi

  # awscli is only needed by backup.sh's optional off-box upload; Litestream
  # talks to S3 itself. Fail-soft: a missing awscli only disables that upload.
  apt-get install -y awscli || log "awscli install failed; snapshot S3 upload will be skipped."

  # Config env: non-secret bucket/region/prefix, plus - only if the operator
  # supplied them - the DEDICATED S3 keys. Root-only, because it may carry keys.
  log "Writing ${LITESTREAM_ENV}"
  umask 077
  {
    echo "LITESTREAM_S3_BUCKET=${LITESTREAM_S3_BUCKET}"
    echo "LITESTREAM_S3_REGION=${LITESTREAM_S3_REGION:-us-east-1}"
    echo "LITESTREAM_S3_PREFIX=${LITESTREAM_S3_PREFIX:-trippy/app.db}"
  } > "$LITESTREAM_ENV"
  # Prefer an EC2 instance role (nothing written here). Only if dedicated keys
  # were supplied do we write them. We NEVER reuse the app's SES keys for this:
  # S3-write and SES-send need completely different IAM permissions. Litestream
  # reads these two variable names natively.
  if [[ -n "${LITESTREAM_ACCESS_KEY_ID:-}" && -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]]; then
    printf 'LITESTREAM_ACCESS_KEY_ID=%s\n'     "$LITESTREAM_ACCESS_KEY_ID"     >> "$LITESTREAM_ENV"
    printf 'LITESTREAM_SECRET_ACCESS_KEY=%s\n' "$LITESTREAM_SECRET_ACCESS_KEY" >> "$LITESTREAM_ENV"
    log "Litestream using supplied LITESTREAM_ACCESS_KEY_ID (dedicated S3 keys)."
  else
    log "Litestream using the EC2 instance role for S3 (no keys written)."
  fi
  chmod 600 "$LITESTREAM_ENV"
  chown root:root "$LITESTREAM_ENV"

  # Replication config. NO secret and NO hardcoded bucket/region: each
  # environment-specific value is an ${ENV} reference Litestream expands at
  # runtime from the EnvironmentFile above. The single-quoted heredoc keeps the
  # ${...} literal in the file rather than expanding it now.
  log "Writing ${LITESTREAM_YML}"
  cat > "$LITESTREAM_YML" <<'EOF'
# Managed by deploy/ec2-setup.sh. Do NOT put secrets here.
# Bucket, region and prefix come from /etc/litestream.env; credentials come from
# the EC2 instance role, or from LITESTREAM_ACCESS_KEY_ID /
# LITESTREAM_SECRET_ACCESS_KEY - never the app's SES keys.
dbs:
  - path: /var/lib/trippy/app.db
    replicas:
      - type: s3
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_S3_PREFIX}
        region: ${LITESTREAM_S3_REGION}
        # 7-day point-in-time window. A restore can land on any second within it.
        retention: 168h
        snapshot-interval: 24h
EOF
  chmod 644 "$LITESTREAM_YML"
  chown root:root "$LITESTREAM_YML"

  # Run as the trippy service user, NOT root: least privilege. Litestream only
  # needs to read app.db and its -wal and to write its shadow WAL inside
  # /var/lib/trippy, all already owned by trippy. Ordered After=trippy.service so
  # the data directory (and, on first boot, the database) exists first; it
  # tolerates a not-yet-created database and retries.
  log "Installing litestream.service"
  cat > /etc/systemd/system/litestream.service <<EOF
[Unit]
Description=Litestream (SQLite -> S3 replication for Trippy)
After=network-online.target trippy.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=${LITESTREAM_ENV}
ExecStart=/usr/bin/litestream replicate -config ${LITESTREAM_YML}
Restart=always
RestartSec=5
# Hardening (mirrors trippy.service)
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable litestream
  systemctl restart litestream
  log "Litestream replicating ${DATA_DIR}/app.db to s3://${LITESTREAM_S3_BUCKET}/${LITESTREAM_S3_PREFIX:-trippy/app.db}"
fi

# ---- Daily snapshot backup timer -------------------------------------------
# The Litestream layer above is continuous. This is the independent, belt-and-
# braces layer: a daily whole-file snapshot (backup.sh), integrity-checked,
# locally pruned, and copied off-box when S3 is configured.
log "Installing the daily backup timer (trippy-backup.timer)"
cat > /etc/systemd/system/trippy-backup.service <<EOF
[Unit]
Description=Trippy daily SQLite snapshot backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
# Load the S3 config for the optional off-box upload if present. We deliberately
# do NOT load /etc/trippy.env: the app's SES keys must not become the backup
# identity. The leading '-' makes the file optional (fail-soft without S3).
# The monitor env carries an optional BACKUP_PING_URL (dead-man's switch).
EnvironmentFile=-${LITESTREAM_ENV}
EnvironmentFile=-/etc/trippy-monitor.env
ExecStart=/usr/bin/env bash ${APP_DIR}/deploy/backup.sh
EOF

cat > /etc/systemd/system/trippy-backup.timer <<EOF
[Unit]
Description=Run the Trippy snapshot backup daily

[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable trippy-backup.timer
systemctl restart trippy-backup.timer

# ---- Monitoring: watchdog, resource + backup-freshness checks --------------
# There is no external monitoring here (that is documented in the README and is
# the part that pages a human). These are the on-box layers: a watchdog that
# restarts a wedged API, and a periodic resource + backup-freshness check.
#
# Optional alert config. Non-secret thresholds plus, if supplied, a webhook and
# a dead-man ping URL. Root-only because a webhook URL is credential-like.
if [[ -n "${ALERT_WEBHOOK_URL:-}" || -n "${BACKUP_PING_URL:-}" \
      || -n "${DISK_WARN_PCT:-}" || -n "${DISK_CRIT_PCT:-}" \
      || -n "${BACKUP_MAX_AGE_HOURS:-}" || -n "${LITESTREAM_MAX_AGE_MINUTES:-}" ]]; then
  log "Writing /etc/trippy-monitor.env"
  umask 077
  : > /etc/trippy-monitor.env
  for v in ALERT_WEBHOOK_URL BACKUP_PING_URL DISK_WARN_PCT DISK_CRIT_PCT \
           BACKUP_MAX_AGE_HOURS LITESTREAM_MAX_AGE_MINUTES; do
    val="${!v:-}"
    [[ -n "$val" ]] && printf '%s=%s\n' "$v" "$val" >> /etc/trippy-monitor.env
  done
  chmod 600 /etc/trippy-monitor.env
  chown root:root /etc/trippy-monitor.env
fi

# Cap journald so logs cannot fill the 20 GiB volume (a full disk corrupts
# SQLite writes). Idempotent drop-in; only rewritten if it changes.
log "Capping journald size (drop-in)"
mkdir -p /etc/systemd/journald.conf.d
JOURNALD_DROPIN="/etc/systemd/journald.conf.d/trippy.conf"
NEW_JOURNALD="$(cat <<'EOF'
# Managed by deploy/ec2-setup.sh. Keep the journal bounded on a small volume.
[Journal]
SystemMaxUse=200M
SystemKeepFree=500M
MaxRetentionSec=1month
EOF
)"
if [[ ! -f "$JOURNALD_DROPIN" ]] || [[ "$(cat "$JOURNALD_DROPIN")" != "$NEW_JOURNALD" ]]; then
  printf '%s\n' "$NEW_JOURNALD" > "$JOURNALD_DROPIN"
  systemctl restart systemd-journald || true
fi

# Watchdog: curl /api/health on loopback; restart the API after repeated fails.
log "Installing the API watchdog (trippy-health.timer)"
cat > /etc/systemd/system/trippy-health.service <<EOF
[Unit]
Description=Trippy API health watchdog
After=trippy.service

[Service]
Type=oneshot
User=root
Environment=PORT=${PORT}
ExecStart=/usr/bin/env bash ${APP_DIR}/deploy/healthcheck.sh
EOF

cat > /etc/systemd/system/trippy-health.timer <<EOF
[Unit]
Description=Run the Trippy API health watchdog every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=15s

[Install]
WantedBy=timers.target
EOF

# Resource + backup-freshness monitor, every 15 minutes.
log "Installing the resource + backup monitor (trippy-monitor.timer)"
cat > /etc/systemd/system/trippy-monitor.service <<EOF
[Unit]
Description=Trippy resource and backup-freshness monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
EnvironmentFile=-${LITESTREAM_ENV}
EnvironmentFile=-/etc/trippy-monitor.env
ExecStart=/usr/bin/env bash ${APP_DIR}/deploy/monitor.sh
EOF

cat > /etc/systemd/system/trippy-monitor.timer <<EOF
[Unit]
Description=Run the Trippy resource and backup monitor every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable trippy-health.timer trippy-monitor.timer
systemctl restart trippy-health.timer trippy-monitor.timer

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
  # Global options: emitted when we have an ACME email and/or are rehearsing
  # against Let's Encrypt STAGING. Staging has far looser rate limits, so set
  # ACME_STAGING=1 to prove the whole path (SG rules, DNS, issuance) without
  # risking the real limit; its certs are untrusted, so switch it OFF and re-run
  # for a real certificate.
  if [[ -n "${ACME_EMAIL:-}" || "${ACME_STAGING:-0}" == "1" ]]; then
    echo "{"
    [[ -n "${ACME_EMAIL:-}" ]] && echo "    email ${ACME_EMAIL}"
    [[ "${ACME_STAGING:-0}" == "1" ]] && echo "    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory"
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
  echo "        root * ${WEB_CURRENT}"
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

  Backups:      Litestream (continuous S3) + a daily snapshot timer.
  Litestream:   sudo systemctl status litestream   (skipped if no S3 bucket set)
  Snapshots:    systemctl list-timers trippy-backup.timer
  Restore:      sudo bash ${APP_DIR}/deploy/restore.sh --help

  Monitoring:   watchdog + resource/backup checks (on-box only).
  Watchdog:     systemctl list-timers trippy-health.timer
  Monitor:      systemctl list-timers trippy-monitor.timer ; journalctl -t trippy-monitor
  External:     set up an off-box uptime check that pages you - see the
                "Monitoring and alerting" section of deploy/README.md.

  Web bundle:   served via ${WEB_CURRENT} (atomic release symlink)
  Rollback web: sudo bash ${APP_DIR}/deploy/publish-web.sh --rollback

  See the "Backups and recovery" section of deploy/README.md for the setup of
  the S3 bucket, the IAM role/policy, and the recovery drill.

  Make sure your EC2 Security Group allows inbound 80 and 443 from anywhere
  (and 22 from your IP). The first HTTPS request may take a few seconds while
  Caddy obtains the certificate.

  If you configured mail, confirm APP_URL in ${ENV_FILE} is your public HTTPS
  origin so verification and reset links are correct.

  To update later:  sudo -E bash ${APP_DIR}/deploy/update.sh
EOF
