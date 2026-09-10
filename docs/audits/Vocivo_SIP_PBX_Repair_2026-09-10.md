# SIP/PBX repair and validation record

Date: 10 September 2026. Baseline: `fd9f9ad2e1e2ad5383e91a22a9acecdd2ae1368f`.
This records working-tree repairs following the engineering and SIP/PBX audits.
It does not replace the historical findings or certify the live deployment.
Existing unrelated documents and patch files were preserved; those patches were
not applied. No customer calls, carrier purchases, production configuration
changes, image publication or deployment were performed by this repair run.

## Repairs implemented

| Finding | Owner | Resulting behavior and evidence |
|---|---|---|
| K1: port-bearing REGISTER misses waiting call | SIP | REGISTER and INVITE use the same canonical user/domain AOR. A real port-bearing REGISTER now resumes its waiting invitation. Existing duplicate-contact, cancellation and multiple-waiter tests still pass. |
| K2: worker-local route token contaminates another call's CDR | SIP/backend/security | Only initial admission events carry the route token. Later events use Call-ID and parties. Ingestion rejects conflicting tenant/participant evidence. A one-worker, interleaved-call test verifies the answer does not inherit another request's token. |
| K3: failed media rewrite still forwards SDP | SIP/media | Offers fail before delivery when RTPEngine is unavailable. The core reply hook suppresses unsuccessful answer rewrites before the transaction layer forwards a final success. Named TM reply callbacks cannot drop final 200 responses in the tested Kamailio version; the new wire regression checks this actual behavior. Successful rewrites and listener-direction selection also pass. |
| K4: unknown dialogs bypass initial admission | SIP/security | Unknown in-dialog requests fail closed; non-ACK requests receive 481 and unknown ACK is dropped. Known-dialog ACK, UPDATE and BYE remain deliverable. This requires draining calls before a non-persistent edge restart. |
| F1: external forwarding bypasses outbound restrictions | PBX/backend | Simultaneous external ringing and no-answer forwarding invoke the owning extension's outbound rules, department and international permission. Denied legs are omitted without preventing local ringing. Unknown destination regions cannot bypass an international restriction. |
| F2: edge ends PBX ringing at 45 seconds | SIP/PBX | The empty-contact wake window remains bounded. Once a trusted PBX leg reaches a registered contact, the edge permits the PBX's configured ringing duration up to 120 seconds. A real invitation remains answerable after 47 seconds; the original expiry tests also pass. |
| F3: managed fallback broadens group membership | PBX/backend | Legacy fallback rejects group, queue and IVR destinations instead of ringing the whole company. Direct targets must be active and tenant-owned; a global AI setting cannot override an explicitly assigned extension. BYOC still cannot fall back to a platform carrier. |
| F4: lost hangup callback leaves stale route state | PBX/SRE | The hook atomically persists a private, idempotently named job. The outbox delivers it independently of the channel and retains it on HTTP/transport failure. |
| F5: recreation discards CDR and voicemail failures | SRE/backend | Named volumes preserve CDR and recording/outbox paths. A separate worker retries CDR, hangup and voicemail delivery. Original signed voicemail metadata is validated before renewing an upload for the same tenant/call. Real HTTP 503 followed by container recreation and HTTP 201 verifies retention, replay and deletion after acceptance. |
| A1: saving a trunk restores a removed DID | Tenant administration/backend | Disabled number tombstones remain disabled; they cannot become the company's default outgoing number during publication. |
| A2: GET-to-PUT edit conflicts after DID removal | Tenant administration/backend | Read and edit comparison both represent a disabled number as unassigned. An unrelated trunk edit no longer conflicts solely because the DID was removed. |
| A3: failed publication saves an unusable trunk revision | Backend/storage | Trunk and PBX number publication share the existing multi-object database transaction. Limits and current revision are checked before commit. Tests verify failed publication preserves both old objects and stale publication fails. |
| A4: outbound-only deployment claims inbound readiness | Tenant administration/backend | Inventory requires deployed inbound sources, an enabled inbound direction and an assigned destination before reporting inbound capability. |
| T1: opaque extension delivery ignores inbound-disable flag | SIP | Carrier-originated extension delivery checks the inbound flag as well as source admission. |
| S1: managed DID lacks provider-specific source binding | SIP/security/backend | Managed lookup requires its own explicit IPv4/CIDR allowlist. An allowed BYOC source does not authorize an unrelated managed DID. Both dynamic and static fallback lookups enforce the source contract. |
| O1: secrets corrupt generated FreeSWITCH configuration | SRE/security | Environment values are escaped for XML and sed, and control characters are rejected before substitution. Static HTTP lookup uses a Base64 Basic header so raw secret characters cannot break its quoted command. Metacharacter and control-character regressions pass. |
| O2: diagnostics leave core debug verbosity enabled | SRE | The diagnostic workflow no longer changes the core logging level to debug. |
| AI1: configuration outage looks like no receptionist | AI/backend | Temporary/malformed configuration failures have a distinct exception. A trusted tenant/DID can enter a controlled unavailable fallback; missing identity fails closed. Disabled/not-found configuration retains its separate meaning. |
| AI2: recorder cleanup masks speech failure | AI | Recorder cleanup failure is logged without replacing the speech error, allowing the existing caller fallback to execute. |
| M1: final registration refusal prematurely ends mobile calls | Mobile/SIP | Final 401/403 enters the existing bounded recovery state. Active-call recovery requests fresh HTTPS credentials through single-flight bootstrap and same-identity in-place update. Repeated failure cannot extend the existing 45-second media grace; explicit sign-out still tears down voice. |
| W1: dependency outage becomes expired web authentication | Backend/web | Explicit identity/JWT rejection remains 401. Temporary session-authority, PBX configuration or subscription failure returns 503 with Retry-After and does not clear cookies. It preserves the client's retry path without authorizing requests through the outage. |
| Additional: outbound hangup duration expands too early | PBX/backend | UUID and billable seconds survive both FreeSWITCH application-expansion passes and expand at hangup. Actual paced calls on both tested versions produce durable records with positive final durations. |

