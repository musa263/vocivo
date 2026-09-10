# 1. Senior VoIP / SIP engineer — technical lead

**10 open items** — 2 High, 2 Medium, 2 Low, 4 Verify.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

services/sip/kamailio, services/sip/freeswitch, rtpengine and coturn configuration, carrier trunk routing, dialplans and transfers.

## First results to deliver

Prove Go Telecom inbound and outbound calling, correct caller ID, two-way audio, reliable hangup and correct extension routing. Eliminate silent calls and duplicate ringing.

## Required skills

- Hands-on FreeSWITCH dialplans, `mod_xml_curl` and Event Socket
- Kamailio registrar and dialog routing
- SIP Digest, REGISTER, INVITE, ACK, CANCEL and BYE
- Diagnosing traces with sngrep, Wireshark and tcpdump
- SDP, codecs, RTP/SRTP, ICE, DTLS, rtpengine and coturn
- IP-authenticated carrier trunks, number normalisation and caller ID; proving signalling and audio separately

## Start here

**SIP-1** and **SIP-2** — these are the items a customer feels on an ordinary call.

This role also reviews **BE-1** with the backend and security engineers. The API-side matching rule and the Kamailio trust list are two halves of the same defect, and neither half is safe to change without the other.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### SIP-1

**Where** — `services/sip/kamailio/kamailio.cfg:553-565 vs :505`

The kill switch is only checked on the E.164 branch. Carrier INVITEs addressed to an internal SIP username reach DELIVER_EXTENSION with only a from_trunk check, so disable-inbound does not stop inbound. During an incident calls keep arriving and keep waking devices after the operator believes inbound is off.

**Fix** — Add the same VOCIVO_SIP_INBOUND guard before route(DELIVER_EXTENSION).

#### SIP-2

**Where** — `services/sip/kamailio/kamailio.cfg:307-311, 341-353`

The scanner guard rejects only numeric From-users. Any alphabetic username (admin, sip, test, voip) reaches route(CHALLENGE), which makes a blocking http_client_query to the API with a 10 s connection timeout inside the SIP worker. A routine scan of open 5060 pins every worker and turns the edge into an amplifier against the API; real WebSocket REGISTERs queue behind it, which is the 1006 symptom already seen in production.

**Fix** — Derive the nonce locally (HMAC over username and expiry with a shared key) so CHALLENGE needs no API call, or rate-limit per source IP with pike/htable before CHALLENGE.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### SIP-3

**Where** — `services/sip/kamailio/kamailio.cfg:713, called from :798 and :772`

The CDR line quotes $var(rtok), which is private per worker process and survives across messages. Reply and failure routes run in whatever process took the reply, not the one that ran ROUTE_TOKEN for that INVITE, so an answered or failed CDR row can carry another tenant’s route token. $var(cdr_flow) is deliberately zeroed first; $var(rtok) is not. The same applies to $rU, which has no meaning on a reply.

**Fix** — Clear $var(rtok) at the top of MANAGE_REPLY and MANAGE_FAILURE, or carry the token in a transaction-scoped $avp()/$dlg_var().

#### SIP-4

**Where** — `services/sip/freeswitch/dialplan/public.xml:65-73 with :38-47`

In the static fallback plan a receptionist transfer re-matches vocivo-inbound-did, curls again, and lands back on the receptionist socket because vocivo_ai_unavailable is still empty. Whenever mod_xml_curl is unavailable a caller who asks for a person hears the greeting again, forever, and each pass opens another ESL connection.

**Fix** — Gate vocivo-inbound-ai on vocivo_from_receptionist being empty, and route vocivo_stage=ext-select to the staff bridge instead of the socket.

### Low — dead code, a cosmetic defect, or a latent hazard

#### SIP-5

**Where** — `services/sip/kamailio/kamailio.cfg:780-786`

The FreeSWITCH branch of MEDIA_OFFER is unreachable: FLT_FS is set only by FORK_FS and the in-dialog 5080 branch, neither of which precedes DELIVER_EXTENSION. Every non-FreeSWITCH leg is therefore offered SAVPF/ICE/DTLS. Correct while all endpoints are WebRTC, but the config reads as if a plain SIP handset is handled, and the first one to register gets one-way silence.

**Fix** — Delete the branch, or condition it on the callee transport after lookup.

#### SIP-6

**Where** — `services/sip/docker-compose.yml:18`

rtpengine runs with --timeout=60 while a wake-up ring can last 45 s plus resume. A session created at INVITE time that carries no media for the whole ring is close to the deletion threshold. The adjacent comment says two minutes, which is --silent-timeout, not --timeout.

**Fix** — Confirm the intended value against the ring budget and correct either the flag or the comment.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### SIP-7

**Where** — `sip_profiles/external.xml:19-20, trunk.xml:36-37, api sip-outbound-dialplan.ts:35`

All three advertise OPUS and export absolute_codec_string=PCMU,PCMA,OPUS, but freeswitch/docker-entrypoint.sh:66 does not add mod_opus to the wanted list and stock modules.conf.xml ships it commented out. If the image does not load it, an Opus-only browser leg cannot transcode to a PCMU carrier leg.

**Fix** — Check module_exists mod_opus on the droplet; add it to the entrypoint if absent.

#### SIP-8

**Where** — `services/sip/kamailio/kamailio.cfg:650-654 vs :597-598`

RESUME_WAKE keys the wake htable on $tu while DELIVER_EXTENSION keys it on "sip:" + $rU + "@" + realm. A client whose REGISTER To-URI carries a port or a transport parameter would never drain its pending calls. The identity check at :324 constrains $tU and $td but not the full URI.

**Fix** — Normalise both sides to the same constructed AOR.

#### SIP-9

**Where** — `services/sip/kamailio/kamailio.cfg:618-624, 655-663`

The waiter-list loops iterate with {re.subst,/^[^|]*[|]//}. An entry written without a trailing pipe makes the substitution a no-op and the while loop spins forever in a SIP worker. Only this script writes the table, so it is safe today, but it is one truncated write from a hung child process.

**Fix** — Bound the loop with a counter and log the malformed entry.

#### SIP-10

**Where** — `services/sip/freeswitch/dialplan/public.xml:21-29`

vocivo-telnyx-registered-client bridges any alphabetic destination to the platform Telnyx gateway, contradicting the rule stated two extensions above that a tenant call never falls back to a platform gateway. No route reaching it was found, so it reads as dead code, but it is a latent tenant-isolation hole.

**Fix** — Confirm unreachable and delete.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
