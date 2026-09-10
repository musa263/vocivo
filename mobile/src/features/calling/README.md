# Mobile Calling

## Navigation

The first tab is **Dial Pad** and mounts `screens/DialerScreen` immediately.
There is no separate Home/New call step. Call history lives only in
`screens/RecentsScreen`; tapping a recent passes its identity to the dialer.
The header conference icon opens `screens/ConferenceScreen`. Each participant
is resolved as a regular phone number or a company-directory extension.
Individual accounts can conference regular numbers but never query a company
directory. External participants require an authorized caller ID and the
server's outbound entitlement, wallet and destination-policy checks.

`VoiceContext.tsx` coordinates UI actions and persistent engine subscriptions.
`engine/useVoiceRegistration.ts` selects the configured edge, obtains credentials,
registers device tokens and renews/reconnects sessions. `engine/voiceClientFacade`
offers a stable contract for SIP and Telnyx; `engine/engines` selects adapters.

### Startup critical path

The foreground hook waits for AuthContext to finish local restoration and expose
authenticated state, then fetches `/api/voice/config` before selecting an engine.
An accepted session-bound secure profile snapshot can release this gate while
`/api/auth/session` is pending; voice does not await account/bootstrap enrichment.
The snapshot is not fresh server authorization: voice APIs and SIP registration
still enforce access. A later HTTP session rejection clears authenticated state,
tears down voice and invalidates pending startup work. Initial `loading=true`
does not log out an existing push bootstrap. Fresh profile/account data does not
restart registration when the authenticated/loading flags stay unchanged.
A supplied carrier `bootstrapSession` is startup input, not an effect dependency
that starts a second config request and registration. Managed push startup reads
the secure cached carrier session in this same hook, after configuration selects
Telnyx, and persists prepared credentials before selecting the managed runtime. Configuration failures still stop startup and retry;
there is no cached-provider guess or fallback login to another engine.

On the SIP edge, ringtone preference setup runs independently and wakeup-token
registration starts after signaling bootstrap without blocking it. Push-token
reads and device writes are single-flight across the retry and foreground
listeners. Failures retain a separate unavailable/registering push status and
retry without restarting SIP. Engine connection events alone determine Ready;
foreground connectivity does not imply that background push delivery works.
The managed Telnyx path retains its existing ringtone, token persistence and
push-aware login ordering.

Secure SIP cache and account-token reads overlap, but registration still waits
for a matching current session, credential/TURN expiry checks, device-only secure
writes and logout invalidation checks. A valid secure cache avoids the credential
HTTP request; expired or mismatched credentials require renewal. There is no
startup NetInfo fetch/reachability probe in this hook: the remaining network
waits are live provider configuration, required credential renewal and actual
SIP registration. Account-profile/bootstrap timing belongs to AuthContext, and
HTTP timeout/retry policy belongs to the shared API client.

`VoiceRegistration.integration.test.tsx` covers delayed/failed auxiliary work,
late bootstrap input, cleanup and mounted AuthContext cached-restore/rejection
transitions; `SipBootstrap.integration.test.tsx`
covers overlapping secure reads, cache renewal and session changes. These are
mocked ordering checks, not measured device startup latency or push acceptance.

## SIP Path

`runtime/sipNative::ensureSipRegistration` single-flights foreground/push bootstrap,
checks SecureStore expiry and session identity, then registers. Logout invalidates
pending work. `engine/sipStackSipJs` adapts SIP.js/WebRTC; `sipBridge` translates
stack events to the feature bus; `sipCallEngine` exposes voice call objects.
`sipRegistrationKeeper` handles signaling retries. `callUi::bindCallUi` mirrors
native calls and queues Answer until the INVITE exists, with explicit deadlines.

Cached SIP configuration is also bounded by numeric TURN REST username deadlines.
This applies to legacy caches whose stored expiry exceeded the relay grant: an
expired relay grant triggers bootstrap renewal, and a live grant caps the remaining
lifetime returned to the registration coordinator. Bootstrap integration tests
cover both migration paths. Shipping this cache migration requires a mobile release.

## State and Media

