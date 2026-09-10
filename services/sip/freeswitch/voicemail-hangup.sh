#!/bin/sh
# Keep recording and signed upload metadata together until delivery succeeds.
set -eu
umask 077
url=${1:-}
recording=${2:-}
[ -n "$url" ] && [ -n "$recording" ] && [ -s "$recording" ] || exit 0
case "$recording" in "${VOCIVO_SIP_RECORDINGS_DIR:-/var/lib/vocivo/recordings}/"*.wav) ;; *) exit 1;; esac
job=$(mktemp "$recording.pending.XXXXXX")
printf '%s' "$url" > "$job"
mv "$job" "$recording.upload"
