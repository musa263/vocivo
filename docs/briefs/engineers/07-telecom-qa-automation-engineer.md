# 7. Telecom QA / automation engineer

**9 open items** — 4 High, 4 Medium, 1 Low.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

The cross-platform regression matrix, SIP scenarios, physical devices, real carrier calls and release acceptance including Gate A08.

## First results to deliver

A repeatable call matrix covering inbound and outbound calls, background ringing, cancellation, transfers, audio and network recovery, including Gate A08.

## Required skills

- SIP test scenarios with SIPp; packet analysis with sngrep and Wireshark
- Browser automation with Playwright and mobile integration tests
- Physical-device and carrier tests for background ringing, network migration, one-way audio, cancellation races, transfers, hold and DTMF
- Reproducing delayed or duplicate events and packet loss
- Recording build, network and call identifiers with measured pass/fail evidence for Gate A08

## Start here

**QA-1** and **QA-2** — these are the items a customer feels on an ordinary call.

Every item in the master document is a candidate regression test. The four listed under *Where to start* there should get coverage first, since each one reached production unnoticed.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### QA-1

**Where** — `services/receptionist/tests/test_ai_quality.py:145`

test_cancelled_asr_keeps_its_slot_until_native_work_finishes currently fails (2 != 1) because it asserts the single-slot behaviour that AI-4 deliberately changes. The property worth pinning is that a cancelled transcription keeps its slot until the native worker exits, not that only one may run.

**Fix** — Rewrite to assert slot retention with the gate size set to one for that test, so the invariant survives a concurrency change.

#### QA-2

**Where** — `Gate A08 call matrix`

No repeatable matrix exists covering inbound and outbound, background ringing, cancellation races, transfers, hold, DTMF, one-way audio and network migration, so regressions of exactly the kind listed in this document reach production before anyone notices.

**Fix** — Build the matrix with SIPp scenarios plus physical-device runs, recording build, network, call ids and measured pass/fail.

#### QA-3

**Where** — `Multi-call iOS behaviour`

Call waiting, Add caller, Swap and Merge have no device coverage, which is why the single-call CallKit configuration (MOB-2) shipped unnoticed and silences the surviving leg.

**Fix** — Add a physical two-call scenario asserting audio on the surviving leg after the first ends.

#### QA-4

**Where** — `Receptionist failure paths`

Nothing exercises what happens when the API, the recogniser or the voice engine is unavailable mid-call, which is where the three caller-visible hangups (AI-1, AI-2) live.

**Fix** — Add fault-injection tests for API 5xx, recogniser timeout and synthesis failure, asserting the caller is never hung up on.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### QA-5

**Where** — `Static dialplan fallback`

No test asserts the path taken when mod_xml_curl is unavailable, which is where the receptionist transfer loop (SIP-4) hides.

**Fix** — Add a scenario with the binding removed, asserting a transfer reaches the staff bridge.

#### QA-6

**Where** — `Sign-out revocation`

Nothing asserts that signing out revokes the SIP credential and deletes the push registration, so MOB-3 and MOB-4 are invisible to the suite.

**Fix** — Assert the DELETE calls fire before the token is cleared, and that a revoked credential can no longer register.

#### QA-7

**Where** — `Transfer and Merge on the SIP edge`

Both features are surfaced in the UI and unimplemented server-side for SIP calls (BE-5), with no test covering either engine.

**Fix** — Cover both engines, asserting the control is hidden or the call is actually transferred.

#### QA-8

**Where** — `Cross-tenant inbound injection`

BE-1 and SEC-1 need a reproducible scenario before and after the fix.

**Fix** — A SIPp scenario sourcing from tenant A’s trunk IP to tenant B’s platform DID, asserting rejection.

### Low — dead code, a cosmetic defect, or a latent hazard

#### QA-9

**Where** — `Mobile jest cold-run flake`

One suite fails on the first cold run and passes on re-runs, training the team to ignore a red suite.

**Fix** — Pin the timing with fake timers.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
