# 2. Native mobile / VoIP engineer

**17 open items** — 4 High, 1 Med/High, 6 Medium, 4 Low, 2 Verify.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

mobile/src, mobile/native (iOS Swift and Android Kotlin) and mobile/plugins.

## First results to deliver

Reliable background ringing, correct answer and cancel behaviour, Wi-Fi-to-cellular recovery, credential renewal, Bluetooth and speaker handling.

## Required skills

- React Native and Expo native builds
- Swift/Objective-C and Kotlin
- iOS CallKit and PushKit; Android Telecom and ConnectionService with push delivery
- Debugging native-to-JavaScript event races, audio focus, secure credential storage, background and terminated-app behaviour
- Single-flight registration refresh, network-change recovery and timer cleanup
- Testing on real iOS and Android devices, Bluetooth, speaker routing and interrupted calls

## Start here

**MOB-1** and **MOB-2** — these are the items a customer feels on an ordinary call.

**MOB-3** and **MOB-4** are one change with two halves: both remote de-registrations need the bearer token that sign-out currently clears first. Fix and test them together, with the security engineer reviewing the credential lifecycle (SEC-5).

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### MOB-1

**Where** — `mobile/src/features/calling/VoiceContext.tsx:503 (via sipRegistrationKeeper.ts:116, sipCallEngine.ts:151)`

A permanent REGISTER refusal maps to ConnectionState.DISCONNECTED, which runs emergencyTransportCleanup immediately; only RECONNECTING gets the 45 s grace. On a twelve-minute call whose periodic re-REGISTER is answered 403 because the edge replaced the device credential, media over rtpengine is untouched but the app ends the call and shows "the calling connection was lost".

**Fix** — When currentCalls holds a non-terminal call, treat ERROR/DISCONNECTED like RECONNECTING and arm the grace timer instead of cleaning up synchronously.

#### MOB-2

**Where** — `mobile/native/ios/VocivoSipCallManager.swift:51-52, :417-425`

maximumCallsPerCallGroup and maximumCallGroups are both 1 while the app ships call waiting, Add caller, Swap and Merge. The second leg never enters CallKit, so when the first ends CallKit sees zero calls, fires didDeactivate and sets RTCAudioSession.isAudioEnabled = false: the surviving call goes silent while still connected. A second incoming call is worse: reportNewIncomingCall errors and forget(callId) drops the UUID mapping.

**Fix** — Raise maximumCallsPerCallGroup, enable grouping/ungrouping, and disable RTC audio in didDeactivate only when no calls remain.

#### MOB-3

**Where** — `mobile/src/features/auth/AuthContext.tsx:227-236 with runtime/sipNative.ts:190`

signOut() schedules the unregister effect and then synchronously clears the session token, so by the time unregisterVocivoSip compares its cached token the value is null, the comparison fails and DELETE /api/voice/sip-credentials is never sent. The local cache is then deleted, so it can never be retried. The Digest password issued with a seven-day life stays valid on Kamailio: a handed-on phone can register and place or receive calls for a week.

**Fix** — Await the revocation inside signOut() before clearing the session token.

#### MOB-4

**Where** — `runtime/voipClient.ts:74-99, engine/useVoiceRegistration.ts:112-124, VoiceContext.tsx:567`

The client POSTs /api/voice/devices without a deviceId, so the server mints a UUID the client never stores and can never use for the DELETE branch. After sign-out the previous account still pushes to the handset; iOS must satisfy PushKit, so the call is reported to CallKit and immediately ended, writing a missed call in iOS Recents for an account the user signed out of, on every call, indefinitely.

**Fix** — Persist the device id returned by the POST and DELETE it as the first step of sign-out, before the token is cleared.

### Med/High — between the two — broken feature with a device-wide or security consequence

#### MOB-5

**Where** — `mobile/native/android/VocivoSipModule.kt:182, :195`

reportMuted writes AudioManager.isMicrophoneMute, a device-wide setting, and nothing restores it: reportCallEnded and invalidate() only stop ringback. Mute a call, hang up, and the phone microphone stays muted for every other app. setSpeaker has the same shape, leaving audio mode in MODE_IN_COMMUNICATION.

**Fix** — Mirror mute through the self-managed Connection/CallAudioState, and reset isMicrophoneMute and audio mode when no calls remain.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### MOB-6

**Where** — `api sip-credential-store.ts:69-73 with runtime/sipNative.ts:177-192`

mergeSipCredentials replaces on deviceId plus sessionId, and unregisterVocivoSip deletes only the session key while the device key survives sign-out. Because the session id changes on every login, each sign-in leaves the previous credential live: three sign-in cycles on one handset leave three Digest passwords valid for that extension.

**Fix** — Revoke on sign-out (MOB-3) and/or replace by deviceId alone for the same extension.

#### MOB-7

**Where** — `VoiceContext.tsx:219-228 with AuthContext.tsx:85-99`

