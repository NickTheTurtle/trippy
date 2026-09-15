#!/usr/bin/env bash
#
# Preflight checks for the Trippy EC2 deploy. Run this BEFORE ec2-setup.sh (which
# also calls it automatically) so a misconfiguration is caught while the box is
# still clean, not halfway through a partially configured install. It changes
# nothing on the system.
#
# It validates: required commands, required environment, enough disk and memory,
# that the GitHub token can actually read the private repo, and, when a DOMAIN is
# set, that its DNS points at THIS instance (so Let's Encrypt will be able to
# issue, and you do not burn its rate limit on a doomed attempt).
#
# Usage:
#   export GITHUB_TOKEN='github_pat_...'
#   export DOMAIN='trippy.dxu.info'      # optional; omit to use the sslip.io fallback
#   bash deploy/preflight.sh
#
# Exit status is non-zero if any REQUIRED check fails; each failure names the fix.
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/NickTheTurtle/trippy.git}"
REPO_SLUG="${REPO_URL#https://github.com/}"; REPO_SLUG="${REPO_SLUG%.git}"
MIN_FREE_GB="${MIN_FREE_GB:-5}"

fail=0
ok()   { echo "  ok   - $*"; }
warn() { echo "  warn - $*"; }
bad()  { echo "  FAIL - $*"; fail=1; }

echo "== Trippy preflight =="

# ---- required commands -----------------------------------------------------
# curl ships on Ubuntu Server 24.04; the rest ec2-setup.sh installs.
for c in curl awk; do
  if command -v "$c" >/dev/null 2>&1; then ok "command present: $c"
  else bad "missing command: $c  (fix: sudo apt-get update && sudo apt-get install -y $c)"; fi
done

# ---- required environment --------------------------------------------------
if [[ -n "${GITHUB_TOKEN:-}" ]]; then ok "GITHUB_TOKEN is set"
else bad "GITHUB_TOKEN is not set  (fix: export GITHUB_TOKEN='github_pat_...' with Contents:Read on ${REPO_SLUG})"; fi

# ---- disk ------------------------------------------------------------------
free_kb="$(df -Pk / | awk 'NR==2{print $4}')"
free_gb=$(( free_kb / 1024 / 1024 ))
if [[ "$free_gb" -ge "$MIN_FREE_GB" ]]; then ok "free disk on /: ${free_gb} GiB (>= ${MIN_FREE_GB})"
else bad "only ${free_gb} GiB free on / (need >= ${MIN_FREE_GB})  (fix: grow the EBS volume or clear space)"; fi

# ---- memory / swap ---------------------------------------------------------
ram_mb="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
swap_kb="$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [[ "$ram_mb" -ge 2048 ]]; then
  ok "RAM ${ram_mb} MB"
elif [[ "${swap_kb:-0}" -gt 0 ]]; then
  ok "RAM ${ram_mb} MB with swap present (build should fit)"
else
  warn "RAM ${ram_mb} MB and no swap; ec2-setup.sh will add a 2 GB swapfile so the web build does not get OOM-killed"
fi

# ---- discover this box's public IP (IMDSv2, then a public echo) ------------
PUBLIC_IP="${PUBLIC_IP:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  tok="$(curl -sf --connect-timeout 1 -m 2 -X PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  [[ -n "$tok" ]] && PUBLIC_IP="$(curl -sf --connect-timeout 1 -m 2 -H "X-aws-ec2-metadata-token: $tok" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
  [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(curl -sf --connect-timeout 2 -m 5 https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -n "$PUBLIC_IP" ]]; then ok "public IP: ${PUBLIC_IP}"
else warn "could not determine the public IP; DNS match check will be skipped"; fi

# ---- GitHub token can read the private repo --------------------------------
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO_SLUG}" 2>/dev/null || echo 000)"
  case "$code" in
    200) ok "GitHub token can read ${REPO_SLUG}" ;;
    401) bad "GitHub token rejected (401)  (fix: regenerate a fine-grained token with Contents:Read on ${REPO_SLUG})" ;;
    404) bad "repo ${REPO_SLUG} not visible to this token (404)  (fix: grant the token access to that repo)" ;;
    000) warn "could not reach api.github.com to validate the token (network?)" ;;
    *)   bad "unexpected GitHub API status ${code} validating the token" ;;
  esac
fi

# ---- DNS points at this box (only when a real DOMAIN is given) -------------
DOMAIN="${DOMAIN:-}"
case "$DOMAIN" in
  ""|*.sslip.io)
    ok "no custom DOMAIN (sslip.io fallback will be used); skipping DNS match" ;;
  *)
    if ! command -v getent >/dev/null 2>&1; then
      warn "getent not available here; cannot verify DNS (it is present on Ubuntu, so this check will run on the box)"
    else
    resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
    if [[ -z "$resolved" ]]; then
      bad "DOMAIN ${DOMAIN} does not resolve  (fix: add an A record for ${DOMAIN} -> ${PUBLIC_IP:-<this IP>}, TTL 300, and wait for it)"
    elif [[ -n "$PUBLIC_IP" && "$resolved" != "$PUBLIC_IP" ]]; then
      bad "DOMAIN ${DOMAIN} resolves to ${resolved}, not this box ${PUBLIC_IP}  (fix: update the A record; Let's Encrypt will fail until it matches)"
    else
      ok "DOMAIN ${DOMAIN} resolves to ${resolved}"
    fi
    fi ;;
esac

# ---- ports 80/443 reachable from outside (best effort) ---------------------
# A true external probe needs something to connect back, which we do not have
# from the box alone (AWS often does not hairpin a self-connect to the public
# IP). So this is best effort and never fatal: a positive result is reassuring,
# a negative one is inconclusive. The reliable way to catch a missing security
# group rule is the external uptime check, plus rehearsing with Let's Encrypt
# staging (ACME_STAGING=1) so a wrong rule does not burn the real rate limit.
if [[ -n "$PUBLIC_IP" ]]; then
  for port in 80 443; do
    if curl -sf -m 5 -o /dev/null "http://${PUBLIC_IP}:${port}/" 2>/dev/null; then
      ok "reached this box on port ${port} from its public IP"
    else
      warn "could not self-reach port ${port} (usually just no hairpin NAT, not a real problem); confirm the EC2 security group allows inbound ${port} from 0.0.0.0/0 before relying on TLS"
    fi
  done
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "== Preflight FAILED. Fix the items marked FAIL above, then re-run. =="
  echo "   (To bypass in ec2-setup.sh at your own risk: export SKIP_PREFLIGHT=1)"
  exit 1
fi
echo "== Preflight passed. Safe to run ec2-setup.sh. =="