These rows describe implemented repairs and their evidence, not a claim that
every possible SIP defect has been found or that every acceptance condition below
has passed in production.

## Validation completed

| Gate | Result |
|---|---|
| Root `bash verify.sh` | 510 backend/web tests; 156 mobile unit tests; 96 mounted mobile tests across 14 suites; API checks and builds passed. |
| SIP Python unit tests | 17 passed, including outbox, signed upload metadata and configuration escaping. |
| Receptionist Python suite | 91 passed, including temporary configuration failure and cleanup/fallback regressions. |
| Production Kamailio parser and existing ingress/auth/delivery suite | Passed against the pinned 5.8.4 image; UDP/TCP/WS ingress, Digest boundaries, delayed registration and transaction lifecycle covered. |
| `validate_repairs.py` | Nine positive/negative wire checks passed, including 47-second answer, unknown-dialog refusal, CDR interleaving, failed media offers/final answers and successful reply rewriting. |
| Browser `test-sip-ui.mjs` | Eight lifecycle/recovery scenarios passed: cancellation, late answer, real-180 ringback, call waiting refusal, BYE, fatal transport cleanup and idle recovery. SIP transport is a fixture. |
| `validate_forward_auth.py` | Passed on 1.10.12 and the 1.11.3 candidate. Previous-hop Digest headers are consumed; rejected/missing ingress remains challenged. |
| `validate_gateway_load.py` | Passed on both images. Generated gateway loads and OPTIONS target only the simulated relay. |
| `validate_byoc.py` | Passed on both images. Two tenant gateways, caller ID, denied capacity/invalid grants, released capacity, paced G.711 echo, Opus/G.711 transcoding and final hangup records verified. |
| `validate_outbox.py` | Actual HTTP 503 preserves all three job kinds; a recreated container recovers them from the same private Docker volume and removes them only after HTTP 201. No external network. |
| FreeSWITCH 1.11.3 feature gate | Required modules loaded; local generated audio was recorded; an event-socket disconnect resumed fallback and released the loopback channels. This used a simulated socket peer, not a live AI model. |

The BYOC fixture was improved to acknowledge/retransmit UDP transactions and wait
for observed capacity release instead of a fixed 300 ms delay. RTP is paced at
20 ms so a fast local echo cannot compress a call into a sub-second burst and
invalidate duration assertions.

Reproducible commands are in `services/sip/README.md` and
`services/sip/freeswitch/image/README.md`. The SIP validation workflow now includes
the additional wire, outbox, generated-BYOC and feature gates. It has been edited
locally; no remote CI run is claimed here.

## FreeSWITCH upgrade result

A Debian Bookworm amd64 image was built from FreeSWITCH revision
`ef32e205295e29f034f1453ad245ba5efb07b94a` and reported
`FreeSWITCH version: 1.11.3-release~64bit`. Sofia-SIP and SpanDSP revisions and the
Debian base image are pinned in the Dockerfile. The final runtime stage excludes
the build toolchain/source tree and checks shared-library resolution.

