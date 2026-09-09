# 6. Real-time voice AI engineer

**9 open items** — 3 High, 2 Medium, 1 Low, 2 Verify, 1 Deliverable.

> Part of the Vocivo defect allocation. The full picture across all eight roles is in [Vocivo-Open-Defects-by-Role.docx](../Vocivo-Open-Defects-by-Role.docx); the role definitions are in [Vocivo-Engineering-Roles-and-Responsibilities.docx](../Vocivo-Engineering-Roles-and-Responsibilities.docx).

## What this role owns

services/receptionist, services/tts, and the per-call payload the API builds for them.

## First results to deliver

Audible greetings, measured response latency, natural interruption, dependable transfers, and fallback within defined time limits when an AI service fails.

## Required skills

- Python asyncio and FreeSWITCH Event Socket with per-call ownership, bounded queues, timeouts and cancellation
- Integrating faster-whisper STT, Kokoro TTS and streaming language-model APIs
- PCM formats, resampling and playback events
- Voice activity detection, barge-in and stale-audio cancellation
- Measuring first-audio latency and concurrency
- Validating tenant-specific prompts, permitted transfers and service-failure fallback

## Start here

**AI-1** and **AI-2** — these are the items a customer feels on an ordinary call.

Fixes for **AI-1, AI-2, AI-3, AI-4 and AI-6** are already written and sitting uncommitted in the working tree. They need review, and AI-4 needs the test in **QA-1** resolved before any of it can be committed. Treat the written code as a proposal, not as done work.

---

## Open items

### High — a call is dropped, silenced, misrouted to another company, or a console is unusable

#### AI-1

**Where** — `services/receptionist/app/api.py:47-49 with app/call.py:59-63`

assistant_for catches every httpx.HTTPError and returns None, and the handler treats None as "this number has no receptionist" and hangs up with NO_ROUTE_DESTINATION. A cold start, a 502 or a ten-second timeout therefore drops every inbound call on the platform with no greeting and no fallback, because the dialplan fallback is never reached: the socket app did connect. A fix is written and awaiting review.

**Fix** — Distinguish 404 and enabled:false from transport and 5xx failures; on failure close the socket without hanging up so the dialplan rings the staff.

#### AI-2

**Where** — `services/receptionist/app/call.py:150-155, :237-239, :250-256`

Against the stated rule that only a long idle ends a call, and then with a spoken goodbye, three paths hang up on a live caller in silence: three consecutive recognition failures with no eligible fallback, a synthesis failure with no fallback, and any unexpected exception. After-hours tenants have no transfer targets, so they hit this on the first transcription outage. A fix is written and awaiting review.

**Fix** — Speak an apology and stay on the line, or hand the call back to the dialplan; never hang up on a live caller.

#### AI-3

**Where** — `services/receptionist/app/speech.py:118, :185-192`

Every synthesised sentence is written to the prompt directory and kept forever. Model answers are unique per call, so this is not a bounded cache: at roughly 100 KB per sentence and five sentences a call, a few hundred calls a day fills the volume on the SIP droplet. The TTS service has a janitor; the receptionist copy had none. A sweep is written and awaiting review.

**Fix** — Age and size ceiling with oldest-first eviction, swept on a timer off the call path. Deploy with OPS-7.

### Medium — a feature is broken, a setting is silently wrong, or an operator is shown the wrong customer

#### AI-4

**Where** — `services/receptionist/app/speech.py:241, :300`

Transcription was gated behind a single semaphore slot with a five-second admission timeout, so a second caller queued behind the first and a third exceeded the timeout and was counted as a recognition failure, three of which used to end the call. The receptionist was effectively single-concurrency. A change to two slots is written but it breaks the test that pins the old behaviour (see QA-1).

**Fix** — Size the gate from the container CPU quota, treat an admission timeout as backpressure rather than a recognition failure, and update the test to assert slot retention independently of the slot count.

#### AI-5

**Where** — `services/receptionist/app/call.py:447-451`

The uuid_record stop in the outer finally of _with_interruption can raise when the socket is already poisoned, replacing the original exception. A SpeechSynthesisError, which has a transfer-to-fallback recovery path, becomes an EslProtocolError, which only logs and releases, so the caller is dropped instead of being put through to a person.

**Fix** — Wrap the stop in its own try/except and log rather than propagate.

### Low — dead code, a cosmetic defect, or a latent hazard

#### AI-6

**Where** — `services/receptionist/app/config.py:137`

idle_hangup_seconds was clamped to a maximum of 90, its own default, so an operator asking for a longer window silently got ninety seconds. A caller looking up an order number or fetching a colleague is not a caller who walked away. A change is written and awaiting review.

**Fix** — Raise the ceiling and document the intended maximum.

### Verify — a credible defect that could not be proved from the source alone — needs a live call, a physical device or a packet capture

#### AI-7

**Where** — `services/receptionist/app/call.py:199`

The transfer path awaits CHANNEL_EXECUTE_COMPLETE with a ten-second timeout. If real FreeSWITCH tears the outbound socket down on transfer before emitting that event, _transfer raises and the call is filed as caller_hung_up with an empty transferredTo. The test double emits the event before closing, so the suite cannot see this.

**Fix** — Confirm on a live call and record the transfer outcome before awaiting the event.

#### AI-8

**Where** — `services/receptionist/app/call.py:393`

enable_file_write_buffering=false is set inside _with_interruption and never restored, so it also applies to the record in _listen for the rest of the call.

**Fix** — Restore the previous value, or confirm the wider setting is intended.

### Deliverable — the role brief asks for it and it does not exist yet

#### AI-9

**Where** — `Role deliverable: measured latency and concurrency`

There is no harness measuring first-audio latency, time from end of caller speech to first spoken syllable, or behaviour at N concurrent calls, which is exactly what the role is meant to prove and what the reported "conversation feedback takes longer" complaint needs to be judged against.

**Fix** — Build a repeatable latency and concurrency benchmark and publish a baseline.

---

## How these findings were produced

Four independent line-by-line reviews were run against the current head of `main`, one per surface (API, web, mobile, SIP edge and services), each asked to confirm every finding by reading the code path end to end on both sides of any boundary, and to separate what it could prove from what it could not. The build, typecheck and test suites were run for each surface. Live evidence came from the SIP edge itself: a call trace covering ninety minutes of real traffic, which confirmed the receptionist answering, hold music and the speech bed loading, and a caller ending a 109-second conversation normally.

No penetration testing was performed, no physical iOS or Android device was exercised, and no packet captures were taken. Those gaps are why several items are marked *Verify*.
