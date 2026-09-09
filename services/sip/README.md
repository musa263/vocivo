# Vocivo SIP edge

Kamailio (registrar, WSS, fork), RTPEngine (media), and FreeSWITCH (Telnyx PSTN gateway). Telnyx is only an Elastic SIP trunk. Internal calls stay on this host and are not billed as Telnyx Call Control.

Production web and iOS stay on the Telnyx SDK until `VOCIVO_VOICE_EDGE=sip` is set on Vercel **and** this stack is reachable.

## Host

Always-on VM with a public IPv4, UDP/TCP 5060, TLS 5061, HTTPS 443 (WSS `/ws` to Kamailio on loopback 8080), and RTP `${RTP_START}`–`${RTP_END}`. Terminate TLS on nginx/Caddy as `sip.<domain>`.

## Run

```bash
cp .env.example .env
# set PUBLIC_IP, SIP_EDGE_SECRET, VOCIVO_API_URL, Telnyx gateway credentials
docker compose up -d
```

`SIP_EDGE_SECRET` must match Vercel. Kamailio authenticates REGISTER against `POST /api/voice/sip-auth`. Missed contacts call `POST /api/voice/sip-wakeup`.

## Telnyx trunk

Create an FQDN or IP connection in Mission Control pointing at this host. Put the SIP username/password (or IP ACL) in `.env`. Outbound E.164 from registered clients is bridged to `sofia/gateway/telnyx/+E164`.

The gateway lives on the `trunk` sofia profile (`sip_profiles/trunk.xml`), bound to `PUBLIC_IP:5082`, not on
`external`: `external` is bound to loopback so the switch cannot be reached from the internet, and a socket bound
to loopback cannot send to the carrier either — with the gateway there it pinged itself DOWN and every outbound
bridge failed with "Gateway is down". `trunk` refuses any new INVITE that does not come from loopback
(`apply-inbound-acl=loopback.auto`); it only ever carries the calls it started. Inbound from the carrier arrives
at Kamailio on 5060. `sofia status gateway telnyx` should say `State UP`.

Inbound DIDs stay on the existing Call Control application until `VOCIVO_SIP_INBOUND=1` on both Vercel and this host. See [ADR 0003](../../docs/adr/0003-self-hosted-sip-edge.md).

## Isolated protocol validation

On a Linux host with Docker, run `python3 services/sip/tests/validate_edge.py`
from the repository root. The `SIP protocol validation` GitHub Actions workflow
runs the same gate for SIP changes and can be dispatched manually.

The gate reads the pinned Kamailio image from Compose and checks the complete
production configuration using `KAMAILIO_CHECK_ONLY=1`, with networking disabled
and dummy environment values. It then starts a temporary loopback-only listener
on ports 15060 and 8080 using the production ingress rules through OPTIONS.
UDP, TCP and WebSocket probes cover valid requests, missing required headers,
CSeq errors, exhausted hop counts and the WebSocket Content-Length exception.
The temporary container is removed on success or failure. Ports must be free.

The delivery phase also exercises registrar and transaction routing with local
SIP peers, including delayed registration, answer/ACK/BYE, cancellation, and
expiry. It replaces admission and media with fixtures; it does not prove live
authentication, RTP, carrier routing, or native behavior. It needs no production
credentials and does not deploy anything.

The gate reproduces the previous suspended-transaction failure before testing
180 Ringing, 200/ACK/BYE, registration after 9/20/40 seconds, late second-device
delivery, duplicate registration, concurrent callers, CANCEL, and expiry.

## Extension ringback and answer delivery

An already-registered receiver is relayed immediately. Only calls with no
contact are suspended while push wakes a device. REGISTER drains the AOR's
bounded pending-transaction queue and calls `t_continue` before forwarding the
invitation; active transactions use TSILO for additional device contacts.
The AOR lock covers contact lookup through transaction storage, so registration
cannot fall between them. Each waiting entry has its own 45-second deadline;
the queue expires independently and retains simultaneous callers.

A suspended call answers its caller straight away with `180 Ringing`, before
the push goes out. Without it the caller had only tm's automatic `100 Trying`
— which starts no ringback and shows no state — for as long as the push, the
app launch and the REGISTER took, while the callee's CallKit screen was already
ringing; callers read that silence as a call that had not been placed. The
provisional is issued *after* `t_suspend`, which keeps the `100 Trying` that
`t_suspend` itself sends, and it carries no SDP so the caller generates its own
ringback rather than having early media bridged through FreeSWITCH for a call
that never touches it. The receiver's own 180 still travels afterwards under a
different To-tag; that second early dialog is what any forking proxy produces.

