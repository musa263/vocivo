# Vocivo receptionist

The AI receptionist, running on Vocivo's own hardware.

Every part of a call is handled here except one. FreeSWITCH carries the audio,
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) hears what the
caller said, and the Kokoro service on the same droplet says the reply. Only
the language-model turn leaves the machine, as one HTTPS request carrying the
conversation. Nothing is sent to a carrier, nothing is billed per minute, and temporary caller recordings stay on infrastructure Vocivo controls. The
conversation text and tenant brief are sent to the configured language-model provider;
transcripts are also filed to the Vocivo API.

## How a call runs

FreeSWITCH's dialplan hands the call over with `socket 127.0.0.1:8084 async
full`, which opens an Event Socket connection to this service — one connection
per call. From there:

1. Ask the Vocivo API which receptionist answers the number that was dialled.
   No receptionist means the call is released, not answered by a default agent
   that belongs to nobody.
2. Answer, and play the tenant's greeting.
3. Take turns. `record` with silence detection ends when the caller stops
   talking; the recording is transcribed, the conversation goes to the model,
   and the reply is synthesised and played.
4. Act on what the model decided: keep talking, transfer to an extension, take
   a message, or say goodbye — and stay on the line. The receptionist never
   hangs up on a caller; the caller ends the call.
5. File the transcript back to the API.

A transfer is a blind transfer back into the same dialplan, so the rules that
route an ordinary internal call decide where it lands — the receptionist can
never reach somewhere a colleague could not.

## The parts that matter

**Prompts are cached by content.** A receptionist says "Thanks, please hold"
thousands of times. Synthesising it once is the difference between a natural
pause and a second of dead air on every call.

**The caller's audio is not kept.** Each turn's recording is transcribed and
then deleted. The transcript is what the tenant sees.

**A hallucinated extension is refused.** The model may only transfer to
extensions on the tenant's own list, and only to ones somebody can actually
answer — an active extension with a SIP username. A caller told they are being
put through to nobody is worse than one told to leave a message.

**When the model cannot be reached, a person is.** The fallback is a transfer
to the tenant's fallback extension, or taking a message — never an apology
loop.

**Speech recognition runs in a worker thread.** It is CPU-bound and shares a
process with live calls; on the event loop it would stall them.

**The model streams, and the first sentence is spoken as soon as it is
written.** `Brain.respond` reads the reply as server-sent events and calls
`on_first_sentence` the moment the first sentence is complete;
`CallHandler._think` hands that sentence to the voice engine while the rest of
the answer is still arriving, so playback starts at once. A filler ("mm-hm, one
moment") is said only when nothing has begun to arrive after three seconds.

**Only the caller's side is recorded.** `RECORD_READ_ONLY=true` keeps our own
prompts (and their echo) out of the turn recording — the recogniser used to
hear the greeting back and answer it. `RECORD_MIN_SEC=0` keeps one-word answers
FreeSWITCH would otherwise delete. Turns cap at `listen_seconds` (12 s) and end
`silence_seconds` (1 s) after the caller stops; the silence threshold (450)
sits above a mobile caller's background noise.

**Hallucinated transcripts are dropped.** `drop_hallucinated_transcript`
discards an exact long greeting echo or distinctive video-caption fillers.
Names, short answers, "Thank you" and "Bye" are retained: text matching alone
cannot establish that these were hallucinated.

**A transfer nobody answers comes back here.** `_transfer` sets
`vocivo_from_receptionist=1`; the API's dialplan returns the call with
`vocivo_transfer_failed=1`, and `handle` opens with `CANNED["transfer_unanswered"]`
— an offer to take a message — instead of the greeting.

**There is no turn budget, and the receptionist never hangs up.** A
conversation lasts as long as the caller needs; the model's `wrap_up` tool says
goodbye and leaves the line open for the caller to put down. Silence is met
with two gentle prompts and then patience. The one exception is a line nobody
has spoken on for `idle_hangup_seconds` (90 s) — a caller who walked away —
which triggers cancellation even during stalled AI work. A best-effort goodbye
has a three-second budget, following a two-second playback-break budget, and
hangup has a three-second command budget. These are teardown grace periods,
not a guarantee of physical release at exactly 90 seconds.

**Answers play without stops.** `_speak` sends every sentence to the voice
engine at once (two at a time) and, whenever the next sentence is already
rendered when the current one ends, hands both to FreeSWITCH as a single
`file_string://` playback — no round trip, no gap. Rendering one sentence
ahead and playing them one file at a time left a beat of silence between
every sentence.

**Every stage logs its time.** Per turn: how long the recorder ran (and whether
it hit its limit), loudness, recognition time, model time, when the first
sentence was ready, and synthesis time per sentence; per call: the outcome.
`Ops · Droplets → call-trace` prints these beside FreeSWITCH's hangup causes.

## Speech interruptions

During greetings and normal responses, `record_session` captures only inbound
8 kHz mono PCM into a temporary `.r8` file on the existing shared audio volume.
File write buffering is disabled. The service inspects 20 ms frames, requires
120 ms of sustained energy, and keeps 200 ms of pre-roll. When the caller
interrupts, pending model/TTS tasks are cancelled and `uuid_break ... all`
stops playback. The captured utterance becomes the next caller turn; an
interrupted transfer or message decision is not executed. Temporary audio is
deleted on completion, cancellation, and errors.

The detector is an energy gate, not a speech classifier or echo canceller.
Tune it with quiet and noisy handset calls. A higher threshold or longer onset
window reduces false interruptions at the cost of slower response. FreeSWITCH
must have `mod_sndfile` with `.r8` support and share the audio directory with
the receptionist. Missing inbound frames are logged and the response continues
in sequential mode. Silence/error prompts outside normal responses still use
sequential playback. Live interruption timing depends on the media and file
writer; 20 ms is the processing frame size, not a measured end-to-end guarantee.