The candidate passed the local compatibility gates above. It has **not been
published or promoted into production Compose**, which retains the previous
1.10.12 digest. This avoids configuring an unavailable registry tag or replacing
an image without a published, tested artifact. Retain and publish the tested
image, record its registry digest and dependency inventory, then promote that
digest through the deployment acceptance below. Rebuilding against later Debian
package indexes is not a guarantee of byte-identical output.

The official release references used for the version assessment are the
[FreeSWITCH releases](https://github.com/signalwire/freeswitch/releases) and
[SignalWire's 1.11.3 announcement](https://support.signalwire.com/portal/en/community/topic/freeswitch-version-1-11-3-released).
Upgrading does not replace the custom routing, policy and durability repairs.

## Acceptance plan recorded before deployment

The deployment results below supersede the deployment steps in this initial plan;
carrier, device, retention and capacity acceptance remain open where stated.

1. Record the intended application SHA, image digests, current live containers,
   Nginx/WSS timeouts, firewall rules and Go Telecom deployment/source mapping.
   None of that live state was inferred from local configuration or older tests.
2. Coordinate API and edge changes. Configure `VOCIVO_MANAGED_TRUNK_SOURCES` only
   for deliberately retained managed-provider DIDs; empty denies that path.
   Global Heritage's Go trunk continues to use tenant deployment records and
   administrator-controlled destinations. No Go number or carrier activation
   state was hardcoded or changed by these repairs.
3. Drain calls before restarting Kamailio. Back up and copy existing CDR/spool
   and recording data before creating the new FreeSWITCH volume mounts. Existing
   `.failed` voicemail files do not contain the new signed metadata; retain and
   reconcile them separately. Merely adding a volume does not recover old files.
4. Define monitored queue-age/disk limits and tenant retention policy. Delivery
   retries and bounded batches are implemented; automatic deletion of undelivered
   customer records is deliberately not a substitute for a retention decision.
5. Publish/promote the tested FreeSWITCH image and run real Go inbound/outbound
   calls with distinct DID destinations, ringback, two-way speech, DTMF,
   cancellation, transfer/fallback, hold music and voicemail. Record correlated
   Call-ID/route/channel evidence. Real RTPEngine DTLS/SRTP, TURN, PRACK and ICE
   restart are not established by the local NG-control or RTP echo fixtures.
6. Ship a mobile build containing the changed registration code. Verify active
   credential renewal, actual revocation, Wi-Fi/cellular migration, background
   suspension and locked/killed answer on iOS and Android. A web/API deployment
   cannot deliver these mobile source changes. Gate A08 remains a device/live
   network acceptance gate, not a synonym for passing unit tests.

## Scope and remaining audit work

The unrelated office-hours timezone display and superadmin workspace AI-settings
findings from the earlier engineering audit were not changed in this SIP/PBX
repair. Open questions about internal route-grant replay/caller binding and
synchronous control-plane worker starvation still require dedicated negative and
load tests. At the initial audit revision, default loopback ESL credentials, the
unpinned RTPEngine image and Android global microphone restoration were separate
review items. The consolidated release includes the subsequent fixes for these
items; physical-device acceptance must still be demonstrated.

The current production FreeSWITCH pin therefore remains an upgrade task even
though the 1.11.3 candidate is locally compatible. Keep these remaining gates
visible instead of describing the whole live PBX as fully repaired.

## Consolidated release follow-up

The release merges `97d4ed6` (including `937e9a9` and `28a3350`) with the
repairs above. That preserves the newer native audio, tenant isolation,
receptionist resilience, RTPEngine digest pin and randomized ESL credential
changes. Embedded Global Heritage knowledge was removed by that merged work;
customer knowledge is supplied through tenant configuration.

The production-path placeholder scan found misleading admin infrastructure
and subscription defaults. The overview now uses published BYOC inventory,
shows the configured voice engine/domain, does not require Telnyx for a SIP/BYOC
overview, and represents unmeasured availability/missing subscriptions honestly.
The retired toll-free number was removed from the admin input hint. Normal form
instructions, configuration templates and isolated test fixtures remain required.
No dummy runtime response or simulated call success was introduced.

The Vercel release gate now requires PostgreSQL health and the expected commit
revision. SIP synchronization checks idle PBX/media state, backs up private
spools, migrates container-local data to named volumes, and starts FreeSWITCH
before reopening Kamailio. Legacy `.failed` audio remains preserved for explicit
reconciliation. Readiness claims still require actual carrier and device calls.

Validation after merging: 535 backend/web tests, 159 mobile unit tests, 102 mounted
mobile tests, 91 receptionist tests, 20 SIP/rollout unit tests; full root typecheck
and build gate passed. Docker validated the production parser, REGISTER wake and
late-contact branches, 47-second PBX ringing, ACK/UPDATE/BYE, tenant call-record
isolation, media failure suppression, BYOC audio/transcoding/capacity/final billing
duration, local speech/recording, and durable retry after HTTP failure/container
recreation. Browser checks covered SIP lifecycle, company-admin/superadmin number
assignments, and two-tab tenant isolation. Production deployment evidence is
recorded by the release workflows; these local results do not certify live Go
Telecom or physical mobile acceptance.

## Production release evidence — 10 September 2026

Runtime repairs were pushed to `main` as `b4718c07a2c79231944577caadfc8340646d5992`.
The deployment-check follow-up is `5b066d81fca57ab885adb6d821479044fe92f6b2`;
it changes only the Vercel workflow, not mobile or SIP runtime code.

| Release/check | Result and evidence |
| --- | --- |
| Main quality gates | [Passed](https://github.com/musa263/vocivo/actions/runs/34473100430); [workflow follow-up also passed](https://github.com/musa263/vocivo/actions/runs/34486358247). |
| Main SIP protocol validation | [Passed all three jobs](https://github.com/musa263/vocivo/actions/runs/34473100477): ingress, tenant carriers and temporary relay. These use isolated fixtures. |
| SIP configuration rollout | [Succeeded](https://github.com/musa263/vocivo/actions/runs/34472773324). Idle-call/media barrier passed; configuration backed up to `/opt/vocivo/sip-backups/20260910114326`, private state to `/opt/vocivo/sip-state-backups/1789040644205471194`. Existing data was retained in persistent volumes. |
| Live PBX status | [Verified](https://github.com/musa263/vocivo/actions/runs/34473090144): FreeSWITCH healthy; Kamailio, RTPEngine, TURN and outbox containers running; required modules loaded; zero active calls and zero rejected JSON CDR files at the check. |
| AI receptionist | [Deployed successfully](https://github.com/musa263/vocivo/actions/runs/34485706402); speech-recognition model loaded, listening on `127.0.0.1:8084`. This verifies service readiness, not an end-to-end AI call. |
| Web/API | [Final production deployment passed](https://github.com/musa263/vocivo/actions/runs/34486940967). Independent `/api/health?deep=1` request returned PostgreSQL available and exact revision `5b066d81fca57ab885adb6d821479044fe92f6b2`. |
| Public WSS | Independent WebSocket connection to `wss://sip.vocivo.app/ws` succeeded with negotiated subprotocol `sip`. The host root returns 404 and is not the WebSocket path. This does not prove authenticated registration or RTP. |
| iOS | [Production build 1.0.0 (68)](https://expo.dev/accounts/mousaothman/projects/vocivo/builds/d789f636-b4c6-44fe-9d1b-281406c3c194) finished; [submission to App Store Connect succeeded](https://expo.dev/accounts/mousaothman/projects/vocivo/submissions/4cec6823-1e6f-4db5-8576-831cb8eeac54). Apple processing/tester availability was not independently confirmed. |
| Android | [Production build 1.0.0 (versionCode 2)](https://expo.dev/accounts/mousaothman/projects/vocivo/builds/d701262c-53a5-4d1e-93eb-34521068bde0) finished. It has not been published to Google Play. |

Both mobile builds use `155987f8e5412de69d4393b457c35b124aa88600`; subsequent
commits change Linux test fixtures, packaging and deployment verification only.

The first Vercel run deployed successfully but failed its verification because
the generated deployment hostname returned a redirect rather than health JSON.
The corrected gate checks the customer-facing production alias and still requires
the exact release SHA and healthy PostgreSQL. Negative checks reject stale
revisions, unavailable storage and non-JSON responses.

Rollout warnings remain visible: Docker Compose warned that the migrated volumes
were created outside Compose, but mounted them successfully. FreeSWITCH emitted
scheduler/nice-permission warnings during startup and later passed readiness and
container health. Real-time scheduling under production load remains a capacity
acceptance item; privileges were not broadened merely to suppress the warnings.
The host status also reported UFW inactive; the effective DigitalOcean firewall
and host packet-filter rules require a separate verified policy assessment.

No Go carrier activation, number destination, IP migration, 3CX configuration or
paid call was changed by this release. Live status showed only the existing
managed gateway, so it does not establish an active Go Telecom interconnect.
Go inbound/outbound audio, distinct DID routing, physical-device Gate A08,
background/killed-state calling, load/retention controls and the remaining audit
items above are still open. The deployed API deliberately reports telephony
status as unchecked rather than inferring call success from HTTP health.
