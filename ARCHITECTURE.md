# Vocivo Architecture

Start with the [feature directory](docs/FEATURES.md) to find the code responsible
for a screen, API, or calling failure. Each feature has a README beside its code.
This document describes source boundaries, not a certification of production health.

## Runtime Map

```text
Web React / Mobile React Native
    | HTTPS: session, tenant, directory, routes, wallet, messages
    v
Vercel API -> PostgreSQL
    |
    +-- VOCIVO_VOICE_EDGE=telnyx -> Telnyx SDK + Call Control webhooks
    |
    +-- VOCIVO_VOICE_EDGE=sip -> SIP.js -> Kamailio -> RTPEngine
                                           |
                                           +-> FreeSWITCH -> tenant carrier / managed trunk -> PSTN
                                                  |
                                                  +-> Python receptionist / TTS
```

`frontend/api/_lib/features/calling/voice-provider.ts::voiceEdge()` selects SIP
only for the explicit value `sip`; otherwise it selects Telnyx. Read the live
environment and `/api/voice/config` to establish which path is deployed. Merely
finding a carrier library in the repository does not establish its active use.
Mobile requires an explicit valid engine in that API response. Its managed JS SDK
loads lazily and mounts only after authenticated managed-session preparation.
The SIP path uses Vocivo's client; the existing patched native VoicePnBridge is
still a compatibility dependency pending the next native migration stage.

Mobile requires an explicit valid engine response. Its Telnyx JavaScript runtime
loads lazily only for the authenticated managed path. SIP startup and refresh
use Vocivo's bridge without constructing that client. Native sign-in state and
push-token access now live in `VocivoSip`; build 64 introduces that contract.
The native Telnyx package remains a compatibility dependency for shared push
dispatch, Android entry points and ringtone handling until later Stage 2 work.

Vocivo owns the applications and their tenant, authorization, routing, wallet,
and administration logic. The SIP stack runs on the configured DigitalOcean
host; Vercel hosts the HTTP application. Telnyx remains an external carrier for
PSTN/SMS and, when selected, the managed calling engine. Internal SIP-edge calls
bypass Telnyx credit checks; managed-edge calls still depend on carrier service.

## Source Organization

- `frontend/src/features/<feature>/`: web screens, components, hooks and helpers.
- `frontend/api/_lib/features/<feature>/`: backend domain, stores, tests and `routes/`.
- `mobile/src/features/<feature>/`: mobile screens, context and feature logic.
- `frontend/src/shared/`, `mobile/src/shared/`: cross-feature API clients and UI primitives.
- `frontend/api/_lib/shared/`: HTTP, persistence, tenant context and carrier transport primitives.
- `services/{sip,receptionist,tts}/`: independently deployed infrastructure/services.
- `docs/`: cross-feature architecture, operational procedures and historical audits.

Public Vercel entry points stay in `frontend/api/` so URLs do not change when
implementation files move. `frontend/src/App.jsx` and `mobile/App.tsx` compose
features. Native code stays in `mobile/native/`, configured by `mobile/plugins/`;
generated iOS/Android project paths are not feature folders and must remain stable.

## Dependency Direction

```text
Screen -> Context/Hook -> Engine/Domain -> API or SDK adapter
HTTP entry -> Feature route -> Domain/Store -> Shared database or carrier client
```

Do not import screens from stores, place SQL in UI, or add hidden network calls
to a formatting helper. Cross-feature imports must name the owning feature.
Keep tests next to pure modules; mounted React Native integration tests live in
`mobile/tests/voip/`. `scripts/test-files.mjs` discovers nested unit tests.

## Calling Boundaries

Extension authority is separate from the selected voice engine. Legacy directories
use Telnyx telephony credentials; an explicitly adopted encrypted v3 directory
uses Vocivo's local lifecycle through `organizations/vocivo-extensions.ts`. Adoption
preserves existing IDs and SIP usernames, so account/history links do not change.
Both app and inbound SIP must be selected before adopting the directory. The
durable authority marker prevents an environment rollback from silently selecting
the old credential lifecycle; older binaries without v3 support are not a valid
rollback. `/api/voice/config` reports `extension_authority` separately from
`voice_edge`. See the [carrier-only migration runbook](docs/runbooks/vocivo-carrier-only-migration.md).

On the SIP edge, the client obtains a session-bound temporary SIP credential,
registers, requests a signed call route, then sends its INVITE. Kamailio validates
identity/route grants, looks up the destination and sends push wakes to registered
devices. The transaction accepts late registrations for a bounded 45-second
window. In-dialog messages follow tracked routes instead of requesting a new
one-use call grant. Unauthorised conference/REFER entry is rejected; this SIP
release does not advertise conference admission as available.

Once a trusted PBX leg reaches a registered device, its edge transaction budget
allows the PBX's configured ringing duration, up to 120 seconds. Unknown dialogs
fail closed; drain calls before replacing a non-persistent Kamailio instance.
Media conversion must succeed before forwarding SDP. The core reply hook checks
answers before Kamailio's transaction layer can relay a final success response.

FreeSWITCH hangup hooks persist private jobs, and failed JSON CDRs and voicemail
uploads remain on named volumes. The separate `sip-outbox` worker retries these
HTTPS deliveries using the existing idempotent API contracts. Its signed
voicemail renewal remains bound to the original tenant and call. First deployment
requires preserving any existing container-local spool and recordings; volume
creation alone does not migrate that data. See `services/sip/README.md`.

On the managed edge, `calling/routes/voice-webhook.ts` coordinates parked and
destination Telnyx legs through the call stores. The stores arbitrate destination
winners and cancellation. Those files are not the SIP.js transport implementation.

The engine's established state starts the visible call duration. That is a
signaling timestamp, not proof of audible two-way RTP. Media health is tracked
separately. A network failure must stop local media/UI within the configured
recovery bound. Native Answer waits for the real invitation and successful SIP
accept, with a bounded action timeout. Every subscription has a teardown.

## Data and Secrets

Sessions and routes must resolve an explicit organization. Feature routes enforce
role/ownership; stores use shared transaction/CAS helpers and tenant context.
Some existing platform/directory configuration is shared, so do not assume a
folder move itself creates a security boundary. Test each cross-tenant operation.

Carrier API keys, edge shared secrets and signing keys remain server-side. SIP
clients receive only the authenticated device's temporary credential over HTTPS;
mobile caches it in SecureStore. Do not put platform secrets into public build
variables, fixtures, logs, documentation, or commits.

## Release Gates

Run `bash verify.sh` from the root. Also run browser UI checks and the relevant
Python/native suites when those layers change. [CONTRIBUTING.md](CONTRIBUTING.md)
lists commands. Passing mocks and compilation does not prove physical-device
ringing, carrier audio or capacity. Keep those acceptance gates explicit.

Strict registration changes require the matching SIP config before Vercel
promotion. Use the pinned Kamailio image's parser on staged configuration, retain
the prior server backup, and inspect live container health before promoting HTTP
changes. Vercel does not ship a TestFlight or APK update.

Tenant BYOC connection records are encrypted and company-scoped. Operator
deployment records bind a gateway and real edge IP; signed outbound grants and
the XML bridge prevent fallback to another carrier. Configuration, publication,
deployment and real call acceptance are separate states. See the
[tenant carrier runbook](docs/runbooks/tenant-carrier-trunks.md).
Editing a published trunk updates its encrypted connection record and company
number inventory atomically. Disabled number tombstones remain disabled. Managed
carrier DID lookup additionally requires its own explicit source IP/CIDR allowlist;
a different tenant's BYOC carrier source cannot authorize managed fallback.
