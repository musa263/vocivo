#!/bin/sh
set -e
vanilla=/usr/share/freeswitch/conf/vanilla
if [ ! -f /etc/freeswitch/freeswitch.xml ]; then
  mkdir -p /etc/freeswitch
  cp -a "$vanilla/." /etc/freeswitch/
fi
mkdir -p /etc/freeswitch/autoload_configs /etc/freeswitch/sip_profiles /etc/freeswitch/dialplan /etc/freeswitch/directory /etc/freeswitch/tls
cp /opt/vocivo-fs/autoload_configs/switch.conf.xml /etc/freeswitch/autoload_configs/switch.conf.xml
cp /opt/vocivo-fs/autoload_configs/event_socket.conf.xml /etc/freeswitch/autoload_configs/event_socket.conf.xml
cp /opt/vocivo-fs/autoload_configs/console.conf.xml /etc/freeswitch/autoload_configs/console.conf.xml
cp /opt/vocivo-fs/sip_profiles/external.xml /etc/freeswitch/sip_profiles/external.xml
cp /opt/vocivo-fs/sip_profiles/internal.xml /etc/freeswitch/sip_profiles/internal.xml
cp /opt/vocivo-fs/sip_profiles/trunk.xml /etc/freeswitch/sip_profiles/trunk.xml
mkdir -p /etc/freeswitch/sip_profiles/carriers
for gateway_file in /etc/freeswitch/sip_profiles/carriers/byoc_*.xml; do
  [ -f "$gateway_file" ] || continue
  rm "$gateway_file"
done
if [ -d /opt/vocivo-carriers ]; then
  for gateway_file in /opt/vocivo-carriers/byoc_*.xml; do
    [ -f "$gateway_file" ] || continue
    cp "$gateway_file" /etc/freeswitch/sip_profiles/carriers/
  done
