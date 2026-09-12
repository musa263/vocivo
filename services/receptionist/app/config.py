from __future__ import annotations

import os
import re
import base64
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """
    Everything the receptionist needs, read once at start-up.

    Nothing here has a default that would let the service run half-configured
    and fail in the middle of a customer's call. The two credentials are
    required; the rest describe where things live.
    """

    #: Where FreeSWITCH's outbound Event Socket connects. Loopback, and not
    #: configurable to anything else by accident: the Event Socket has no
    #: authentication in outbound mode, so a process that can reach this port
    #: can answer calls. The droplet has no host firewall.
    listen_host: str = "127.0.0.1"
    listen_port: int = 8084
    provider: str = "local"
    openai_api_key: str = ""
    openai_webhook_secret: str = ""
    openai_sip_uri: str = ""
    openai_voice: str = "marin"
    openai_backend_model: str = "gpt-5.6-luna"
    openai_webhook_port: int = 8091

    #: Vocivo's own speech engine. Loopback on the SIP edge; the public URL
    #: only exists for the web app.
    tts_url: str = "http://127.0.0.1:8000"
    tts_secret: str = ""
    tts_voice: str = "af_heart"

    #: Shared with the FreeSWITCH container: prompts are written here and
    #: played from here, and recordings arrive the same way.
    audio_dir: str = "/var/lib/vocivo-receptionist"

    #: How long a rendered prompt is kept, and how much disk the whole cache may
    #: use. Every sentence the receptionist speaks is content-addressed and kept
    #: so a repeated line is instant — but a model's answers are unique to their
    #: call, so without a ceiling the cache grows for as long as the service
    #: runs. This volume is on the same droplet as Kamailio, FreeSWITCH and
    #: rtpengine: filling it would take telephony down, not just the assistant.
    prompt_cache_seconds: int = 7 * 24 * 3600
    prompt_cache_max_bytes: int = 512 * 1024 * 1024
    prompt_cache_sweep_seconds: int = 900

    #: Conversation is dry speech by default, not hold music. An explicit
    #: operator setting can still opt into a FreeSWITCH-readable background bed.
    speech_bed: str = ""

    #: faster-whisper. "base" is enough for phone-band English and fits beside
    #: a live SIP process; "small" is better and wants its own box.
    stt_model: str = "base"
    stt_compute_type: str = "int8"
    stt_language: str = "en"
    #: How many turns may be transcribed at once, and how long a turn may wait
    #: for a free slot. Inference is CPU-bound, so the limit exists to keep it
    #: within the container's share — but set to one it also capped the service
    #: at a single concurrent caller.
    stt_concurrency: int = 2
    stt_queue_seconds: float = 12.0

    #: Local provider's reasoning service. The optional OpenAI Live provider
    #: also sends call audio to OpenAI and does not use these settings.
    llm_api_key: str = ""
    llm_model: str = "claude-haiku-4-5"
    llm_base_url: str = "https://api.anthropic.com"
    llm_max_tokens: int = 220
    #: Required by identity-linked API keys: the workspace the requests act in
    #: (console → Settings → Workspaces). A key of that kind without it is
    #: refused with 400 on every turn, and the receptionist could only ever
    #: apologise and transfer.
    llm_workspace_id: str = ""

    #: Vocivo's API, for the assistant's configuration and for logging the
    #: conversation back to the tenant.
    api_url: str = "https://vocivo.app"
    api_secret: str = ""

    #: Turn shape. A caller who says nothing twice is transferred or released
    #: rather than left listening to a machine ask again forever.
    greeting_timeout: float = 20.0
    #: The most one turn may run before the recogniser gets it. Anything a
    #: caller says in one breath fits; a long story arrives in pieces and the
    #: model follows along, rather than the caller waiting on a twenty-second
    #: recording every time silence detection misses.
    listen_seconds: int = 12
    #: Mean sample level below which a frame counts as silence. Speech on a
    #: phone line sits well above a thousand; a mobile caller's background
    #: sits around three hundred, which is why 300 never let a turn end.
    silence_threshold: int = 450
    #: How long the caller may pause before the receptionist takes it as the
    #: end of their turn. This is the floor on every reply's delay, so it is
    #: kept at the natural gap between speakers; the recorder no longer
    #: counts the caller's *thinking* time against it (see _listen), which is
    #: what used to cut people off.
    silence_seconds: int = 1
    #: Incoming audio is observed while the model and playback are running.
    barge_in: bool = True
    barge_in_threshold: int = 650
    barge_in_onset_ms: int = 120
    barge_in_silence_ms: int = 600
    #: How long to wait for the caller to *start* talking before treating the
    #: turn as silent. FreeSWITCH's recorder stops after `silence_seconds` of
    #: quiet whether or not anyone has spoken yet, and two seconds is less than
    #: most people take to answer "how can I help?".
    patience_seconds: int = 10
    #: Kept for older deployments' environment files; the conversation no
    #: longer has a turn budget.
    max_turns: int = 0
    #: The receptionist never hangs up on a caller. The only time it releases
    #: the line itself is after this long with nobody speaking — a caller who
    #: walked away from the phone — and it says goodbye first.
    idle_hangup_seconds: int = 90

    @classmethod
    def from_env(cls) -> "Settings":
        def text(name: str, fallback: str) -> str:
            # A value pasted with its quotes is a common way to break a key.
            return os.getenv(name, fallback).strip().strip("'\"").strip()

        def number(name: str, fallback: int) -> int:
            try:
                return int(os.getenv(name, "") or fallback)
            except ValueError:
                return fallback

        return cls(
            listen_host=text("RECEPTIONIST_HOST", cls.listen_host),
            listen_port=number("RECEPTIONIST_PORT", cls.listen_port),
            provider=text("RECEPTIONIST_PROVIDER", cls.provider),
            openai_api_key=text("OPENAI_API_KEY", ""),
            openai_webhook_secret=text("OPENAI_WEBHOOK_SECRET", ""),
            openai_sip_uri=text("OPENAI_LIVE_SIP_URI", ""),
            openai_voice=text("OPENAI_LIVE_VOICE", cls.openai_voice),
            openai_backend_model=text("OPENAI_LIVE_BACKEND_MODEL", cls.openai_backend_model),
            openai_webhook_port=number("OPENAI_LIVE_WEBHOOK_PORT", cls.openai_webhook_port),
            tts_url=text("TTS_SERVICE_URL", cls.tts_url).rstrip("/"),
            tts_secret=text("TTS_SERVICE_SECRET", ""),
            tts_voice=text("TTS_VOICE", cls.tts_voice),
            audio_dir=text("RECEPTIONIST_AUDIO_DIR", cls.audio_dir),
            prompt_cache_seconds=max(3600, number("RECEPTIONIST_PROMPT_CACHE_SECONDS", cls.prompt_cache_seconds)),
            prompt_cache_max_bytes=max(16 * 1024 * 1024, number("RECEPTIONIST_PROMPT_CACHE_MAX_BYTES", cls.prompt_cache_max_bytes)),
            prompt_cache_sweep_seconds=max(60, number("RECEPTIONIST_PROMPT_CACHE_SWEEP_SECONDS", cls.prompt_cache_sweep_seconds)),
            speech_bed=text("RECEPTIONIST_SPEECH_BED", cls.speech_bed),
            stt_model=text("STT_MODEL", cls.stt_model),
            stt_compute_type=text("STT_COMPUTE_TYPE", cls.stt_compute_type),
            stt_language=text("STT_LANGUAGE", cls.stt_language),
            stt_concurrency=max(1, min(8, number("STT_CONCURRENCY", cls.stt_concurrency))),
            stt_queue_seconds=max(1.0, float(number("STT_QUEUE_SECONDS", int(cls.stt_queue_seconds)))),
            llm_api_key=text("LLM_API_KEY", ""),
            llm_model=text("LLM_MODEL", cls.llm_model),
            llm_base_url=text("LLM_BASE_URL", cls.llm_base_url).rstrip("/"),
            llm_max_tokens=number("LLM_MAX_TOKENS", cls.llm_max_tokens),
            llm_workspace_id=text("LLM_WORKSPACE_ID", ""),
            api_url=text("VOCIVO_API_URL", cls.api_url).rstrip("/"),
            api_secret=text("SIP_EDGE_SECRET", ""),
            greeting_timeout=float(number("RECEPTIONIST_GREETING_TIMEOUT", int(cls.greeting_timeout))),
            listen_seconds=number("RECEPTIONIST_LISTEN_SECONDS", cls.listen_seconds),
            silence_threshold=number("RECEPTIONIST_SILENCE_THRESHOLD", cls.silence_threshold),
            silence_seconds=max(1, number("RECEPTIONIST_SILENCE_SECONDS", cls.silence_seconds)),
            barge_in=text("RECEPTIONIST_BARGE_IN", "1").lower() in {"1", "true", "yes"},
            barge_in_threshold=max(1, number("RECEPTIONIST_BARGE_IN_THRESHOLD", cls.barge_in_threshold)),
            barge_in_onset_ms=max(20, min(1000, number("RECEPTIONIST_BARGE_IN_ONSET_MS", cls.barge_in_onset_ms))),
            barge_in_silence_ms=max(100, number("RECEPTIONIST_BARGE_IN_SILENCE_MS", cls.barge_in_silence_ms)),
            patience_seconds=number("RECEPTIONIST_PATIENCE_SECONDS", cls.patience_seconds),
            max_turns=number("RECEPTIONIST_MAX_TURNS", cls.max_turns),
            # The ceiling used to be the default, so an operator who asked for a
            # longer window silently got ninety seconds. A caller looking up an
            # order number or fetching a colleague is not a caller who walked
            # away; an hour is the limit, to stop a forgotten line staying open.
            idle_hangup_seconds=max(1, min(3600, number("RECEPTIONIST_IDLE_HANGUP_SECONDS", cls.idle_hangup_seconds))),
        )

    def missing(self) -> list[str]:
        """Names of the settings without which a call cannot be handled."""
        gaps = []
        if self.listen_host != '127.0.0.1':
            gaps.append('RECEPTIONIST_HOST must be loopback')
        if self.provider not in {'local', 'openai-live'}:
            gaps.append('RECEPTIONIST_PROVIDER must be local or openai-live')
        if self.provider == 'openai-live':
            if not self.openai_api_key:
                gaps.append('OPENAI_API_KEY')
            if not self.openai_webhook_secret:
                gaps.append('OPENAI_WEBHOOK_SECRET')
            else:
                try:
                    if len(base64.b64decode(self.openai_webhook_secret.removeprefix('whsec_'), validate=True)) < 16:
                        raise ValueError('Short secret')
                except ValueError:
                    gaps.append('OPENAI_WEBHOOK_SECRET (valid base64 signing key)')
            if not re.fullmatch(r'sip:proj_[A-Za-z0-9_-]+@sip(?:-eu)?\.api\.openai\.com;transport=tls', self.openai_sip_uri):
                gaps.append('OPENAI_LIVE_SIP_URI (verified project SIP URI with TLS)')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', self.openai_voice):
                gaps.append('OPENAI_LIVE_VOICE')
            if not 1024 <= self.openai_webhook_port <= 65535 or self.openai_webhook_port == self.listen_port:
                gaps.append('OPENAI_LIVE_WEBHOOK_PORT')
            if not self.api_secret:
                gaps.append('SIP_EDGE_SECRET')
            return gaps
        if not self.tts_secret:
            gaps.append("TTS_SERVICE_SECRET")
        if not self.llm_api_key:
            gaps.append("LLM_API_KEY")
        if not self.api_secret:
            gaps.append("SIP_EDGE_SECRET")
        return gaps
