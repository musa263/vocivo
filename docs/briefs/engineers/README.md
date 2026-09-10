# Vocivo — open defects by engineer

95 open items across eight roles, taken from a line-by-line review of the whole codebase at the current head of `main`. One file per role; each item names the file and line, what goes wrong for a caller or a tenant, and the direction of the fix.

| Role | Items | High | Medium | What they unblock |
| --- | --- | --- | --- | --- |
| [Senior VoIP / SIP engineer — technical lead](01-senior-voip-sip-engineer.md) | 10 | 2 | 2 | Inbound kill switch, edge stability under scanning, correct CDRs, transfer fallback |
| [Native mobile / VoIP engineer](02-native-mobile-voip-engineer.md) | 17 | 4 | 5 | Calls surviving a re-registration, multi-call audio, clean sign-out, correct Recents |
| [Senior backend / multi-tenant engineer](03-senior-backend-multi-tenant-engineer.md) | 16 | 1 | 4 | Tenant isolation on inbound, number lifecycle, plan limits, SIP transfer and merge |
| [Web / WebRTC frontend engineer](04-web-webrtc-frontend-engineer.md) | 17 | 3 | 6 | No sign-out or silence mid-call, a superadmin console that always loads |
| [DevOps / Site Reliability Engineer](05-devops-sre.md) | 8 | 0 | 6 | Repeatable first deploys, pinned media stack, secrets out of logs, capacity alerts |
| [Real-time voice AI engineer](06-realtime-voice-ai-engineer.md) | 9 | 3 | 3 | The receptionist never dropping a caller, bounded disk, real concurrency |
| [Telecom QA / automation engineer](07-telecom-qa-automation-engineer.md) | 9 | 4 | 4 | Gate A08 matrix and regression cover for every item above |
| [Application security engineer — periodic specialist](08-application-security-engineer.md) | 9 | 2 | 5 | Cross-tenant call injection, credential rotation, toll-fraud limits |

## Where to start

Four items come before anything else, because each one is visible to a paying customer on an ordinary call.

1. **BE-1 / SEC-1** — one tenant’s trunk can ring another tenant’s PBX. The only finding that breaks the promise the platform is sold on.
2. **AI-1, AI-2** — the receptionist hangs up on live callers when the API, the recogniser or the voice engine has a bad minute.
3. **MOB-1, MOB-2** — a re-registration refusal ends a healthy call, and the second leg of any two-call scenario goes silent on iOS.
4. **WEB-1, WEB-2** — a backend blip signs the user out and unmounts the element carrying live call audio.

**SIP-2** and **OPS-7** are close behind: the first lets a routine port scan degrade signalling for everyone, the second is a disk that fills under normal traffic and takes telephony down with it.

## Work already in progress

Thirteen files in the working tree carry uncommitted changes made during the review, covering **AI-1, AI-2, AI-3, AI-4, AI-6** and four of the backend and tenancy items. None of it is committed, deployed or independently reviewed.

One change currently breaks a test: `services/receptionist/tests/test_ai_quality.py::test_cancelled_asr_keeps_its_slot_until_native_work_finishes` pins the single-slot recogniser behaviour that AI-4 changes. That is **QA-1**, and it must be resolved before the receptionist work is committed.

Green at the time of writing: API and web suite 446 passing, API typecheck clean, web build clean, mobile typecheck clean with 154 unit and 71 integration tests passing, receptionist suite 88 passing with the one failure above.
