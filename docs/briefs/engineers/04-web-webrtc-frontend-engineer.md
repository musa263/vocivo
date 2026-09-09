# 4. Web / WebRTC frontend engineer

**17 open items** — 3 High, 6 Medium, 7 Low, 1 Note.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

frontend/src — the browser dialer, the SIP.js lifecycle, and the admin and superadmin consoles.

## First results to deliver

Consistent web call state, clear connection errors, working admin assignments, safe callbacks and browser recovery without stale reconnecting banners.

## Required skills

- React, TypeScript and asynchronous hook lifecycles
- SIP.js and browser WebRTC
- Diagnosing microphone permissions, ICE negotiation, WSS disconnects and audio statistics with browser developer tools
- Call-state machines, cancellable requests, reconnect backoff and subscription cleanup
- Playwright automation plus real Safari, Chrome and Firefox checks
- Admin assignments, automatic destination detection and stale UI recovery

## Start here

**WEB-1** and **WEB-2** and **WEB-3** — these are the items a customer feels on an ordinary call.

**WEB-1** is an API route and **WEB-2** is a React lifecycle problem, but they are the same incident seen from two ends: a backend blip signs the user out and takes the audio element with it. Fix both, then reproduce by failing the session route deliberately during a call.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### WEB-1

**Where** — `frontend/api/_lib/features/auth/routes/auth-session.ts:40 with src/App.jsx:82`

A bare catch turns any backend failure inside GET /api/auth/session into 401 "session expired", and App treats 401 as a real sign-out. A blob-store hiccup, or the deliberate "owner session verification is temporarily unavailable" throw, clears the session and unmounts the whole tree including the web phone, dropping a live call. Every other route maps the same error to 500.

**Fix** — Return 401 only for Unauthorized/JWT failures and 503 otherwise. Joint with Backend.

#### WEB-2

**Where** — `src/App.jsx:52, :92, :186`

The session effect sets loading on every session identity change and the early return replaces the shell before the audio element, incoming-call and active-call overlays. The 8-second retry path therefore unmounts the <audio id="remoteMedia"> element holding the live MediaStream during an outage; attachSipMedia only re-attaches on a track event or a transition to Established, so the call stays up on the wire with no audio and no hangup button, repeating every 8 seconds.

**Fix** — Show the opening screen only on first load, or hoist the audio element and call overlays above the early returns.

#### WEB-3

**Where** — `src/features/admin/AdminConsole.jsx:62`

The /api/voice/settings call is the only one in load() not wrapped in the local safe() helper, and for a superadmin allowed() short-circuits true for every feature. The route answers 403 for any organization that is not an active business account, so opening an individual customer throws before setConfig/setSaas and the console never leaves its loading state; if the stored activeOrganizationId names an individual account the superadmin console is bricked on first mount.

**Fix** — Wrap it in safe() with a null fallback and render the section only when loaded.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### WEB-4

**Where** — `src/App.jsx:205 with :117 and :194`

ActiveCall receives the raw selectedNumber state, which stays null until the user opens the caller-ID menu, while Dialer receives the defaulted currentCallerNumber. A user who dials without touching the picker and then taps Add caller gets "choose a caller ID before adding an external caller" with no way to fix it from the in-call UI.

**Fix** — Pass currentCallerNumber to ActiveCall as well.

#### WEB-5

**Where** — `src/features/admin/numbers/CarrierTrunksPanel.jsx:22 with AdminConsole.jsx:38`

The fetch effect is keyed on the api function, which workspaceApi rebuilds on every AdminConsole render. Every state change refetches the trunk list and flashes "loading carrier trunks"; when the effect refires while load(newOrg) is in flight, assertCurrent throws and the panel shows "the customer workspace changed, reload before continuing" although nothing is wrong.

**Fix** — Memoise api on the organization id, or key the effect on organizationId.

#### WEB-6

**Where** — `src/features/admin/numbers/NumbersPage.jsx:26 with configuration.js:25`

CarrierTrunksPanel is rendered unconditionally on the Phone numbers page, but its route requires the sipTrunks feature while the section is gated on phoneNumbers. A tenant entitled to numbers but not trunks gets a permanent error banner, and the Remove from company button on that page 403s.

**Fix** — Render the panel only when the sipTrunks entitlement is present.

#### WEB-7