`state/callLifecycle` protects termination/renegotiation operations. `media/`
contains permission, ringtone, network presentation and ICE/media recovery.
`engine/callState`, `callIdentity` and `session` translate state/identity/token data.
Screens render the context; components provide dialpad, caller-ID/rate selection
and connectivity display. Do not open another signaling client in a screen.

### Native control acknowledgments

`callUi` deduplicates mute/hold state before crossing the native bridge. Native
user commands update SIP, while acknowledgments do not generate another command.
The iOS manager additionally correlates mirrored CallKit transactions by action
UUID, so a delayed acknowledgment cannot reverse a newer control state.
`sipBridge` serializes competing changes separately for hold and mute.

### Irrecoverable transport loss

`VoiceContext::emergencyTransportCleanup` stops UI timers, media confirmation,
recovery work and call subscriptions. It invokes `emergencyEndCall`, not just
`endNativeCall`. The SIP adapter retires its tracked call, closes the SIP.js
session-description handler (tracks and peer connection), removes its listener,
and bounds SIP disposal to 2.5 seconds. Late ACTIVE events cannot resurrect it.
Native call UI closure runs independently from the signaling acknowledgment.

`state/routeCancellation` persists pending route cancellation before sending it.
`runtime/routeCancellation` stores it in device-only SecureStore, bound to the
original login. Only `{ canceled: true }` removes a pending entry. Reconnect,
foreground resume and a mounted-provider 30-second retry loop drain the queue.
A different login never replays the old record with its credentials. The queue
is capped at 64 entries and fails visibly rather than silently evicting work.
Remote completion still requires network access and a valid original session;
these retries are not a server-side worker and cannot execute while JS is killed.
The API leaves failed carrier-leg cancellation retryable instead of returning a
false success. Physical offline/foreground/killed-state tests remain release gates.

## Native and Tests

`mobile/native/` owns CallKit/Android incoming-call UI and background startup;
`mobile/plugins/` installs it in native builds. `mobile/index.js` is the fixed entry.
The Telnyx adapter remains in `runtime/voipClient` for the managed edge.
`runtime/managedVoiceRuntime` lazily loads the SDK; `VoiceRoot` mounts it only
for an authenticated, explicitly selected managed engine after session preparation.
SIP startup and sign-out do not instantiate a managed client. Missing/invalid
configuration fails closed. `runtime/nativeVoiceBridge` reads push tokens and
sign-in state through VocivoSip without importing the SDK's JavaScript. Managed
call UI and Android ringtone methods still use the installed VoicePnBridge
compatibility boundary; the patched Telnyx native plugin remains required.

“Refresh incoming calls” on SIP renews SIP registration and sends the native push
token to `/api/voice/devices`, without a carrier token request/login. Failures set
push status unavailable and propagate the actionable error. The managed path
retains its token refresh. ManagedRuntimeIsolation, VoiceRegistration and
VoiceContext integration tests cover these boundaries and ordering.