Never append receiver branches to a transaction left in `t_suspend`:
Kamailio 5.8.4 discards the responses a *branch* sends back while
`T_ASYNC_SUSPENDED` remains set. That loses both the 180 that starts web/mobile
caller ringback and the receiver's 200 answer. A reply the script generates
itself is not relayed from a branch and is unaffected. The resumed route must
not rerun `rtpengine_manage` in its failure context, which would delete the
already-created media offer.

The 45-second ring window is measured from the INVITE, not from the push, so
the push, the app launch and the REGISTER all come out of it. It is set in two
places that have to move together — `t_set_max_lifetime` here and
`WAKE_TTL_SECONDS` in `api/_lib/features/sip/routes/voice-sip-wakeup.ts` — and
because ours starts earlier, a call answered in the last seconds of the phone's
own ringing can find the transaction already gone.

WebRTC offers/answers use `rtcp-mux-offer rtcp-mux-require` and
`UDP/TLS/RTP/SAVPF`. The old `RTCP-MUX` flag was rejected by the running
rtpengine and did not enforce the requested multiplexing behavior.


## Clients

- Web: SIP.js over `VOCIVO_SIP_WSS_URI` when `VOCIVO_VOICE_EDGE=sip`.
- iOS: Telnyx SDK remains the default. Vocivo SIP + CallKit is used only when the native module is linked.

## Addresses, and the two mistakes that made every call end at 32 seconds

Kamailio binds `0.0.0.0` and **advertises `PUBLIC_IP:5060`** on its public
sockets (`kamailio/docker-entrypoint.sh` renders `/etc/kamailio/listen.cfg`).
Without the advertised address every Record-Route it added said `0.0.0.0`, and
the carrier had nowhere to send its ACK.

FreeSWITCH's `external` profile (`sip_profiles/external.xml`) is loopback-only
and **must not set `ext-sip-ip`**: 127.0.0.1 is not in sofia's `localnet.auto`,
so with it set every Contact and Via carried the public address, where no
profile listens. Kamailio additionally forces any in-dialog request for port
5080 to `127.0.0.1:5080`. Either fault alone leaves FreeSWITCH waiting for an
ACK that never arrives and hanging up when its timer expires — 32 seconds into
every answered inbound call.

Other things `kamailio.cfg` gets right that are easy to break:

- In-dialog requests (`has_totag()`) are handled *before* the INVITE block,
  so a re-INVITE (hold, ICE restart) is never treated as a new call.
- The answer's media profile is chosen for the side it travels *to*: `FLT_WS`
  marks requests from the WebSocket port, and `MANAGE_REPLY` rewrites the
  answer as DTLS-SRTP/ICE for them and plain RTP/AVP for the switch and the
  carrier. A web phone's Contact is aliased on replies too.
- `sounds/hold-music.wav` is what callers hear while waiting; the API's
  dialplan names it as `ringback` and `hold_music`.

`Ops · Droplets → call-trace` prints the receptionist's turn timings, FreeSWITCH
hangups and Kamailio's INVITE/ACK/BYE path for the last calls; `logs` is the
general log. GitHub keeps ten annotations per step, so both are kept compact.

Kamailio persists extension-call events in the SQLite outbox at
`/var/lib/kamailio/cdr.db` on its existing data volume. Startup initializes the
table in WAL mode. The timer reads up to 50 due events, removes only HTTP 2xx
deliveries, and defers failed deliveries for 60 seconds. Restarting the process
does not discard queued events. Keep this private call metadata on the host;
the outbox is not an indication that the API has accepted a record. Run
`test_cdr_outbox.py` and the pinned-image ingress gate after changing this path.

## Inbound over the trunk

