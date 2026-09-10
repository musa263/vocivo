# Vocivo SIP API

These handlers serve Vocivo's Kamailio/FreeSWITCH edge, not the Telnyx SDK.

| Entry | Responsibility |
| --- | --- |
| `voice-sip-credentials` | Issue device/session-scoped temporary credentials and ICE configuration; revoke an exact credential generation on DELETE |
| `voice-sip-nonce`, `voice-sip-auth` | Challenge Digest registration, verify identity and consume replay evidence |
| `sip-registration-auth::ownsSipRegistration` | Bind Digest username, From/To identity, realm and requested registration URI |
| `sip-credential-store` | Store/select only live credentials; allow safe credential overlap during renewal |
| `sip-call-authorization` | Validate signed call-route ownership before call admission |
| `voice-sip-inbound`, `voice-sip-dialplan` | Resolve inbound DID tenant and render its FreeSWITCH routing instructions |
| `voice-sip-wakeup` | Resolve destination devices and dispatch bounded native/Web Push wakeups |
| `voice-sip-cdr`, `voice-sip-hangup` | Record edge events and explicitly terminate a retained inbound leg |
| `voice-sip-prompt`, `voice-sip-voicemail` | Provide authorized spoken prompts and voicemail callbacks |

## What the rendered dialplan does for a waiting caller

`sip-dialplan.ts` renders every FreeSWITCH routing step the API decides:

- **Hold music instead of ringing.** `bridgeActions` sets `hold_music`,
  `ringback` and `transfer_ringback` to `holdMusic`
  (`/opt/vocivo-fs/sounds/hold-music.wav`, shipped with the edge in
  `services/sip/freeswitch/sounds/`), so a caller waiting on a bridge, a queue
  or a transfer hears music, looped for as long as the wait lasts.
- **A failed transfer goes back to the receptionist.** The receptionist sets
  `vocivo_from_receptionist=1` before it transfers; when nobody answers,
  `unavailableActions` sees `request.fromReceptionist` and renders
  `backToReceptionistActions` — `vocivo_transfer_failed=1` and a fresh
  `socket` to the receptionist, which says "no one's picking up, I can take a
  message" and continues the conversation. Without that flag the old path
  (voicemail, or the "no one is available" message) stands.
- **`voice-sip-hangup`** receives FreeSWITCH's `api_hangup_hook` for outbound
  PSTN legs (`services/sip/freeswitch/sip-hangup.sh`) and moves the reserved
  route to `ended`/`failed` with the billed seconds. Until it existed the hook
  404ed and routes stayed "connected" for two hours.

Edge callbacks require `sip-edge-auth`; customer APIs require the user's session.
No unknown DID or absent tenant is permission to select a default customer.
The corresponding server implementation is `services/sip/kamailio/kamailio.cfg`.
Strict registration identity changes must ship with that config before API promotion.

## Device credentials

`POST /api/voice/sip-credentials` accepts a stable `deviceId` and returns that ID
plus a new `credentialId`. The server derives `sessionId` from verified session
claims; a client cannot choose its credential owner. Rotation replaces only the
same device/session record, not every browser or every mobile device. The existing
limit remains six live credentials per extension.

`DELETE` requires the device and credential generation IDs. An old page cleanup
cannot revoke a newer rotation or another signed-in session. Web documents claim
exclusive device identities with Web Locks; native installations keep theirs in
SecureStore across sign-out. Legacy clients without device IDs receive separate
server-generated IDs rather than overwriting all other clients of the same type.

Deploy this API before distributing the updated mobile build. Mobile now requires
the returned ownership IDs. Reload old superadmin/browser tabs after deployment.
This does not close audit H05: current user/subscription access must still be
revalidated at REGISTER, and registrar contact revocation needs separate work.

Run frontend tests/typecheck. `sip-config.test.ts` is a structural guard, not a
Kamailio parser or real SIP-wire test; validate staged config in the pinned image.

## Registration recovery and queue budgets

