#!/usr/bin/env bash
#
# Publish a built web bundle atomically, and roll back.
#
# Caddy serves the web client from a stable symlink, /var/www/trippy/current,
# which points at a timestamped release directory. Publishing copies the freshly
# built bundle into a NEW release directory and then flips the symlink with a
# single atomic rename. Caddy therefore never sees a half-written bundle: at
# every instant `current` points at one complete release or the next, never at a
# directory mid-copy. Old releases are kept so a rollback is a symlink flip, not
# a rebuild.
#
# Usage:
#   publish-web.sh <built-dist-dir>   # publish that bundle and make it current
#   publish-web.sh --rollback         # flip current back to the previous release
#   publish-web.sh --list             # list releases, marking the current one
#
# Env:
#   WEB_ROOT            base dir (default /var/www/trippy)
#   WEB_KEEP_RELEASES   how many releases to retain (default 5)
#
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/trippy}"
RELEASES="${WEB_ROOT}/releases"
CURRENT="${WEB_ROOT}/current"
KEEP="${WEB_KEEP_RELEASES:-5}"

die() { echo "Error: $*" >&2; exit 1; }

list_releases() {  # newest first; timestamped names sort chronologically
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -r
}

current_target() {
  [[ -L "$CURRENT" ]] && readlink -f "$CURRENT" || true
}

flip_to() {  # $1 = release dir; atomic swap of the symlink
  local rel="$1"
  ln -sfn "$rel" "${CURRENT}.tmp"
  mv -Tf "${CURRENT}.tmp" "$CURRENT"
}

prune() {
  local cur; cur="$(current_target)"
  local n=0 d
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    n=$((n + 1))
    [[ "$n" -le "$KEEP" ]] && continue
    [[ "$(readlink -f "$d")" == "$cur" ]] && continue   # never delete the live one
    rm -rf "$d"
  done < <(list_releases)
}

case "${1:-}" in
  --list)
    cur="$(current_target)"
    if [[ -z "$(list_releases)" ]]; then echo "No releases under ${RELEASES}."; exit 0; fi
    while IFS= read -r d; do
      [[ -z "$d" ]] && continue
      if [[ "$(readlink -f "$d")" == "$cur" ]]; then echo "* $d  (current)"; else echo "  $d"; fi
    done < <(list_releases)
    ;;

  --rollback)
    cur="$(current_target)"
    prev=""
    while IFS= read -r d; do
      [[ -z "$d" ]] && continue
      [[ "$(readlink -f "$d")" == "$cur" ]] && continue
      prev="$d"; break
    done < <(list_releases)
    [[ -n "$prev" ]] || die "No previous release to roll back to."
    echo "==> Rolling back web bundle to ${prev}"
    flip_to "$prev"
    echo "==> current -> $(current_target)"
    ;;

  ""|-h|--help)
    sed -n '2,26p' "$0"
    [[ -z "${1:-}" ]] && exit 1 || exit 0
    ;;

  *)
    SRC="$1"
    [[ -d "$SRC" ]] || die "No such bundle directory: ${SRC}"
    [[ -f "${SRC}/index.html" ]] || die "No index.html in ${SRC}; refusing to publish a bundle that is not a built web client."
    mkdir -p "$RELEASES"
    REL="${RELEASES}/$(date +%Y%m%d-%H%M%S)-$$"
    echo "==> Staging new release ${REL}"
    mkdir -p "$REL"
    # Copy aside on the same filesystem as CURRENT so the flip below is a local
    # atomic rename, not a cross-device move.
    cp -a "${SRC}/." "$REL/"
    [[ -f "${REL}/index.html" ]] || die "Copy into ${REL} did not land index.html; aborting before the flip."
    echo "==> Flipping ${CURRENT} -> ${REL}"
    flip_to "$REL"
    prune
    echo "==> Published. current -> $(current_target)"
    ;;
esac
