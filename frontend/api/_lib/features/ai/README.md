# AI Receptionist and Speech

The optional OpenAI `gpt-live-1` runtime is configured on the SIP host, not by
the local TTS voice picker. It keeps tenant policy/transfer validation here.
See [activation, privacy and acceptance gates](../../../../../docs/runbooks/openai-live-receptionist.md).

`receptionist.ts::receptionistFor` resolves tenant-specific AI settings and transfer
targets. `transferTargets` uses active directory users. `parseConversation`
validates the conversation contract. `routes/voice-receptionist.ts` is the service
boundary; the streaming conversation runtime is `services/receptionist/`.

`voice-catalog.ts` maps voice IDs and renders prompts through the configured TTS
service. `prompt-prerender.ts` splits/cache-warms prompts; it must not block live
conversation on unrelated long rendering work. `ai-transfer.ts` builds managed
assistant tools/instructions and `ai-transfer-token.ts` signs call-bound transfers.
`routes/admin-ai.ts`, `admin-voices.ts`, `voice-ai-transfer.ts` and `ai-replies.ts`
provide configuration, preview, transfer and reply APIs.

`receptionistFor` also gives the receptionist the tenant's opening hours in
spoken form (`describeOfficeHours` → `officeHoursText`, e.g. "Monday to Friday,
9 am to 5 pm; Saturday, 10 am to 2:30 pm. Closed Sunday.") and the timezone, so
the most common question a receptionist gets is answered rather than transferred.

`receptionistVoice` → `spokenVoice`: a voice the engine's authors grade below
B- (see `voice-catalog.ts` `quality`) is answered by the best-graded voice in
the same language; the admin's choice is kept in the config and honoured again
if the engine improves it. The first tenant went live on Adam (F+), which is
what "sounds fake" was.

Run frontend tests, then receptionist/TTS service suites when modifying speech
flow. Test real playback/transfer separately; a successful JSON reply is not audio.


`caller_went_quiet` is a recognized receptionist outcome, not a service error.
The pre-render phrase list matches the Python canned prompts and fillers.
Opening-hours descriptions only compress consecutive closed days into ranges.
The voice quality field is a static catalog grade, not a measured MOS score;
Spanish, Italian and Portuguese currently have no B- or better catalog fallback.


`createAiTransferHandler` exposes injected dependencies for route regressions.
A signed request still checks the current AI enabled/transfer flags, assistant id
and extension tenant. Destinations must be exact 2–5 digit strings. A pre-dial
failure after stopping the assistant attempts to resume the stored assistant.
Failures without a routing claim cannot stop playback. Once a dial was attempted,
the claim is retained and playback is left alone because a lost response does not
prove that no leg was created; carrier reconciliation remains an acceptance gate.

Self-hosted transfer targets also reject malformed extensions and blank SIP
identities. API prewarming preserves titles and numbered-sentence boundaries using
the Python splitter's rules, so these phrases hit the same cache.