Kamailio tags a call it accepted from the carrier with `X-Vocivo-Flow: inbound` and forwards it to FreeSWITCH
on loopback, like every other call. FreeSWITCH asks the API for the dialplan through `mod_xml_curl`
(`autoload_configs/xml_curl.conf.xml`, installed by the entrypoint while `VOCIVO_SIP_INBOUND=1`): office
hours, voice menus, ring groups, queues, the receptionist and voicemail are rendered by
`frontend/api/_lib/features/sip/sip-dialplan.ts`, prompts stream from `/api/voice/sip-prompt` in Vocivo's own voice, and
voicemail is pushed back with `http_put`. When the binding gives no answer the static `vocivo-inbound-*`
extensions in `dialplan/public.xml` ask `/api/voice/sip-inbound` for a single routing decision instead.
`Ops · Droplets → status` lists the FreeSWITCH modules this needs; each must say `true`.

Two switches, both off by default, and a call is only accepted when both are on:

- `VOCIVO_SIP_INBOUND=1` — also set on the API (Vercel), which is what makes
  `/api/voice/sip-inbound` return a routing `action` instead of `call_control`.
- `VOCIVO_TRUNK_SOURCES` — the carrier's signalling addresses and ranges,
  comma- or space-separated. Anything not on this list sending an E.164 INVITE
  to public 5060 is refused, because that is what toll fraud looks like.