fi
cp /opt/vocivo-fs/dialplan/public.xml /etc/freeswitch/dialplan/public.xml
cp /opt/vocivo-fs/dialplan/default.xml /etc/freeswitch/dialplan/default.xml
cp /opt/vocivo-fs/directory/default.xml /etc/freeswitch/directory/default.xml
# sed was doing this, with # as its delimiter and the value dropped into the
# replacement unquoted: a password or an edge secret containing a # ended the
# expression in the middle of itself, and an & or a backslash in one was
# reinterpreted by sed rather than written out — the rendered file then held a
# credential that was not the credential, and the failure appeared later as an
# authentication error nobody could explain. awk is handed the value through
# the environment, which does no escape processing at all, and copies it byte
# for byte.
substitute() {
  VOCIVO_PLACEHOLDER="$1" VOCIVO_VALUE="$2" awk '
    BEGIN {
      placeholder = ENVIRON["VOCIVO_PLACEHOLDER"]
      value = ENVIRON["VOCIVO_VALUE"]
      # Every file rendered here is XML, and a value carrying an ampersand or a
      # quote would produce a document FreeSWITCH refuses to parse — which does
      # not cost one credential, it costs the switch.
      gsub(/&/, "\\&amp;", value)
      gsub(/</, "\\&lt;", value)
      gsub(/>/, "\\&gt;", value)
      gsub(/"/, "\\&quot;", value)
    }
    {
      line = $0
      out = ""
      while ((at = index(line, placeholder)) > 0) {
        out = out substr(line, 1, at - 1) value
        line = substr(line, at + length(placeholder))
      }
      print out line
    }' "$3" > "$3.rendered" && mv "$3.rendered" "$3"
}

for profile in /etc/freeswitch/sip_profiles/external.xml /etc/freeswitch/sip_profiles/trunk.xml; do
  substitute '$${TELNYX_SIP_HOST}' "${TELNYX_SIP_HOST:-sip.telnyx.com}" "$profile"
  substitute '$${TELNYX_SIP_REALM}' "${TELNYX_SIP_REALM:-sip.telnyx.com}" "$profile"
  substitute '$${TELNYX_SIP_USERNAME}' "${TELNYX_SIP_USERNAME:-}" "$profile"
  substitute '$${TELNYX_SIP_PASSWORD}' "${TELNYX_SIP_PASSWORD:-}" "$profile"
  substitute '$${PUBLIC_IP}' "${PUBLIC_IP:-127.0.0.1}" "$profile"
done
# public.xml needs no substitution: its one API lookup goes to the local nginx
# edge proxy, which holds the edge secret, precisely so that no credential ends
# up in a dialplan action — FreeSWITCH prints those, arguments expanded, into
# freeswitch.log, and the ops actions read that file.

# The Event Socket is how fs_cli originates calls, records channels and runs
# system commands, and its password was the stock ClueCon. Only the loopback
# bind stood between that and anything else on this host — but every container
# here is network_mode: host, so the speech engine and the receptionist (both
# of which pull PyTorch and its dependency tree) share that loopback. One
# compromised wheel would have been a full switch console. The password is new
# on every start and never leaves this container; fs_cli reads it from the
# files below, so the ops actions keep working without knowing it.
esl_password=$(od -An -N24 -tx1 /dev/urandom | tr -d " \n")
if [ -z "$esl_password" ]; then
  echo "Vocivo: could not generate an Event Socket password; refusing to start with the default one" >&2
  exit 1
fi
substitute '$${VOCIVO_ESL_PASSWORD}' "$esl_password" /etc/freeswitch/autoload_configs/event_socket.conf.xml
printf '[default]\nhost => 127.0.0.1\nport => 8021\npassword => %s\n' "$esl_password" > /etc/fs_cli.conf
chmod 600 /etc/fs_cli.conf
# fs_cli reads $HOME/.fs_cli_conf before /etc/fs_cli.conf, and the ops actions
# run it as whoever docker exec lands them as.
if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
  cp /etc/fs_cli.conf "$HOME/.fs_cli_conf"
  chmod 600 "$HOME/.fs_cli_conf"
fi

# The image ships no CA bundle at all (every HTTPS request from FreeSWITCH
# failed with curl error 77), so the host's bundle is mounted in by compose and
# copied to where FreeSWITCH's own modules look for one: $${certs_dir}/cacert.pem.
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  cp /etc/ssl/certs/ca-certificates.crt /etc/freeswitch/tls/cacert.pem
else
  echo "Vocivo: no CA bundle at /etc/ssl/certs/ca-certificates.crt; HTTPS from FreeSWITCH will fail" >&2
fi

# The module list is rebuilt from the vanilla one at every start rather than
# edited in place, so what loads never depends on what an earlier version of
# this script left behind in the volume.
#   mod_xml_curl   the API renders the inbound dialplan (only while inbound is on)
#   mod_http_cache prompts stream from the API; voicemail is pushed back with http_put
#   mod_shout      mp3 prompts, when the API has no wav to give
#   mod_curl       the static fallback dialplan's API lookup
#   mod_flite      the static fallback dialplan's voice
#   mod_json_cdr   every finished leg is posted to the API as the tenant's call record
#   mod_opus       both profiles advertise OPUS and the API asks for it by name in
#                  absolute_codec_string; stock modules.conf.xml ships it commented
#                  out, so a browser leg on Opus had nothing to transcode to PCMU
#                  with and the carrier leg was negotiated down or failed outright
# mod_verto and mod_signalwire go: verto listens on the public address for a
# WebRTC client this edge does not use, and signalwire phones home every minute.
modules_conf=/etc/freeswitch/autoload_configs/modules.conf.xml
cp "$vanilla/autoload_configs/modules.conf.xml" "$modules_conf"
sed -i -e '/<load module="mod_verto"\/>/d' -e '/<load module="mod_signalwire"\/>/d' "$modules_conf"
wanted="mod_http_cache mod_shout mod_curl mod_flite mod_hash mod_opus"
if [ -n "${SIP_EDGE_SECRET:-}" ]; then
  # Call records go to the API whether inbound is on this edge or not: the
  # outbound and internal legs are here either way.
  cp /opt/vocivo-fs/autoload_configs/json_cdr.conf.xml /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  substitute '$${VOCIVO_API_URL}' "${VOCIVO_API_URL:-https://vocivo.app}" /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  substitute '$${SIP_EDGE_SECRET}' "${SIP_EDGE_SECRET}" /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  mkdir -p /var/log/freeswitch/json_cdr
  wanted="$wanted mod_json_cdr"
else
  rm -f /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  echo "Vocivo: SIP_EDGE_SECRET is not set; call records are not posted to the API" >&2
fi
if [ -n "${SIP_EDGE_SECRET:-}" ]; then
  : "${SIP_EDGE_SECRET:?SIP_EDGE_SECRET is required for the inbound dialplan binding}"
  cp /opt/vocivo-fs/autoload_configs/xml_curl.conf.xml /etc/freeswitch/autoload_configs/xml_curl.conf.xml
  substitute '$${VOCIVO_API_URL}' "${VOCIVO_API_URL:-https://vocivo.app}" /etc/freeswitch/autoload_configs/xml_curl.conf.xml
  substitute '$${SIP_EDGE_SECRET}' "${SIP_EDGE_SECRET}" /etc/freeswitch/autoload_configs/xml_curl.conf.xml
  wanted="mod_xml_curl $wanted"
  echo "Vocivo: SIP call routes are authorized by the Vocivo API dialplan."
else
  # No binding at all while the flag is off, so ordinary calls never wait on an API round trip.
  rm -f /etc/freeswitch/autoload_configs/xml_curl.conf.xml
  echo "Vocivo: SIP_EDGE_SECRET is missing; outbound calls cannot be authorized."
fi
extra=""
for module in $wanted; do
  if [ -f "/usr/lib/freeswitch/mod/$module.so" ]; then
    extra="$extra    <load module=\"$module\"/>\n"
    echo "Vocivo: loading $module"
  else
    echo "Vocivo: $module is not in this image; what depends on it will not work" >&2
  fi
done
awk -v extra="$extra" '/<\/modules>/ { printf "%s", extra } { print }' "$modules_conf" > "$modules_conf.tmp" && mv "$modules_conf.tmp" "$modules_conf"

# Voicemail is recorded here, pushed to the API, and deleted.
mkdir -p "${VOCIVO_SIP_RECORDINGS_DIR:-/var/lib/vocivo/recordings}"

exec /usr/bin/freeswitch -nc -nf -nonat