The auth API distinguishes an invalid nonce from an expired, signed nonce. Only
an otherwise valid Digest from a currently allowed credential receives
`{ ok: false, reason: 'stale_nonce', stale: true }`. Kamailio turns that into a
fresh `401` challenge with `stale=true`; the expired request is never registered
and never consumes replay state. Invalid credentials and replayed Digests do not
receive the stale hint. Challenge JSON state is reset before each lookup, so a
missing nonce cannot reuse a previous request's nonce. Deploy the matching edge
configuration before promoting the API to enable recovery.

Queue bridge attempts share the configured `maxWait` ringing budget. The final
attempt uses only the remainder (including a one-second remainder); an exhausted
queue proceeds to its fallback without another bridge. Prompt playback and HTTP
callback time are additional to this ringing budget, not a wall-clock guarantee.

## SIP and relay renewal

The credentials response expiry describes the complete SIP/ICE configuration and
is capped at the earliest TURN REST deadline. Clients renew before that deadline;
the stored Digest credential retains its seven-day validity so deferred renewal
during an active call does not invalidate registration. Relay configuration is
validated before replacing the device credential, so an invalid TURN deployment
cannot rotate away a working password on a failed request.

CDR timestamps must fit JavaScript's supported date range. Invalid microsecond
values fall back to valid seconds; records without a valid start are unreadable,
and invalid end timestamps fall back to the start instead of throwing a retryable
server error. These boundaries are covered by the credentials-route and CDR tests.

REGISTER access reads the admin, subscription, and plan from one tenant snapshot.
It uses the existing schema without running SaaS bootstrap/DDL and fails closed
if persisted subscription data is missing. Current identity and uncached session
revocation checks remain mandatory. Slow auth requests (at least 1500 ms) log
phase durations and status only, without Digest material or user identifiers.

## Tenant carrier bridge authorization

`voice-sip-dialplan` now handles signed outbound grants through
`sip-outbound-dialplan` before applying the inbound feature flag. It rechecks
current caller-ID ownership and the exact tenant/trunk/revision/gateway binding.
A failed lookup cannot use the static Telnyx bridge. The XML declaration occupies
its own line for FreeSWITCH preprocessing; effective caller-ID channel variables
carry the authorized identity to the B leg. Codec lists are set outside the
dial string. Per-gateway hash limits release with channel teardown.

Kamailio strips incoming `X-Vocivo-Carrier-Source` and sets it from the admitted
carrier socket. Imported national DIDs resolve only within the source-bound
deployment and published assignment; disabled or unassigned DIDs do not answer.
Company destinations remain in the existing API-rendered inbound dialplan.
See the [BYOC rollout and acceptance gates](../../../../../docs/runbooks/tenant-carrier-trunks.md).

## September 2026 repair contracts

Call-record ingestion rejects conflicting tenant evidence. Kamailio route tokens
are accepted only on the initial event, with matching participants; subsequent
events use their Call-ID and parties. External simultaneous-ring and forwarding
legs invoke the shared outbound policy for the owning extension. Denial omits
that external leg and preserves the normal local ringing or unavailable fallback.
An unavailable BYOC gateway cannot select a platform carrier.

The legacy managed-DID lookup rejects ring-group, queue and IVR destinations when
the full XML plan is unavailable. It does not broaden membership or let a global
AI setting override an explicit extension. Both normal and fallback HTTP routes
require a provider-specific source match for managed DIDs. BYOC remains tied to
the deployed tenant gateway and published number.

FreeSWITCH callbacks are delivered by the durable `sip-outbox` service. See
`services/sip/README.md` for first-deployment data migration and coordinated edge
rollout. Core reply routing now handles failed SDP before final 200 responses can
escape; this needs the wire tests, not only the structural TypeScript guard.
Outbound hook UUID and billable seconds are deferred through both application
expansion passes until hangup. The Docker BYOC fixture verifies a positive final
duration for an answered call, not merely the presence of a hook in XML.
