from __future__ import annotations

import hashlib
import hmac
import io
import logging
import os
import queue
import re
import secrets
import threading
import time
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from kokoro import KPipeline
from pydantic import BaseModel, Field

log = logging.getLogger("vocivo.tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

try:  # pragma: no cover - torch is present wherever Kokoro is
    import torch

    # The container runs on a slice of the SIP edge's CPUs (--cpus 1.5). Left to
    # itself torch starts one thread per *host* core and the cgroup throttles
    # them all, which is slower than using the slice properly: a three-second
    # sentence took ten seconds to render.
    torch.set_num_threads(max(1, int(os.getenv("TTS_TORCH_THREADS", "2"))))
    torch.set_num_interop_threads(1)
except Exception as error:  # noqa: BLE001
    log.warning("could not tune torch threads: %s", error)

app = FastAPI(title="Vocivo Voice Engine", version="1.1.0")
cache_dir = Path(os.getenv("TTS_CACHE_DIR", "/var/cache/vocivo-tts"))
cache_dir.mkdir(parents=True, exist_ok=True)
public_base_url = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
cache_ttl_seconds = max(1, int(os.getenv("TTS_CACHE_TTL_DAYS", "30"))) * 86400
# The edge has a small disk and every rendered sentence is kept. Held under a
# ceiling as well as under an age, and swept on a timer rather than in a
# request.
cache_max_bytes = max(64, int(os.getenv("TTS_CACHE_MAX_MB", "2048"))) * 1024 * 1024
cache_sweep_seconds = max(60, int(os.getenv("TTS_CACHE_SWEEP_SECONDS", "3600")))
service_secret = os.getenv("TTS_SERVICE_SECRET", "")
# Languages whose pipeline is built when the process starts rather than on the
# first caller's greeting. American English is what every default prompt uses.
warm_languages = [code.strip() for code in os.getenv("TTS_WARM_LANGUAGES", "a").split(",") if code.strip()]
pipelines: dict[str, KPipeline] = {}
pipelines_lock = threading.Lock()

# Kokoro runs on a slice of the SIP edge's CPU and its pipeline is not
# documented as thread-safe, so synthesis is serialised. Two callers arriving
# together wait for each other rather than both slowing to a crawl.
synth_lock = threading.Lock()
# One render per prompt even when several calls ask for the same unseen text
# at once: the second waits for the first and then reads the cached file.
# Stable striped locks bound memory without evicting a lock another request
# has obtained but has not acquired yet. Hash collisions only serialize work.
render_locks = tuple(threading.Lock() for _ in range(512))

ready = threading.Event()
warm_error = ""

# A cache entry is named by its sha256; what the public route serves is named
# by sixteen random bytes. The two are different lengths on purpose, so a
# content address can never be presented as a public name.
_CACHE_KEY = re.compile(r"[0-9a-f]{64}")
_PUBLIC_ID = re.compile(r"[0-9a-f]{32}")

# Kokoro's voice packs, the same 37 the API offers as Vocivo.Kokoro.<Name>.
# The first letter of a voice id is its language: a American English,
# b British English, e Spanish, f French, i Italian, p Brazilian Portuguese.
# The service knew four of these and answered "Unknown voice" for the other
# thirty-three a tenant could pick in the admin.
_LANGUAGES = {"a": "English", "b": "English", "e": "Spanish", "f": "French", "i": "Italian", "p": "Portuguese"}
_VOICE_NAMES = {
    "af_heart": "Amina", "af_alloy": "Alloy", "af_aoede": "Aoede", "af_bella": "Bella", "af_jessica": "Jessica",
    "af_kore": "Kore", "af_nicole": "Nicole", "af_nova": "Nova", "af_river": "River", "af_sarah": "Sarah", "af_sky": "Sky",
    "am_adam": "Adam", "am_echo": "Echo", "am_eric": "Eric", "am_fenrir": "Fenrir", "am_liam": "Liam",
    "am_michael": "Michael", "am_onyx": "Onyx", "am_puck": "Puck", "am_santa": "Nicholas",
    "bf_alice": "Alice", "bf_emma": "Emma", "bf_isabella": "Isabella", "bf_lily": "Lily",
    "bm_daniel": "Daniel", "bm_fable": "Fable", "bm_george": "George", "bm_lewis": "Lewis",
    "ef_dora": "Dora", "em_alex": "Alex", "em_santa": "Santiago",
    "ff_siwis": "Siwis",
    "if_sara": "Sara", "im_nicola": "Nicola",
    "pf_dora": "Dora BR", "pm_alex": "Alex BR", "pm_santa": "Mateus",
}
voices = {
    voice_id: {
        "name": name,
        "gender": "female" if voice_id[1] == "f" else "male",
        "language": _LANGUAGES[voice_id[0]],
        "lang_code": voice_id[0],
    }
    for voice_id, name in _VOICE_NAMES.items()
}


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=2000)
    voice: str = "af_heart"
    speed: float = Field(default=1.0, ge=0.7, le=1.3)
    format: str = "wav"


