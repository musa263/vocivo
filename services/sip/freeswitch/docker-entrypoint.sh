#!/bin/sh
set -e
umask 077
. /opt/vocivo-fs/render-env.sh
# Validate before command substitutions: a failed substitution inside sed's
# arguments does not itself make sed fail.
for value in "${TELNYX_SIP_HOST:-}" "${TELNYX_SIP_REALM:-}" "${TELNYX_SIP_USERNAME:-}" "${TELNYX_SIP_PASSWORD:-}" "${PUBLIC_IP:-}" "${VOCIVO_API_URL:-}" "${SIP_EDGE_SECRET:-}"; do
  render_value "$value" >/dev/null
done
SIP_EDGE_BASIC=$(printf 'vocivo:%s' "${SIP_EDGE_SECRET:-}" | base64 | tr -d '\n')
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
PUBLIC_IP_REGEX=$(printf '%s' "${PUBLIC_IP:-127.0.0.1}" | sed 's/\./[.]/g')
sed -i \
  -e 's#$${TELNYX_SIP_HOST}#'"$(render_value "${TELNYX_SIP_HOST:-sip.telnyx.com}")"'#g' \
  -e 's#$${TELNYX_SIP_REALM}#'"$(render_value "${TELNYX_SIP_REALM:-sip.telnyx.com}")"'#g' \
  -e 's#$${TELNYX_SIP_USERNAME}#'"$(render_value "${TELNYX_SIP_USERNAME:-}")"'#g' \
  -e 's#$${TELNYX_SIP_PASSWORD}#'"$(render_value "${TELNYX_SIP_PASSWORD:-}")"'#g' \
  -e 's#$${PUBLIC_IP}#'"$(render_value "${PUBLIC_IP:-127.0.0.1}")"'#g' \
  /etc/freeswitch/sip_profiles/external.xml /etc/freeswitch/sip_profiles/trunk.xml
sed -i \
  -e 's#$${SIP_EDGE_BASIC}#'"${SIP_EDGE_BASIC}"'#g' \
  -e 's#PUBLIC_IP_REGEX#'"$(render_value "${PUBLIC_IP_REGEX}")"'#g' \
  -e 's#$${VOCIVO_API_URL}#'"$(render_value "${VOCIVO_API_URL:-https://vocivo.app}")"'#g' \
  -e 's#$${SIP_EDGE_SECRET}#'"$(render_value "${SIP_EDGE_SECRET:-}")"'#g' \
  /etc/freeswitch/dialplan/public.xml

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
# mod_verto and mod_signalwire go: verto listens on the public address for a
# WebRTC client this edge does not use, and signalwire phones home every minute.
modules_conf=/etc/freeswitch/autoload_configs/modules.conf.xml
cp "$vanilla/autoload_configs/modules.conf.xml" "$modules_conf"
sed -i -e '/<load module="mod_verto"\/>/d' -e '/<load module="mod_signalwire"\/>/d' "$modules_conf"
wanted="mod_http_cache mod_shout mod_curl mod_flite mod_hash"
if [ -n "${SIP_EDGE_SECRET:-}" ]; then
  # Call records go to the API whether inbound is on this edge or not: the
  # outbound and internal legs are here either way.
  cp /opt/vocivo-fs/autoload_configs/json_cdr.conf.xml /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  sed -i \
    -e 's#$${VOCIVO_API_URL}#'"$(render_value "${VOCIVO_API_URL:-https://vocivo.app}")"'#g' \
    -e 's#$${SIP_EDGE_SECRET}#'"$(render_value "${SIP_EDGE_SECRET}")"'#g' \
    /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  mkdir -p /var/log/freeswitch/json_cdr
  wanted="$wanted mod_json_cdr"
else
  rm -f /etc/freeswitch/autoload_configs/json_cdr.conf.xml
  echo "Vocivo: SIP_EDGE_SECRET is not set; call records are not posted to the API" >&2
fi
if [ -n "${SIP_EDGE_SECRET:-}" ]; then
  : "${SIP_EDGE_SECRET:?SIP_EDGE_SECRET is required for the inbound dialplan binding}"
  cp /opt/vocivo-fs/autoload_configs/xml_curl.conf.xml /etc/freeswitch/autoload_configs/xml_curl.conf.xml
  sed -i \
    -e 's#$${VOCIVO_API_URL}#'"$(render_value "${VOCIVO_API_URL:-https://vocivo.app}")"'#g' \
    -e 's#$${SIP_EDGE_SECRET}#'"$(render_value "${SIP_EDGE_SECRET}")"'#g' \
    /etc/freeswitch/autoload_configs/xml_curl.conf.xml
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