finalizeCall builds the local history entry with no direction, but mergeHistory’s number-plus-30-second dedup requires direction to match and every server row carries one. The id path cannot save it either, since an outgoing SIP call id is vocivo-<ts>-<n> and never the server CDR id. Every outbound call appears twice in Recents after the next sync.

**Fix** — Set direction (and internal) on the locally logged entry, and treat a missing direction as a wildcard in the dedup.

#### MOB-8

**Where** — `VocivoSipCallManager.swift:55 with runtime/nativeVoiceBridge.ts:38-39`

configuration.ringtoneSound is hardcoded and setIncomingCallRingtone returns true without doing anything on iOS, so applyIncomingRingtone reports success. A user picks a ringtone in Settings, the UI confirms it, and every CallKit ring is still the classic tone. All six bundled ringtones are dead on iOS.

**Fix** — Expose a native setRingtone that rebuilds CXProviderConfiguration, and stop returning a fake success from the bridge.

#### MOB-9

**Where** — `VoiceContext.tsx:603, 660-663`

On the SIP edge nothing advances an outbound route to phase "connected": voice-progress is posted only by the callee on internal calls. An external outbound call lasting longer than about 55 s exhausts the poll loop and sets the error "call setup is taking longer than expected", which the active-call screen renders mid-conversation.

**Fix** — Stop the loop as soon as the engine reports ACTIVE on the SIP edge, or mark the route connected from the SIP answer/CDR path.

#### MOB-10

**Where** — `AuthContext.tsx:113-121, :268 with App.tsx:31-38`

setVoiceSignedIn rejects when the native module is absent, when the native call resolves non-true, or when Android SharedPreferences.commit() fails. The error is stored in state and rethrown from render, so the LaunchBoundary retry re-renders AuthProvider, which throws again: an infinite loop with no path back into the app.

**Fix** — Surface it as a dismissible banner with a retry of setVoiceSignedIn, not a render-time throw.

#### MOB-11

**Where** — `engine/useVoiceRegistration.ts:323-329`

The token timer clears only once registeredToken becomes truthy. If the user denies notifications, getVoicePushToken() returns undefined forever and a two-second bridge poll runs for the whole session while pushRegistration stays "registering", so the UI never tells the user push is off.

**Fix** — Back off exponentially with a cap and set pushRegistration to unavailable after N failures.

### Low — dead code, a cosmetic defect, or a latent hazard

#### MOB-12

**Where** — `VocivoSipCallManager.swift:157`

reportOutgoingCall(with:startedConnectingAt:) is called synchronously right after the async controller.request(CXStartCallAction), before CallKit knows the call exists, so it is a no-op and the outgoing connecting state is never shown.

**Fix** — Move it into provider(_:perform: CXStartCallAction) after action.fulfill().

#### MOB-13

**Where** — `VocivoSip.swift:32-34, VocivoSipCallManager.swift:279/414/424, VocivoConnection.kt:83-92, runtime/callUi.ts:37-49`

callUiAudioSession and callUiPushToken are emitted with two different payload shapes by iOS and Android, and CallUiEventMap declares neither, so nothing subscribes. The VoIP push token reaches JS only through the two-second poll of MOB-11, and a speaker or Bluetooth change made on the system call screen never updates the app UI.

**Fix** — Pick one payload shape, add both events to CallUiEventMap, and bind them in bindCallUi.

#### MOB-14

**Where** — `runtime/sipBridge.ts:170-174 with VoiceContext.tsx:449`

unregister() emits registration state "none", which becomes DISCONNECTED and runs emergencyTransportCleanup, so a deliberate sign-out shows the user a transport-failure error on the way out.

**Fix** — Suppress the error path when the disconnect was requested.

#### MOB-15

**Where** — `api push/routes/voice-devices.ts with the three POST sites`

Because the client never sends a deviceId (MOB-4), every registration POST writes a new encrypted blob under a fresh UUID. Only the ownership index keeps them out of listPushDevices; the blobs themselves are never reclaimed.

**Fix** — Reuse the persisted device id, and add a sweep for blobs with no ownership entry.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### MOB-16

**Where** — `VocivoSipModule.kt:116 with VocivoSipIncomingCall.kt:81`

startRuntime runs only on the incoming path, so a dialled call backgrounded mid-conversation is held up only by the self-managed Connection, with no FOREGROUND_SERVICE_TYPE_PHONE_CALL. Needs a physical device to confirm whether OEM process-killing bites.

**Fix** — Start the call service on the outgoing path too if confirmed.

#### MOB-17

**Where** — `mobile jest suite`

One jest suite failed on the first cold run of a session and passed on sixteen re-runs; likely a timer-sensitive integration test in the SipRecovery/SipBootstrap family rather than a product bug.

**Fix** — Pin it with fake timers so a real regression is not masked by an accepted flake.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