Telnyx session writes, including the patched SDK's credential/token persistence,
use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` so push reconnection can read credentials
after the device locks. The first unlock after reboot is still required; existing
cached items migrate when written on an unlocked launch. Tokens remain in
Keychain/Keystore and do not migrate to another device. Short token lifetimes are
preserved and renew before expiry. `TelnyxStorage.integration.test.tsx` verifies
the storage contract, and `telnyxPatch.test.ts` parses both installed SDK source
and runtime and checks both persistence paths. These do not substitute for
locked/killed-state tests on physical iOS and Android hardware.

Run mobile `npm run typecheck` and `npm test`. Unit tests are colocated; mounted
provider/secure-bootstrap tests are in `tests/voip/`. After native edits, compile
both platforms and verify physical killed-state delivery, answer/cancel races,
audio and network migration. Vercel deployment alone cannot ship native fixes.

## Connection recovery

An explicit foreground refresh sends REGISTER even if SIP.js still reports a
live transport and registration. Local flags can survive a network migration.
Idle mobile network changes debounce for one second and request fresh SIP/ICE
configuration; foreground bootstrap rechecks SecureStore expiry after suspended
timers. HTTPS failures retry with bounded backoff. A forced renewal queued behind
a cached bootstrap is retained and shared by concurrent callers. Final 401/403
rejections trigger bounded credential renewal; ordinary Digest challenges remain
inside SIP.js. Active/incoming calls keep their stack during network recovery.

The web client debounces online events and renews idle configuration, and checks
the renewal deadline when a hidden tab returns. Short credential lifetimes renew
at 80% without the previous five-minute floor. The stored SIP password and TURN
configuration have different lifetimes; use the API's configuration expiry.

Run the keeper unit tests, mobile SipRecovery/SipBootstrap integration suites,
`bash verify.sh`, and the browser SIP harness. These prove controlled recovery,
not physical Wi-Fi/5G handoff, killed-state operation, or two-way carrier audio.

A Registerer `Unregistered` event precedes SIP.js's rejection callback and also
occurs for expiry and server failures. While registration is wanted it starts
recovery. Final 401/403 responses request fresh HTTPS credentials, including
during an active call, through the existing single-flight bootstrap and in-place
same-identity credential update. They and temporary 408/429/5xx responses keep
established media alive during the existing 45-second recovery grace.
Repeated failures cannot extend that deadline; successful registration clears
it. Keeper tests cover callback ordering and mounted-provider tests cover media
survival, recovery and bounded cleanup. These changes require a mobile build.
Explicit sign-out/session revocation still tears down voice. A SIP refusal alone
does not prove the HTTP account was revoked; unsuccessful renewal cannot extend
the media recovery deadline indefinitely.

APNs routing follows the signed iOS provisioning profile, exposed through
`VocivoSip.pushEnvironment`. Release JavaScript does not imply production APNs:
a locally development-signed Release build receives sandbox tokens. App Store
installs without an embedded profile use production. Older native modules keep
the previous build-mode fallback. Run the native parser regression with:

```sh
swiftc native/ios/VocivoPushEnvironment.swift tests/native/PushEnvironmentTests.swift -o /tmp/vocivo-push-test
/tmp/vocivo-push-test
```

The pinned React Native 0.81.5 patch preserves the `nativeviewconfig` header
subdirectory for static CocoaPods builds. The Telnyx compatibility patch declares
stored ICE servers after the completed `useTrickleIce` expression; clean dependency
installation must apply these patches before producing a native bundle.

Credential replacement is checked again inside `SipStackBridge.register`, after
any pending HTTP lookup. A call arriving during renewal prevents engine teardown.
The existing SIP.js user agent receives the new password for subsequent Digest
requests; a late rejection from an older password generation remains recoverable.
Identity and WebSocket destination cannot change in place. Same-identity renewal
also preserves an idle stack: PushKit can already be ringing before its INVITE
is tracked. Renewed ICE settings replace the factory options for future dialogs,
without mutating existing handlers or peer connections. Explicit sign-out still
terminates calls. Bootstrap races before/after INVITE and installed-SIP.js Digest
tests cover this path; handset acceptance requires the updated mobile build.

`sipCallDiagnostics` emits release-visible answer failures with only a bounded
call ID, failure phase, and INVITE/accept-start flags. It distinguishes missing
invitation, failed acceptance, native end and deadline expiry; arbitrary errors,
SIP packets and caller identities are excluded. The production Babel regression
guards against accidentally stripping these diagnostics with debug warnings.

Successful re-REGISTER responses also notify the app through
`sipRegistrationRequestDelegate`. SIP.js 0.21.2 retains its Registered state
across transport loss and does not repeat that state-change event on recovery.
The final acceptance callback clears the app's recovery deadline only while
registration is wanted, the credential generation is current, the transport is
connected, and SIP.js has validated the registration. Sending a request alone
does not establish recovery. A regression using the installed Registerer covers
the missing repeat event and an unusable Contact; guard tests reject late or
superseded callbacks. Real-device stability still requires a new mobile build.

## Stage 2: managed runtime isolation and native identity controls

`runtime/managedVoiceRuntime.tsx` is the only runtime SDK loader. The managed
client is created lazily after an authenticated, explicit Telnyx selection;
SIP startup, push refresh and sign-out do not create it. `VoiceRoot` keeps its
provider mounted while conditionally mounting the managed runtime alongside it.
Managed push startup validates and persists its cached session before mounting.
Missing engine configuration fails closed. SIP registration runs independently
of ringtone preparation and push-token persistence; those failures retry without
restarting signaling. Existing Stage 1 recovery and profile-derived APNs remain.

`VocivoSip.setVoiceSignedIn` owns the native push sign-in flag on iOS and Android.
`voipPushToken` reads Vocivo's iOS token; `firebasePushToken` obtains Android's
FCM token directly, preserving the existing token cache. Shared JS calls use
these Vocivo methods and fail explicitly on old binaries missing the contract.
This requires build 64 or later; a JavaScript-only update is insufficient.
Managed cleanup runs only for an already initialized managed client.

The native Telnyx dependency is still present: shared PushKit/FCM dispatch,
Android activity/notification integration, resource installation and Android
ringtone compatibility remain migration work. Managed call UI controls still
belong to its adapter; SIP speaker/end-call controls use Vocivo's existing bridge.
This slice does not alter tenant identity or platform engine configuration.

Run `bash verify.sh`; the ManagedRuntimeIsolation, VoiceRegistration and
VoiceContext suites cover startup ordering, missing native capabilities,
sign-out isolation, push persistence failure and preserved recovery deadlines.
Regenerate native projects with `npx expo prebuild --no-install --platform all`,
compare copied sources, and compile both platforms. Build 64 compiled and passed
signature verification; Android debug compiled. Physical ringing, locked/killed
answer, two-way speech and sustained calls are still release gates.

## Tenant carrier numbers

Bootstrap can return `source: carrier` numbers with `ready` or
`pending_activation` status. Incoming-call transfer selection can use a ready
carrier number. The API authorizes its current trunk at call time; UI selection
is not carrier activation. These client type/selection changes need a mobile
release; backend number publication is available independently.

Version 1.0.0 build 65 includes the current SIP credential-renewal/contact
preservation fixes and tenant-carrier number support. The September 8 local iOS
Release build is development-signed for the existing provisioned device; it is
not a TestFlight distribution. Physical answer/recovery and live carrier audio
acceptance remain separate from compilation and signature verification.
# Assigned dialing and presence

Dial Pad and Conference use `profile.outbound_caller_id` and `dialing_country`
from authenticated bootstrap. Company admins assign each user's outgoing line
in Users; company default is an administrator-controlled fallback. Users cannot
override it. The dial pad has no line/country pickers. Explicit international
prefixes and a contact's explicit country win over national-number defaults.
Editing away from a selected contact clears its country override. Internal calls
still require an unambiguous same-company directory match, not an outgoing line.

`state/useVoicePresence` publishes registered/engaged states every 20 seconds,
without blocking voice setup. Background idle devices report offline; this does
not mean a valid VoIP push cannot wake them. A lost/killed device's lease expires
after 60 seconds. Other screens show online/busy/offline indicators with accessible
labels and refresh the directory on foreground entry. The existing transactional
mobile call-waiting flow is retained; availability dots never authorize or reject
calls. Signaling and physical multi-device behavior remain separate acceptance gates.

Run mounted DialerScreen/ConferenceScreen tests, presence publisher tests and the
full mobile suite. A new native distribution must include these source changes
before physical iOS/Android acceptance; a Vercel deploy alone cannot ship them.

## Clean dialing and history identity

The idle dial pad keeps stable keypad spacing but has no placeholder, underline
or delete control. Digits and delete appear after entry. Granted device contacts
are looked up asynchronously after 120ms, without delaying call setup; exact
company directory matches take precedence. Old lookup results cannot replace
an edited number. Protocol usernames are rejected as dial input, never reduced
to their digits. Names suppress raw SIP/credential strings.

`historyIdentity` resolves only an unambiguous same-company SIP username or exact
extension. The VoiceContext keeps a protocol address separate from visible text
until AuthContext resolves it for history; no raw credential label is rendered.
Run the history identity, DialerScreen and ContactDirectory regression suites.