## Configuration

| Variable | Required | What it is |
| --- | --- | --- |
| `TTS_SERVICE_SECRET` | yes | Bearer for the Kokoro service |
| `LLM_API_KEY` | yes | The one external credential |
| `SIP_EDGE_SECRET` | yes | Shared with Kamailio, authenticates to the Vocivo API |
| `TTS_SERVICE_URL` | | Default `http://127.0.0.1:8000` — loopback on the SIP edge |
| `STT_MODEL` | | `base` fits beside a live SIP process; `small` is better and wants its own box |
| `LLM_MODEL` | | Default `claude-haiku-4-5` |
| `RECEPTIONIST_PORT` | | Default 8084 |
| `RECEPTIONIST_LISTEN_SECONDS` | | Longest single caller turn, default 12 seconds |
| `RECEPTIONIST_SILENCE_SECONDS` | | Silence that ends an ordinary recorded turn, default 1 second |
| `RECEPTIONIST_BARGE_IN` | | Enable speech interruption during greetings and model responses, default 1; set 0 for the sequential fallback |
| `RECEPTIONIST_BARGE_IN_THRESHOLD` | | PCM RMS threshold for speech onset, default 650 |
| `RECEPTIONIST_BARGE_IN_ONSET_MS` | | Sustained speech required to interrupt, default 120 ms |
| `RECEPTIONIST_BARGE_IN_SILENCE_MS` | | Quiet period ending an interruption recording, default 600 ms |
| `RECEPTIONIST_MAX_TURNS` | | Legacy setting; no longer limits conversation turns |

The service refuses to start without the three required values, rather than
failing halfway through a stranger's call.

## Where it listens

`127.0.0.1:8084`, and that is the default rather than something the deployment
has to remember. The Event Socket has no authentication in outbound mode, so a
process that can reach this port can answer calls — and the SIP droplet has no
host firewall, so binding `0.0.0.0` would have put it on the public internet.
Both this service and FreeSWITCH run with host networking, so loopback is all
either of them needs.

## Tests

```
python3 -m unittest discover -s tests
```

They cover the Event Socket framing (including a hangup arriving in the middle
of another command, which must not be lost), the decision the model's response
maps to, and the guards around transfers.

## AI failure and quality contracts

The model request has a 20-second total deadline, including streamed events.
Explicit stream errors, missing `message_stop`, and malformed tool JSON enter
recovery. One transient failure asks the caller to repeat; a second uses the
allowed open-office fallback. Without one, subsequent caller utterances are
saved as messages without another model request. The full transcript is retained
for filing; model context uses at most 40 recent turns, 24,000 characters total,
and 6,000 per turn. Missing history must be clarified rather than invented.

Text openings play while the model is still generating, and are removed from
remaining playback without removing them from the transcript. Tool announcements
wait for decision validation. A TTS failure no longer silently skips required
speech: it transfers to the authorized fallback or releases the call. Three
consecutive ASR failures follow the same fallback/release policy.

ASR permits one native inference at a time, with five seconds to acquire a slot
and a 20-second response deadline. Cancelled inference retains its slot until
the worker actually exits; its input is owned bytes so recording deletion cannot
race decoding. This bounds native work; it does not prove hardware capacity.

The idle watchdog resets on accepted caller audio or transcription, including
barge-in, and never on the assistant's playback. Environment values are clamped
to 1–90 seconds. VAD false positives remain a handset acceptance concern.

Logs contain call correlation and stage timings, not ordinary transcript text,
caller numbers or provider response bodies. The first-sentence metric starts at
the model request; it is not end-to-end first-word latency. Playback timing and
MOS still require real audio measurements. See
[the AI quality audit](../../docs/audits/ai-quality-2026-09-07.md).

Use Python 3.11 (the container runtime) or newer for service validation. Tests
also run without downloading Whisper models; inference and carrier behavior
are mocked. The new `tests/test_ai_quality.py` covers stream failures, short
answers, cancellation, context-independent message capture, and early playback.


## Second-sweep failure contracts

Malformed stream fields and unclosed content blocks enter model recovery.
Only one tool action may be executed per turn. Rejected transfers and empty
messages do not speak the model's success announcement. Missing ESL replies
close the unusable connection after a five-second acknowledgement budget;
missing application completions raise errors rather than advancing the turn.

Setup failure, cancellation and transcript-storage exceptions have separate
cleanup paths. Optional interruption-recording rejection falls back to sequential
speech; a disconnected caller is not spoken to. A failed transcript upload cannot
hang up a completed transfer. Startup errors close shared clients; shutdown stops
admission, allows five seconds for active calls, then cancels and awaits cleanup
before closing clients. Operators must allow time for cleanup beyond that grace
period; a force-kill cannot drain calls.

Fresh and cached speech WAVs must contain complete PCM16 frames. These checks
validate the audio container, not perceived speech quality. See
[the second-sweep report](../../docs/audits/ai-quality-sweep-2-2026-09-07.md)
for regression evidence and remaining acceptance gates.

Configuration outages now raise `ReceptionistUnavailable`, distinct from an
explicit 404/disabled assistant. A call already carrying trusted PBX tenant/DID
variables returns to the `unavailable` stage with receptionist recursion disabled.
If the API is still unavailable, the static FreeSWITCH stage provides a bounded
local announcement and ends the call; it never re-enters the AI loop. Without
that tenant/DID evidence the service releases the leg with a temporary-failure
cause. Interruption-recorder cleanup failures are logged without replacing the
original speech error, so the configured speech-failure fallback still runs.