class PrerenderRequest(BaseModel):
    """A batch of prompts to have ready before anyone calls."""

    items: list[SpeechRequest] = Field(min_length=1, max_length=64)


def authorize(authorization: str | None = Header(default=None)) -> None:
    # Fail closed: an unset TTS_SERVICE_SECRET must never mean an open service.
    if not service_secret:
        raise HTTPException(status_code=503, detail="TTS_SERVICE_SECRET is not configured")
    expected = f"Bearer {service_secret}"
    if authorization is None or not hmac.compare_digest(authorization.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")


def pipeline_for(lang_code: str) -> KPipeline:
    with pipelines_lock:
        if lang_code not in pipelines:
            try:
                started = time.monotonic()
                pipelines[lang_code] = KPipeline(lang_code=lang_code)
                log.info("pipeline for language %s ready in %.1fs", lang_code, time.monotonic() - started)
            except Exception as error:  # noqa: BLE001 - a language this image cannot speak is a clear answer, not a crash
                raise HTTPException(status_code=503, detail=f"This deployment cannot speak language '{lang_code}': {error}") from error
        return pipelines[lang_code]


def synthesize(request: SpeechRequest) -> bytes:
    voice = voices.get(request.voice)
    if not voice:
        raise HTTPException(status_code=400, detail="Unknown voice")
    pipeline = pipeline_for(voice["lang_code"])
    started = time.monotonic()
    with synth_lock:
        chunks = [audio for _, _, audio in pipeline(request.input, voice=request.voice, speed=request.speed)]
    if not chunks:
        raise HTTPException(status_code=500, detail="Voice engine returned no audio")
    audio = np.concatenate(chunks)
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all() or not np.any(audio):
        raise HTTPException(status_code=503, detail="Voice engine returned invalid or silent audio")
    log.info("rendered %d chars as %s in %.1fs (%.1fs of audio)", len(request.input), request.voice, time.monotonic() - started, len(audio) / 24000)
    buffer = io.BytesIO()
    sf.write(buffer, audio, 24000, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def evict_stale_cache_entries() -> None:
    """
    Keeps the content-addressed cache inside its age and its size.

    It used to be swept only from /v1/audio/render, which is the carrier's
    path — on Vocivo's own edge every prompt goes through /v1/audio/speech and
    the prerender queue, and nothing ever removed a file. Age alone would not
    have been enough either: a busy tenant's month of prompts is a lot of disk
    on a droplet this size, so the oldest go once the total is over the limit.

    Called from a janitor thread rather than from a request: the sweep is a
    stat of every file in the directory, which does not belong in the path a
    caller is waiting on.
    """
    cutoff = time.time() - cache_ttl_seconds
    try:
        entries = []
        for entry in cache_dir.iterdir():
            if entry.suffix != ".wav" or not entry.is_file():
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            if stat.st_mtime < cutoff:
                _forget(entry)
                continue
            entries.append((stat.st_mtime, stat.st_size, entry))
        total = sum(size for _, size, _ in entries)
        if total <= cache_max_bytes:
            return
        # Oldest first until the cache is back under the limit. A prompt that
        # is still in use is rendered again the next time it is asked for.
        for _, size, entry in sorted(entries):
            if total <= cache_max_bytes:
                break
            _forget(entry)
            total -= size
    except OSError:
        pass  # eviction is best-effort; synthesis must never fail because of it


def _forget(entry: Path) -> None:
    """Removes a cache entry and the public name that pointed at it."""
    pointer = entry.with_suffix(".pub")
    try:
        public_id = pointer.read_text().strip()
    except OSError:
        public_id = ""
    if _PUBLIC_ID.fullmatch(public_id):
        (cache_dir / f"{public_id}.ref").unlink(missing_ok=True)
    pointer.unlink(missing_ok=True)
    entry.unlink(missing_ok=True)


def _cache_janitor() -> None:
    while True:
        time.sleep(cache_sweep_seconds)
        evict_stale_cache_entries()


def cache_key(request: SpeechRequest) -> str:
    return hashlib.sha256(f"{request.voice}|{request.speed}|{request.input}".encode()).hexdigest()


def public_id_for(path: Path) -> str:
    """
    The name the rendered audio is served under, which is deliberately not its
    cache key.

    /v1/audio/<id>.wav is the one route without a bearer token — it has to be,
    because the URL is played by a carrier and opened by a browser — and while
    the id was the cache key, that key was sha256 of voice, speed and the text.
    Both halves of a tenant's greeting are audible to anyone who rings the
    number, so anyone who had heard it could compute the id and fetch that
    tenant's rendered prompts from the public base URL, and could walk the
    fixed canned phrases across all thirty-seven voices without hearing
    anything at all. A random name cannot be derived from the audio.

    The name is kept beside the cache entry so a prompt rendered a second time
    keeps the URL the API already handed out, and a `.ref` file points back at
    the cache entry the route must serve.
    """
    pointer = path.with_suffix(".pub")
    try:
        existing = pointer.read_text().strip()
        if _PUBLIC_ID.fullmatch(existing) and (cache_dir / f"{existing}.ref").is_file():
            return existing
    except OSError:
        pass
    public_id = secrets.token_hex(16)
    _write_atomically(cache_dir / f"{public_id}.ref", path.stem)
    _write_atomically(pointer, public_id)
    return public_id


def _write_atomically(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.urandom(4).hex()}.tmp")
    temporary.write_text(text)
    os.replace(temporary, path)


def cached_path_for_public_id(public_id: str) -> Path | None:
    """The cache entry a public name stands for, or nothing if it names none."""
    if not _PUBLIC_ID.fullmatch(public_id):
        return None
    try:
        key = (cache_dir / f"{public_id}.ref").read_text().strip()
    except OSError:
        return None
    if not _CACHE_KEY.fullmatch(key):
        return None
    return cache_dir / f"{key}.wav"


def cached_path(request: SpeechRequest) -> Path:
    return cache_dir / f"{cache_key(request)}.wav"


def is_cached(request: SpeechRequest) -> bool:
    path = cached_path(request)
    try:
        if not path.is_file():
            return False
        with wave.open(str(path), "rb") as audio:
            frames = audio.getnframes()
            return (frames > 0 and audio.getnchannels() == 1 and audio.getsampwidth() == 2
                    and audio.getframerate() == 24000 and len(audio.readframes(frames)) == frames * 2)
    except (OSError, EOFError, wave.Error):
        return False


def _render_lock(key: str) -> threading.Lock:
    return render_locks[int(key, 16) % len(render_locks)]


def render_to_cache(request: SpeechRequest) -> Path:
    """
    Every endpoint speaks through here, so a greeting rendered once for the
    receptionist is the same file the dialplan and the admin preview play. The
    first caller after a deploy used to pay for the model download and the
    render; now the render happens once, and ideally before the call.
    """
    path = cached_path(request)
    if is_cached(request):
        path.touch()
        return path
    with _render_lock(path.stem):
        if is_cached(request):
            return path
        audio_bytes = synthesize(request)
        temp_path = path.with_name(f".{path.stem}.{os.urandom(4).hex()}.tmp")
        temp_path.write_bytes(audio_bytes)
        os.replace(temp_path, path)  # atomic publish: readers never see a partial file
    return path


# -- background rendering ------------------------------------------------

prerender_queue: queue.Queue[SpeechRequest] = queue.Queue(maxsize=256)
prerender_pending: set[str] = set()
prerender_guard = threading.Lock()


def _prerender_worker() -> None:
    while True:
        request = prerender_queue.get()
        key = cache_key(request)
        try:
            if not is_cached(request):
                render_to_cache(request)
        except Exception as error:  # noqa: BLE001 - a prompt that cannot be pre-rendered is rendered at call time instead
            log.warning("could not pre-render %d characters as %s (%s)", len(request.input), request.voice, type(error).__name__)
        finally:
            with prerender_guard:
                prerender_pending.discard(key)
            prerender_queue.task_done()


def _warm_up() -> None:
    global warm_error
    try:
        for code in warm_languages:
            pipeline_for(code)
        # A first synthesis loads the voice pack and primes torch; without it
        # the first caller's greeting still starts several seconds late.
        # A persistent cache hit says nothing about this process's inference
        # readiness. Exercise the model even when this prompt is already cached.
        synthesize(SpeechRequest(input="Thank you for calling.", voice="af_heart"))
        ready.set()
        log.info("voice engine warm")
    except Exception as error:  # noqa: BLE001 - the service still answers; /health says why it is cold
        warm_error = str(error)[:300]
        log.error("voice engine warm-up failed: %s", error)


@app.on_event("startup")
def start_background_work() -> None:
    threading.Thread(target=_prerender_worker, name="prerender", daemon=True).start()
    threading.Thread(target=_warm_up, name="warm-up", daemon=True).start()
    threading.Thread(target=_cache_janitor, name="cache-janitor", daemon=True).start()


# -- HTTP ----------------------------------------------------------------


@app.get("/health")
def health(_: None = Depends(authorize)) -> dict:
    return {
        "status": "healthy",
        "engine": "Kokoro-82M",
        "license": "Apache-2.0",
        # ready means the model is loaded and a synthesis has completed, so a
        # prompt that is not cached still starts within a couple of seconds.
        "ready": ready.is_set(),
        "warmError": warm_error,
        "languages": sorted(pipelines.keys()),
        "prerenderQueue": prerender_queue.qsize(),
    }


@app.get("/v1/voices")
def list_voices(_: None = Depends(authorize)) -> dict:
    return {"voices": [{"id": key, **value} for key, value in voices.items()]}


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest, _: None = Depends(authorize)) -> Response:
    path = render_to_cache(request)
    return Response(path.read_bytes(), media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/v1/audio/render")
def render(request: SpeechRequest, _: None = Depends(authorize)) -> dict:
    if not public_base_url.startswith("https://"):
        raise HTTPException(status_code=503, detail="PUBLIC_BASE_URL must be configured with HTTPS")
    was_cached = is_cached(request)
    path = render_to_cache(request)
    public_id = public_id_for(path)
    return {"id": public_id, "audio_url": f"{public_base_url}/v1/audio/{public_id}.wav", "cached": was_cached}


@app.post("/v1/audio/prerender", status_code=202)
def prerender(request: PrerenderRequest, _: None = Depends(authorize)) -> dict:
    """
    Queues prompts so they are on disk before the first call needs them. Saving
    a greeting in the admin calls this; the caller who rings a minute later
    hears it at once instead of after a cold render.
    """
    queued = 0
    cached = 0
    for item in request.items:
        if item.voice not in voices:
            continue
        if is_cached(item):
            cached += 1
            continue
        key = cache_key(item)
        with prerender_guard:
            if key in prerender_pending:
                continue
            try:
                prerender_queue.put_nowait(item)
            except queue.Full:
                # Prewarming is optional; live requests can still render.
                continue
            prerender_pending.add(key)
        queued += 1
    return {"queued": queued, "cached": cached}


@app.get("/v1/audio/{audio_id}.wav")
def audio(audio_id: str) -> FileResponse:
    # The one route with no bearer token, because the carrier and the browser
    # play the URL directly. It answers only to a name /v1/audio/render made
    # up, never to a cache key: see public_id_for.
    path = cached_path_for_public_id(audio_id)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "public, max-age=31536000, immutable"})
