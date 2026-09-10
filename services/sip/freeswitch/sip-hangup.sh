#!/bin/sh
# Persist before returning from the channel hook. The outbox service delivers
# this idempotent event independently of API availability and channel lifetime.
set -eu
umask 077
route_id=${1:-}
event_id=${2:-hangup}
seconds=${3:-0}
case "$route_id" in ''|*[!A-Za-z0-9_-]*) exit 1;; esac
case "$event_id" in ''|*[!A-Za-z0-9_.-]*) exit 1;; esac
case "$seconds" in ''|*[!0-9]*) exit 1;; esac
[ "${#route_id}" -ge 16 ] && [ "${#route_id}" -le 80 ] || exit 1
[ "${#event_id}" -le 80 ] && [ "${#seconds}" -le 8 ] || exit 1
spool=${VOCIVO_SIP_OUTBOX_DIR:-/var/lib/vocivo/outbox}/hangups
mkdir -p "$spool"
job=$(mktemp "$spool/.pending.XXXXXX")
printf '{"routeId":"%s","eventId":"%s","durationSeconds":%s}\n' "$route_id" "$event_id" "$seconds" > "$job"
mv "$job" "$spool/$route_id-$event_id.json"