**Where** — `src/features/admin/routing/HoursPage.jsx:7`

The office-hours timezone is a select with four hardcoded zones while the API accepts any IANA zone. A tenant in an unlisted zone has no matching option, so the browser paints the first one: the page misreports their routing timezone and one touch of the control silently rewrites a correct value to a wrong one.

**Fix** — Populate from Intl.supportedValuesOf("timeZone"), or at minimum inject the current value as an option.

#### WEB-8

**Where** — `src/features/admin/ai/VoicePage.jsx:15-35`

previewVoice creates a bare Audio object with no cleanup effect, so leaving the section or switching customer leaves the previous tenant’s rendered prompt playing over the new workspace with no visible control, and the blob URL leaks.

**Fix** — Pause and clear the element and revoke the object URL in an unmount effect.

#### WEB-9

**Where** — `src/features/admin/settings/SystemPage.jsx:5-7 (also Dashboard.jsx:60, AdminConsole.jsx:53 and :101)`

Math.max(0, findIndex(...)) and the organizations[0] fallbacks make another tenant’s row the default whenever the active id is not in the list. The operator then sees and edits a different customer’s account contact, billing email and extension range, with that customer’s name in the topbar. Server-side writes are keyed by id so the wrong-tenant write is dropped, but the operator is typing into the wrong record.

**Fix** — Let the index be -1 and render an explicit "workspace unavailable" state.

### Low — dead code, a cosmetic defect, or a latent hazard

#### WEB-10

**Where** — `src/features/calling/hooks/useSipVoice.js:243`

renew() clears the renewal timer and, on the connectionPending branch, returns without re-arming it. When the credential lifetime is short enough that renewIn hits its floor before connectSipUserAgent resolves, the renewal chain dies and the password expires under a running phone, recoverable only by a visibility or online event.

**Fix** — Reschedule (about 5 s) on that branch instead of returning.

#### WEB-11

**Where** — `src/features/calling/components/ActiveCall.jsx:65`

Transfer is gated on !voice.incoming, but ActiveCall renders only when active, which both hooks define as mutually exclusive with an unanswered incoming call. On the SIP edge the flag is always false, so the button can never enable; the two guards agree only by accident and will hide the feature the moment SIP transfer ships.

**Fix** — Gate on the capability flag only.

#### WEB-12

**Where** — `src/features/calling/hooks/useSipVoice.js:681 and :639`

clearError is exported with a comment describing the bug it fixes but no component calls it, so a stale rejection message carries across from the external keypad to the extension keypad. connected: mediaReady || state === "held" is also dead, since state is only ever requesting, active or null in this hook.

**Fix** — Call clearError from the dialer input handler and drop the held branch.

#### WEB-13

**Where** — `src/features/calling/hooks/useTelnyxVoice.js:115`

startIncomingRingtone plays /audio/ringback.wav while the SIP path uses /audio/ringtone.wav, so on the Telnyx edge an incoming call sounds identical to an outgoing call.

**Fix** — Use the ringtone asset.

#### WEB-14

**Where** — `NumbersPage.jsx:26 and TrunksPage.jsx:5`

The identical CarrierTrunksPanel is rendered on two nav sections, so the same trunk can be edited from two places with two independently fetched copies and two revision counters.

**Fix** — Keep it on one section and link from the other.

#### WEB-15

**Where** — `numbers/routes/admin-numbers.ts:104-108 with AdminConsole.load()`

admin-numbers still implements search, purchase, release and messaging-profile assignment, and the console stores orders and messagingProfiles, but NumbersPage renders none of it. Each console load still costs three carrier round-trips for data nothing displays.

**Fix** — Restore the managed-numbers UI or delete the unreachable branches and stop fetching.

#### WEB-16

**Where** — `src/features/admin/AdminConsole.jsx:114 with NumbersPage.jsx:6`

NumbersPage is passed isSuperadmin, which it does not accept: a dead prop left by the removed superadmin connection UI.

**Fix** — Drop the prop.

### Note — not a functional defect, but it needs a decision

#### WEB-17

**Where** — `src/features/marketing/main.jsx:117, 165`

The static marketing page carries a real customer name, a real person’s name and extensions 2000/2001/2010 as sample copy. Not tenant data and not a functional defect, but it is a live customer’s identity on the public site.

**Fix** — Confirm this is intended and consented, or replace with invented sample copy.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
