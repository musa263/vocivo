# OpenAI GPT-Live receptionist

## Status and ownership

An opt-in adapter implements the documented `gpt-live-1` SIP API, not Realtime
or a TTS voice replacement. **Not activated by this change or a Vercel deploy.**
The existing local receptionist remains the default. Project access, credentials,
TLS/SRTP and audible call acceptance are separate deployment gates.

Vocivo retains tenant authorization, DID routing, queues, transfers and the
FreeSWITCH caller leg. OpenAI receives the AI leg's audio, company instructions,
allowed colleague names and delegated messages. OpenAI usage is charged separately
from hosting and PSTN. Existing Kokoro previews remain local; that voice picker
does not configure GPT-Live.

## Flow and code

1. `app/main.py` selects `local` or `openai-live` before warming STT. Live skips
   local STT/TTS/LLM initialization.
2. `app/live.py` verifies the trusted FreeSWITCH tenant/DID against the API
   receptionist, creates a random single-call grant and originates an SRTP B leg.
3. `/openai/live/webhook` verifies the raw HMAC signature and timestamp before
   matching the pending grant. SIP From/To cannot authorize a tenant. Supported
   events: `live.transport.incoming` (SIP), legacy `live.call.incoming`.
4. A lock claims the acceptance decision before HTTP. The exact session ID is
   used for `/v1/live/sessions/{session_id}/accept` with `gpt-live-1`, `marin`
   and Responses delegation. Uncertain acceptance is not blindly retried.
5. Sideband `/v1/live/sessions/{session_id}/attach` observes tools/finalization;
   no second `session.start`. Function items wait for `response.completed` and
   tool IDs are reserved before side effects. Reasoning completion never ends
   the phone call.
6. Transfers re-fetch tenant policy and validate an exact allowed extension.
   FreeSWITCH `uuid_transfer` returns the caller to Vocivo's dialplan without
   blocking on the bridge execute lock. No arbitrary URI or default extension.
7. Confirmed messages use an idempotent company conversation event. Failed
   persistence returns unconfirmed, not saved.
8. Failed acceptance/sideband ends only the AI B leg; the caller can enter the
   existing unavailable route. Teardown waits up to 10 seconds for
   `session.closed`; missing finalization is recorded as incomplete.

Limits: one worker owns in-memory active grants (128 calls, 256 tool IDs/call).
Route its webhook to the same worker; do not distribute pending calls across
instances. Drain before restart. Durable multi-instance recovery is not included.
Full voice/backend usage reconciliation is not implemented: reports show unpriced
calls, not invented carrier costs or profit.

## Activation gates

1. Confirm **GPT-Live SIP is enabled on the OpenAI project**. Obtain the supported
   project SIP URI, voice/backend access, media ranges, regional requirements and
   pricing. Realtime SIP access alone is insufficient.
2. Build `services/receptionist/Dockerfile` (both requirements files). Retain the
   previous image and configuration for rollback.
3. Provision a mode-0600 server secrets file, outside Git and browser settings:

   ```text
   RECEPTIONIST_PROVIDER=openai-live
   OPENAI_API_KEY=<project server key>
   OPENAI_WEBHOOK_SECRET=<webhook signing secret>
   OPENAI_LIVE_SIP_URI=<verified project SIP URI;transport=tls>
   OPENAI_LIVE_VOICE=marin
   OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-luna
   OPENAI_LIVE_WEBHOOK_PORT=8091
   VOCIVO_API_URL=https://vocivo.app
   SIP_EDGE_SECRET=<existing edge API credential>
   ```

   Keep `RECEPTIONIST_HOST=127.0.0.1` and the existing host-network service model.
   Do not log or paste real secrets into shell history.
4. Provision `agent.pem` (certificate/private key) and `cafile.pem` (trusted CAs)
   in persistent `/etc/freeswitch/tls/openai-live/`. Only then enable
   `VOCIVO_OPENAI_LIVE_ENABLED=1` for FreeSWITCH. The optional profile listens
   on TLS 5093; existing carrier profiles are unchanged. Validate hostname/trust,
   DNS, egress TLS 5061, negotiated SDP and bidirectional SRTP against the actual
   project. Never disable verification to pass a test.
5. Reverse-proxy HTTPS **only** `/openai/live/webhook` to `127.0.0.1:8091`, keeping
   raw body and `webhook-*` headers, maximum 256 KiB and timeout sufficient for
   the 12-second acceptance request. Avoid logging grants/body data. Do not expose
   ESL ports 8084/8021. Subscribe the project endpoint to `live.transport.incoming`.
6. Coordinate profile activation, webhook routing and provider selection during
   a drained window. This runbook does not authorize production changes or calls.

## Acceptance and rollback

Install dependencies in an isolated environment and run
`python -B -m unittest discover -s services/receptionist/tests`. Fixtures exercise
signature tamper/expiry, duplicate accept, grants, cancellation, tenant changes,
exact transfers and failures. Mocked tests do not prove provider audio/interop.

Before promotion: test two tenants, speech/barge-in, long conversations, different
extensions, busy/unanswered transfer return, cancel during accept, lost sideband,
expired credentials, worker shutdown and final usage. Cover iOS, Android, web and
external callers. Measure actual first audio/two-way RTP, not UI timers. Approve
external audio/context processing and usage costs before customer activation.

Rollback after draining: restore `RECEPTIONIST_PROVIDER=local` with existing
TTS/LLM secrets and previous image, disable the optional profile, then remove
OpenAI webhook routing/subscription after in-flight deliveries drain. Do not
alter tenant destinations or silently change the carrier.

Official contracts checked September 2026:
- [GPT-Live SIP](https://developers.openai.com/api/docs/guides/voice-sip?api=live)
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [Sideband control](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