Telnyx publishes its SIP signalling ranges per region
([support.telnyx.com](https://support.telnyx.com/en/articles/1130687-whitelisting-telnyx-ip-addresses)).
For a US account the calls actually arrive from the region's **SIP IPs** — the first
inbound call came from `192.76.120.10`, which is not inside the address pools —
so list those as well as the pools:

```
VOCIVO_TRUNK_SOURCES=192.76.120.10,64.16.250.10,192.76.120.128/26,192.76.120.192/27,64.16.250.0/24
```

Add the EMEA (`185.246.41.0/26`) or APAC (`103.115.244.0/26`) range only if the
account's numbers are anchored there — every range added is a range that may
originate a call on the account.

The list is rendered into `/etc/kamailio/trunk-sources.cfg` at container start
and included by `kamailio.cfg`, so `docker compose logs kamailio` reports how
many entries were accepted and names any it could not parse.

## Diagnostic accuracy and expired authentication

Use `gh workflow run ops-sip-edge.yml -f action=call-trace -f host=sip`.
The default window is two hours; `-f since=30m` changes the container-log window.
FreeSWITCH file output is a bounded tail and can contain older startup entries.
The action does not query the database or automatically correlate a SIP Call-ID.
Its Kamailio filter includes ACK/UPDATE/PRACK and preserves rejections from the
listed carrier/loopback sources without using unsupported grep lookahead.

For media diagnostics use `docker compose logs --since 10m rtpengine coturn`
from the deployed SIP directory. RTPEngine performs WebRTC/carrier media
interoperation; coturn provides STUN/TURN relay connectivity. No matching errors
is not evidence of two-way RTP. The `internal` FreeSWITCH profile is disabled;
inspect `sofia status` and trace the active `external` or `trunk` profile for the
leg under investigation. Packet capture, profile tracing, and two-way audio
acceptance require a bounded reproduction on the host and actual clients.

The matching auth API reports a verified expired Digest with `stale: true`.
Kamailio returns a fresh nonce with `stale=true`, allowing SIP.js's bounded stale
challenge retry. It resets challenge variables for each request and rejects
missing/malformed nonce responses with 503. Replay, identity, and current-access
checks remain enforced. This is local code coverage until the changed config has
passed the pinned Kamailio parser and a REGISTER/401/REGISTER/200 wire test.

## WSS connectivity diagnostics

Run `gh workflow run sip-connectivity.yml` for read-only proxy directives,
listener/firewall status and aggregate Nginx/Kamailio error categories. It excludes
credentials and raw SIP packets. Transport correlation uses the last REGISTER on
each worker and is diagnostic evidence, not proof of client identity. DigitalOcean
cloud firewall rules need separate access. `call-trace` continues past empty or
unavailable service logs and labels those sections, rather than aborting before
Kamailio output. An empty section must not be read as a healthy service.

## Authentication service failures

AUTH and CHALLENGE require the expected HTTP status and valid decision/nonce
JSON. Kamailio's HTTP client can return a positive libcurl error (28 for a
timeout); it is not an HTTP success or a wrong password. Unavailable or invalid
responses return SIP 503, without minting another nonce or advertising a password
challenge. Only a valid HTTP 403 / `ok:false` response reaches Digest recovery.
The loopback auth phase of `validate_edge.py` exercises these production routes,
including timeout/recovery, stale nonce, and malformed or inconsistent responses.

Internal route authorization also clears response state and requires HTTP 200
before reading route fields. HTTP 403 denies admission; HTTP failures or missing
route decisions return 503. A previous worker request's route can never authorize
a later request whose HTTP lookup failed. The loopback gate covers timeout after
success, denial, malformed responses, server failure, and recovery.

The same hazard reaches the call records, and is handled the same way. A script
variable belongs to a worker process rather than to a message and keeps its
value until that process next writes it, so a reply or a failure — handled by
whichever process received it, not the one that routed the INVITE — must not
read the route token or the dialled user out of one. Both are passed to
`CDR_ENQUEUE` in variables the enqueuing route sets, and the reply and failure
routes set them empty: a record for an answered or failed call carries the
call id, the parties and the event, and the API joins it to the INVITE's own
row rather than to whatever that worker last saw.

## Inbound audio diagnostics

The `Inbound audio diagnostics` workflow accepts a FreeSWITCH channel UUID.
It reads the retained call log, receptionist stages, runtime RTP port range,
selected SDP media fields and PCM statistics for the exact greeting files used.
It does not place calls, restart services, alter routing or export caller audio.
Missing retained logs are reported as missing evidence. File energy and playback
commands do not establish that RTP reached the caller; confirm with a handset
and, where necessary, live media counters or a scoped capture.

## Shared carrier IP connectivity

### Temporary carrier audio acceptance

`tests/temporary_carrier_pbx.py` is an explicitly operated, isolated IP-auth
carrier test. It does not activate a portal trunk, select a tenant, modify a
firewall, or stop an existing PBX. `prepare` takes the real local public IP,
carrier IP, one E.164 DID (digits), its national spelling, and an authorized
caller ID. It downloads a checksum-pinned official Docker runtime into
`/opt/vocivo-carrier-test`, starts a separate daemon without bridge/NAT/firewall
changes, and pulls the digest-pinned FreeSWITCH image. It needs Linux x86_64,
systemd, root and 12 GiB free. No platform/carrier credentials are used.

`start` checks SIP 5062, loopback ESL 18021 and UDP 9900–9919 are free, then
starts the test profile. Only the specified carrier IP and DID can enter the
tone/echo dialplan. It has no outbound bridge or SIP registrations. ESL uses a
random private password; files remain root-only. `call COUNTRY_CODE_DIGITS`
places exactly one explicitly authorized outbound call; it never retries. The
answer plays a short tone and echoes caller audio, ending after 35 seconds.
`reports` prints selected call/RTP counters without telephone numbers; private
CDRs remain on the host. A human must confirm audible tone/echo and caller ID.

Use `status` and `reports`, then `stop` to stop the container and temporary
daemon. The daemon also expires after two hours. Its private test directory
is retained for inspection and must be removed after evidence retention is
decided. There is no automatic 3CX cutover: inbound testing on occupied 5060
requires a separately verified idle-call check and timed restoration procedure
before any service interruption. Existing tenant destinations stay unassigned.

Run `python3 -m unittest discover -s services/sip/tests -p 'test_*carrier*.py'`.
These tests validate the restricted configuration and input contract. Local
Docker SIP/RTP acceptance and actual carrier/handset acceptance are distinct.

`Carrier connectivity diagnostics` accepts the carrier IPv4/UDP port and the
customer's expected public IPv4. It sends at most two SIP OPTIONS requests per
target from the deployed edge, reports the socket source address and matching
SIP response code, then checks whether the configured operations SSH identity can
access the customer host. It places no calls and changes no services, DNS, trunk
permissions or PBX routes. No response can mean carrier filtering or lack of
OPTIONS support; a response does not prove authorized calls or two-way media.
An expected IP in the portal cannot change the network source IP of another host.

Set `customer_ssh_via_edge=true` when customer SSH is restricted to the existing
Vocivo edge. The runner uses that edge as an SSH jump host; its private operations
key stays on the runner and SSH agent forwarding is not enabled. A reachable
host can still reject that identity. Provisioning access or changing a firewall
requires separate authorization; the diagnostic workflow does neither.

Run `python3 -m unittest discover -s services/sip/tests -p test_carrier_connectivity.py`
for the bounded-probe tests; those tests use socket fixtures.

## Tenant-owned carriers

For a temporary carrier egress test beside an existing PBX,
`tests/temporary_carrier_relay.py` renders a separate outbound-only FreeSWITCH
profile. It requires Digest authentication, the exact Vocivo peer address, and
the published tenant caller IDs before bridging to the specified carrier.
It anchors RTP on the actual relay host, disables REGISTER, bounds calls to
180 seconds, and never modifies 3CX or any existing DID destination.

`tests/relay_operations.py` implements fixed install/remove actions. The
`Temporary carrier relay` workflow uses the existing operations SSH identity
and private `VOCIVO_TEMP_CARRIER_TEST` JSON. Authorize that identity on the
relay with an expiry and a source restriction before using it. The original
prepared isolated Docker runtime must be stopped. Use unused SIP/ESL ports and
a dedicated RTP range outside the existing PBX range; permit only the Vocivo
peer for new relay SIP traffic. Timers are armed before listeners/gateways are
installed. Activation requires the matching API expiry support and an
outbound-only operator deployment record with the same deadline. Remove the
record, temporary gateway, relay, SSH entry, cloud firewall exceptions and
temporary repository secret when done. Retain private evidence only as needed.
No workflow here claims carrier or handset acceptance, or moves the public IP.

Ingress Digest credentials terminate at Kamailio after admission. Both
`Authorization` and `Proxy-Authorization` are consumed before the loopback
FreeSWITCH hop; signed Vocivo route headers remain for API authorization.
FreeSWITCH otherwise challenges credentials from the previous hop even with
`auth-calls=false`. Run `python3 services/sip/tests/validate_forward_auth.py`
for the isolated real-protocol regression and ingress rejection checks.

Temporary gateway proxy and From domain name the relay, so OPTIONS as well as
INVITEs target that host. Carrier Digest realm and carrier egress remain on the
relay. After `remove`, the explicit `archive` action verifies removal and retains
closed test evidence before a fresh bounded test can be installed.
The `diagnose` action reads at most six temporary relay call records and emits
only UUIDs, hangup/codec fields and SDP media descriptions. It excludes SIP
credentials, ICE credentials, media keys and unrelated PBX records.

Authorized outbound dialplans export the carrier codec list with `nolocal:` so
it applies to the new gateway channel. A plain `set` affects the originating
channel and can leave the carrier offer Opus-only. The tenant-carriers wire gate
also calls from an Opus-only endpoint to a G.711-only peer and verifies media in
both directions through FreeSWITCH transcoding.

Gateway deployment verifies the exact gateway name and its `trunk` profile after
rescan; a successful reload response alone is insufficient. Keep an included
gateway's `<include>` wrapper on separate lines: FreeSWITCH's preprocessor can
silently discard a compact single-line include. `repair-gateway` republishes only
the existing temporary gateway and preserves its active expiry timer.
`python3 services/sip/tests/validate_gateway_load.py` reproduces the compact-XML
failure and checks the generated gateway with production startup in isolated
Docker. It sends no traffic outside that container.

Run `python3 services/sip/tests/validate_relay.py` with local Docker. It uses
network-isolated loopback fixtures to test Digest, invalid passwords, source
and caller-ID rejection, destination normalization and actual RTP echo. The
core needs to finish startup before INVITEs; an early 503 is not readiness.
Reference: [Sofia profiles](https://developer.signalwire.com/freeswitch/users-and-endpoints/sip-profiles/)
and [gateway authentication](https://developer.signalwire.com/freeswitch/users-and-endpoints/gateways/).

The authenticated XML binding now selects outbound gateways from a signed tenant
route, including when inbound SIP is disabled. Static outbound fallback returns
503. Operator gateway files live in `/opt/vocivo/carriers`, outside source sync,
and are loaded under the public trunk profile. Company forms alone cannot
activate them. FreeSWITCH is pinned to the previously deployed 1.10.12 image.

See [tenant carrier activation](../../docs/runbooks/tenant-carrier-trunks.md) for
IP ownership, registration/TLS, inbound-port requirements, deployment records,
rollback and real-carrier acceptance. The Docker tenant-carriers workflow checks
actual SIP, RTP echo, caller ID, gateway isolation and capacity against loopback
peers. It does not certify Go Telecom, physical devices or inbound deployment.
