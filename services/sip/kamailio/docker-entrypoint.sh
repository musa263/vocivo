#!/bin/sh
set -e

# KAMAILIO_CHECK_ONLY=1 renders the configuration exactly as a real start
# would and then asks Kamailio to parse it instead of running it. Ops ·
# Droplets → sync-config runs the staged configuration through this before
# swapping anything: a function name Kamailio does not know passes every
# static check and stops it starting at all.
check_only=0
[ "${KAMAILIO_CHECK_ONLY:-0}" = 1 ] && check_only=1

if [ "$check_only" = 0 ]; then
  mkdir -p /run/vocivo-monitor
  chmod 700 /run/vocivo-monitor
  mkdir -p /var/lib/kamailio
  if ! command -v sqlite3 >/dev/null 2>&1; then apk add --no-cache sqlite >/dev/null; fi
  sqlite3 /var/lib/kamailio/cdr.db 'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);' >/dev/null
  if [ ! -f /var/lib/kamailio/usrloc.db ]; then
    if ! command -v sqlite3 >/dev/null 2>&1; then
      apk add --no-cache sqlite >/dev/null
    fi
    sqlite3 /var/lib/kamailio/usrloc.db < /etc/kamailio/usrloc-init.sql
  fi
fi

# The carrier's signalling addresses, rendered into a config the main file
# includes. Kamailio's =~ wants a literal, and an unauthenticated E.164 INVITE
# is exactly what toll fraud looks like — so the allowed sources are written
# out explicitly rather than matched against a pattern at run time.
#
# VOCIVO_TRUNK_SOURCES is a comma- or space-separated list of IPv4 addresses
# and CIDR ranges.
# Empty means no source is trusted, which is the safe default: inbound over the
# trunk stays refused until somebody names the addresses it may arrive from.
# The sockets, with the droplet's public address advertised on the public
# ones. Bound to 0.0.0.0 with nothing advertised, Kamailio wrote 0.0.0.0 into
# the Record-Route of every call it proxied, and the carrier had nowhere to
# send its ACK: FreeSWITCH kept re-sending the 200 OK and, when SIP's Timer H
# expired, hung up — every answered inbound call ended at exactly 32 seconds.
listen_file=/etc/kamailio/listen.cfg
public_ip="${PUBLIC_IP:-}"
case "$public_ip" in
  ''|127.0.0.1|*[!0-9.]*) advertise="" ;;
  *) advertise=" advertise ${public_ip}:5060" ;;
esac
{
  echo '# generated at container start from PUBLIC_IP'
  echo "listen=udp:0.0.0.0:5060${advertise}"
  echo "listen=tcp:0.0.0.0:5060${advertise}"
  echo 'listen=tcp:127.0.0.1:8080'
} > "$listen_file"
[ -n "$advertise" ] && echo "kamailio: advertising ${public_ip}:5060 on the public sockets" || echo "kamailio: PUBLIC_IP not set, no advertised address (Record-Route will carry 0.0.0.0)" >&2

sources_file=/etc/kamailio/trunk-sources.cfg
{
  echo '# generated at container start from VOCIVO_TRUNK_SOURCES'
  echo 'route[TRUNK_SOURCE] {'
  echo '    $var(from_trunk) = 0;'
  # printf '%s\n', not '%s': read returns false at end of input even when it
  # has filled the variable, so without the trailing newline the last entry
  # is silently dropped — the first enable-inbound rendered two of three.
  printf '%s\n' "${VOCIVO_TRUNK_SOURCES:-}" | tr ', ' '\n\n' | while read -r address; do
    [ -n "$address" ] || continue
    case "$address" in
      # A range, which is what carriers actually publish: Telnyx's signalling
      # is 192.76.120.128/26 and friends, never a list of single hosts.
      # is_in_subnet is ipops' name for it (there is no is_ip_in_subnet).
      *[0-9].[0-9]*/[0-9]*)
        printf '    if (is_in_subnet($si, "%s")) { $var(from_trunk) = 1; }\n' "$address"
        ;;
      *[!0-9.]*)
        echo "kamailio: ignoring trunk source, not an address or range: $address" >&2
        ;;
      *)
        printf '    if ($si == "%s") { $var(from_trunk) = 1; }\n' "$address"
        ;;
    esac
  done
  echo '}'
} > "$sources_file"
# grep -c prints 0 and exits 1 when it matches nothing; || true keeps that from
# ending the script and from printing the count twice.
echo "kamailio: trunk sources -> $(grep -c 'from_trunk) = 1' "$sources_file" || true) entr(ies)"

if [ "$check_only" = 1 ]; then
  # -c parses the file, loads every module it names and resolves every
  # function call, then exits before touching shared memory, sockets or the
  # database — so this needs neither the network nor the usrloc volume.
  exec kamailio -c -f /etc/kamailio/kamailio.cfg
fi

exec kamailio -DD -E
