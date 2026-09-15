#!/usr/bin/env bash
#
# Run Litestream manually with the same environment that systemd provides to
# litestream.service.
#
# Usage:
#   sudo bash /opt/trippy/deploy/litestream-cli.sh snapshots /var/lib/trippy/app.db
#   sudo bash /opt/trippy/deploy/litestream-cli.sh restore -o /path/app.db /var/lib/trippy/app.db
#
set -euo pipefail

LITESTREAM_ENV="${LITESTREAM_ENV:-/etc/litestream.env}"
LITESTREAM_YML="${LITESTREAM_YML:-/etc/litestream.yml}"

die() {
  echo "Error: $*" >&2
  exit 1
}

if [[ $# -eq 0 ]]; then
  die "usage: sudo bash /opt/trippy/deploy/litestream-cli.sh <litestream-command> [args...]"
fi

[[ -f "$LITESTREAM_ENV" ]] || die "Missing ${LITESTREAM_ENV}; re-run deploy/ec2-setup.sh with LITESTREAM_S3_BUCKET set."
[[ -f "$LITESTREAM_YML" ]] || die "Missing ${LITESTREAM_YML}; re-run deploy/ec2-setup.sh with LITESTREAM_S3_BUCKET set."

set -a
# shellcheck disable=SC1090
. "$LITESTREAM_ENV"
set +a

command="$1"
shift

has_config="no"
for arg in "$@"; do
  if [[ "$arg" == "-config" || "$arg" == "--config" ]]; then
    has_config="yes"
    break
  fi
done

case "$command" in
  help|-h|--help|version)
    exec litestream "$command" "$@"
    ;;
  *)
    if [[ "$has_config" == "yes" ]]; then
      exec litestream "$command" "$@"
    fi
    exec litestream "$command" -config "$LITESTREAM_YML" "$@"
    ;;
esac
