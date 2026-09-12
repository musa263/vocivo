# Feature Directory and Debugging Guide

Each runtime has a `features/<name>` folder. Search by feature first, then follow
its route or context into a store/engine. Client and backend folders share names
where they implement the same domain; they are not separate copies of one module.

## Feature Map

| Feature | Backend | Web | Mobile |
| --- | --- | --- | --- |
| Sign-in, profile, password | [auth](../frontend/api/_lib/features/auth/README.md) | [auth](../frontend/src/features/auth/README.md) | [auth](../mobile/src/features/auth/README.md) |
| Companies, users, subscriptions, access | [organizations](../frontend/api/_lib/features/organizations/README.md) | [admin](../frontend/src/features/admin/README.md) | [organizations](../mobile/src/features/organizations/README.md) |
| Calling, history, lifecycle | [calling](../frontend/api/_lib/features/calling/README.md) | [calling](../frontend/src/features/calling/README.md) | [calling](../mobile/src/features/calling/README.md) |
| SIP authentication, dialplan, CDR | [sip](../frontend/api/_lib/features/sip/README.md) | Calling engine | Calling engine + native |
| Agents, live registrations/queues, call analytics | [operations](../frontend/api/_lib/features/operations/README.md) | [operations](../frontend/src/features/admin/operations/README.md) | Admin web view |
| Wallet, rates, usage | [billing](../frontend/api/_lib/features/billing/README.md) | [billing](../frontend/src/features/billing/README.md) | [billing](../mobile/src/features/billing/README.md) |
| Phone numbers, caller IDs, trunks | [numbers](../frontend/api/_lib/features/numbers/README.md) | [numbers](../frontend/src/features/numbers/README.md) | Calling screens |
| SMS | [messaging](../frontend/api/_lib/features/messaging/README.md) | Platform APIs | [messaging](../mobile/src/features/messaging/README.md) |
| Push notifications | [push](../frontend/api/_lib/features/push/README.md) | [push](../frontend/src/features/push/README.md) | Calling runtime + native |
| AI receptionist, voices, transfer | [ai](../frontend/api/_lib/features/ai/README.md) | Admin/ai | Business settings |
| Enrollment | [enrollment](../frontend/api/_lib/features/enrollment/README.md) | [enrollment](../frontend/src/features/enrollment/README.md) | Auth |
| Video | [video](../frontend/api/_lib/features/video/README.md) | [video](../frontend/src/features/video/README.md) | [video](../mobile/src/features/video/README.md) |
| Scheduled meetings/calls | [meetings](../frontend/api/_lib/features/meetings/README.md) | [meetings](../frontend/src/features/meetings/README.md) | Web calendar export |
| Platform API keys, diagnostics | [platform](../frontend/api/_lib/features/platform/README.md) | Admin/platform | Not a mobile feature |
| Settings | Auth/organizations/calling | [settings](../frontend/src/features/settings/README.md) | [settings](../mobile/src/features/settings/README.md) |
| Contacts | Organizations directory | Calling directory | [contacts](../mobile/src/features/contacts/README.md) |
| Home | Bootstrap | App shell | [home](../mobile/src/features/home/README.md) |
| Product website | No phone-engine dependency | [marketing](../frontend/src/features/marketing/README.md) | Not applicable |

## Trace a Failure

| Symptom | Follow this path |
| --- | --- |
| Stuck connecting | Client `useVoice`/`useVoiceRegistration` -> `/api/voice/config` -> selected credential API -> `sipRegistrationKeeper` or Telnyx adapter -> edge auth logs |
| Wrong extension can register | `sip/routes/voice-sip-auth` -> `sip-registration-auth` -> replay check -> Kamailio `AUTH`/`REGISTER` |
| Recipient never rings | `calling/routes/voice-route` -> destination grant -> Kamailio `DELIVER_EXTENSION`/usrloc -> `sip-wakeup` -> push store/dispatcher -> native UI -> SIP registration |
| Answer pressed before invitation | Mobile `engine/callUi` pending action -> `runtime/sipNative` secure bootstrap -> `sipBridge` incoming event -> native `completeAnswer` |
| Silent audio or drop after answer | Selected engine session -> ICE/SDP -> Kamailio in-dialog routing and `MANAGE_REPLY` -> RTPEngine counters; distinguish signaling established from actual RTP |
| Ringing after caller cancels | Client lifecycle/CANCEL -> edge transaction -> destination terminal event -> `callUi` cleanup; on Telnyx edge inspect call-pair cancellation store/webhook instead |
| AI stops speaking | AI profile/route -> receptionist service `app/call.py` -> `brain.py` streaming -> `speech.py`/TTS -> FreeSWITCH playback events |
| Wrong company data | Public route -> `requireSession`/`requireAdmin` -> organization/entitlement resolution -> feature store -> shared tenant context/CAS |
| Wallet discrepancy | Billing route -> `wallet-store` ledger/idempotency -> carrier usage; never change a customer's balance to hide a failed call |

Record the build SHA, platform, timestamp, engine, and redacted call/route ID.
Never paste bearer tokens, passwords, full SIP Authorization headers or push tokens.

For a Codex Astra 6 bug-hunt / F8-debug / fix session, use the paste-ready prompt in
[docs/prompts/codex-astra-6-debug-and-fix.md](prompts/codex-astra-6-debug-and-fix.md).

## How to Find a Function

```bash
rg -n 'ensureSipRegistration|bindCallUi' mobile/src/features/calling
rg -n 'export .*function|export .*class' frontend/api/_lib/features/sip
rg -n 'sip-auth|sip-wakeup' frontend/api services/sip
```

Feature READMEs explain important entry functions and module collaboration.
Function signatures and colocated tests define detailed input/output contracts.
Historical audit line numbers refer to the audited revision; use
`git log --follow -- <new-path>` or search the function name after a move.

## Stable Exceptions

- `frontend/api/`: stable URL entry points; feature implementation is under `_lib/`.
- `mobile/index.js`, `App.tsx`, `native/`, `plugins/`: boot/native build contracts.
- `frontend/src/sw.js`, HTML entries and Vite config: browser build/service-worker entry points.
- `shared/`: HTTP/database/SDK transports, cross-feature types/theme, not product features.
- `services/`: independent deployments. Vercel deploy does not deploy these or native binaries.
- `.github/workflows/`: release operations. SIP schema/config changes must be deployed together.

Run `bash verify.sh` after moves. Type checking is necessary but not sufficient:
the browser scripts also mount the UI and exercise the moved hooks.
