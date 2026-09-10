from __future__ import annotations

import asyncio
import logging
import re
import time
import wave
from uuid import uuid4
from pathlib import Path

from .api import VocivoApi, AssistantUnavailable
from .brain import Assistant, Brain, Conversation, Decision
from .config import Settings
from .esl import EslConnection, EslProtocolError, channel_variable
from .idle import CallerIdleDeadline, CallerIdleTimeout
from .interruption import IncomingSpeech
from .speech import CANNED, FILLERS, Ears, SpeechRecognitionError, SpeechSynthesisError, Voice, drop_hallucinated_transcript, recording_stats, split_sentences

log = logging.getLogger("vocivo.call")

# One call, start to finish. Answer, greet, then take turns: listen until the
# caller stops talking, transcribe, think, speak. Transfer to a person the
# moment the caller wants one.


class CallHandler:
    def __init__(self, settings: Settings, voice: Voice, ears: Ears, brain: Brain, api: VocivoApi):
        self._settings = settings
        self._voice = voice
        self._ears = ears
        self._brain = brain
        self._api = api
        self._filler_index = 0

    async def handle(self, connection: EslConnection) -> None:
        try:
            await self._handle(connection)
        except asyncio.CancelledError:
            await self._release(connection)
            raise
        except Exception:
            log.exception("call setup or finalization failed")
            await self._release(connection)
        finally:
            await connection.close()

    async def _release(self, connection: EslConnection) -> None:
        try:
            await asyncio.wait_for(connection.hangup(), timeout=3)
        except Exception:
            log.warning("call release failed; closing Event Socket")

    async def _handle(self, connection: EslConnection) -> None:
        channel = await connection.connect()
        call_id = connection.uuid
        caller = channel_variable(channel, "Caller-Caller-ID-Number", "caller_id_number", "sip_from_user")
        dialled = channel_variable(channel, "Caller-Destination-Number", "destination_number", "sip_to_user")
        log.info("call %s received", call_id[:8])

        try:
            assistant = await self._api.assistant_for(dialled, caller)
        except AssistantUnavailable:
            # Only a call already assigned by the PBX can return to its
            # unavailable stage. Never invent a tenant or transfer target.
            organization = channel_variable(channel, "variable_vocivo_org", "vocivo_org")
            did = channel_variable(channel, "variable_vocivo_did", "vocivo_did")
            if organization and re.fullmatch(r"\+?[0-9]{5,15}", did):
                await connection.set("vocivo_from_receptionist", "0")
                await connection.set("vocivo_stage", "unavailable")
                await connection.execute("transfer", f"{did} XML public")
            else:
                await connection.hangup("NORMAL_TEMPORARY_FAILURE")
            return
        if assistant is None:
            log.warning("call %s has no receptionist; releasing the call", call_id[:8])
            await connection.hangup("NO_ROUTE_DESTINATION")
            return

        if channel_variable(channel, "Answer-State").lower() != "answered":
            await connection.execute("answer")
            # The carrier's media takes a moment to arrive after the answer; a
            # greeting that starts before it does loses its first word or two.
            # The dialplan usually answers before handing the call over, and
            # then this pause has already happened.
            await connection.execute("sleep", "400", timeout=5)
        # Narrowband is what the caller hears anyway, and it keeps recordings
        # small enough that transcription starts the moment they stop talking.
        await connection.set("record_sample_rate", "8000")
        await connection.set("playback_terminators", "none")
        # Only the caller's side. The recorder mixes both directions by default,
        # so our own prompts and their echo were in every turn recording — the
        # recogniser heard the greeting back and answered it.
        await connection.set("RECORD_READ_ONLY", "true")
        # The recorder deletes anything shorter than RECORD_MIN_SEC (three
        # seconds by default) as if nothing had been said. "Yes." is a second
        # long: the caller answered and was asked again.
        await connection.set("RECORD_MIN_SEC", "0")
        if self._settings.speech_bed:
            # Mixed ("m") into what the caller hears, looped ("l"), for the
            # whole call. The file is rendered quiet, so the voice sits on top
            # of it; the caller's side is untouched, so recognition is not.
            await connection.execute("displace_session", f"{self._settings.speech_bed} ml", timeout=5)

        conversation = Conversation(assistant=assistant, caller_number=caller)
        started = time.time()
        outcome = "completed"
        transferred_to = ""
        notes: list[str] = []

        # Everything this receptionist may say besides the greeting and the
        # model's answers is rendered now, in the background, so none of it is
        # a cold render later in the call.
        prerender = asyncio.create_task(self._voice.prerender([*CANNED.values(), *FILLERS], assistant.voice))

        pending_audio = b""
        try:
            if channel_variable(channel, "variable_vocivo_transfer_failed", "vocivo_transfer_failed") == "1":
                # Back from a transfer nobody answered. The caller already has
                # our attention; say so and carry on rather than greeting again.
                conversation.add("assistant", assistant.greeting)
                conversation.add("caller", "(the caller asked to be put through, and the receptionist transferred the call)")
                conversation.add("assistant", CANNED["transfer_unanswered"])
                _, pending_audio = await self._with_interruption(connection, lambda: self._speak(connection, CANNED["transfer_unanswered"], assistant.voice))
            else:
                _, pending_audio = await self._with_interruption(connection, lambda: self._speak(connection, assistant.greeting, assistant.voice))
                conversation.add("assistant", assistant.greeting)

            recognition_failures = 0
            silent_turns = 0
            last_heard = time.monotonic()
            wrapped_up = False
            # No turn budget, and the receptionist never hangs up on a caller:
            # the conversation lasts until the caller puts the phone down. The
            # one exception is a line nobody has spoken on for
            # `idle_hangup_seconds` — a caller who walked away — which is
            # released with a goodbye so it does not sit open for an hour.
            with CallerIdleDeadline(self._settings.idle_hangup_seconds) as idle:
                def caller_activity():
                    nonlocal last_heard
                    last_heard = time.monotonic()
                    idle.touch()

                while True:
                    if connection.hungup.is_set():
                        outcome = "caller_hung_up"
                        break

                    try:
                        if pending_audio:
                            audio, pending_audio = pending_audio, b""
                            caller_activity()
                            heard = await self._transcribe_pcm(audio, assistant)
                        else:
                            heard = await self._listen(connection, call_id, assistant, caller_activity)
                    except SpeechRecognitionError:
                        if connection.hungup.is_set():
                            outcome = "caller_hung_up"
                            break
                        recognition_failures += 1
                        if recognition_failures >= 3:
                            allowed = {target.extension for target in assistant.targets}
                            if assistant.office_open and assistant.transfer_enabled and assistant.fallback_extension in allowed:
                                await self._transfer(connection, assistant.fallback_extension, dialled)
                                transferred_to = assistant.fallback_extension
                                outcome = "transferred"
                                break
                            # Nobody to put them through to, and we still cannot
                            # hear them. Say so and keep listening: the caller
                            # decides when this call is over, not the software.
                            # If they have truly gone, the idle deadline ends it
                            # with a goodbye.
                            outcome = "error"
                            recognition_failures = 0
                            await self._speak(connection, CANNED["hearing_trouble"], assistant.voice)
                            continue
                        silent_turns = 0
                        await self._speak(connection, "Sorry, I couldn't process that. Could you repeat that, please?", assistant.voice)
                        continue
                    recognition_failures = 0
                    if connection.hungup.is_set():
                        outcome = "caller_hung_up"
                        break
                    if not heard:
                        silent_turns += 1
                        quiet_for = time.monotonic() - last_heard
                        if quiet_for >= self._settings.idle_hangup_seconds:
                            if not wrapped_up:
                                outcome = "caller_went_quiet"
                                await self._speak(connection, CANNED["goodbye_idle"], assistant.voice)
                            await connection.hangup()
                            break
                        if wrapped_up:
                            # Goodbyes have been said; the caller is hanging up in
                            # their own time. Stay on the line quietly.
                            continue
                        if silent_turns == 1:
                            await self._speak(connection, CANNED["not_heard"], assistant.voice)
                        elif silent_turns == 2:
                            await self._speak(connection, CANNED["still_here"], assistant.voice)
                        continue

                    silent_turns = 0
                    last_heard = time.monotonic()
                    idle.touch()
                    wrapped_up = False
                    conversation.add("caller", heard)
                    async def reply():
                        decision = await self._think(connection, conversation, assistant.voice)
                        await self._speak(connection, decision.say[len(decision.spoken_prefix):].lstrip(), assistant.voice)
                        return decision

                    decision, pending_audio = await self._with_interruption(connection, reply, caller_activity)
                    if decision is None:
                        if pending_audio:
                            conversation.add("assistant", "(response interrupted by the caller)")
                        continue
                    conversation.add("assistant", decision.say)
                    if decision.action == "transfer":
                        await self._transfer(connection, decision.extension, dialled)

                    if decision.action == "transfer":
                        transferred_to = decision.extension
                        outcome = "transferred"
                        break
                    if decision.action == "message":
                        outcome = "message_taken"
                        if decision.note:
                            notes.append(decision.note)
                        continue
                    if decision.action == "wrap_up":
                        # Goodbye has been said. The line stays open until the
                        # caller hangs up; anything more they say is answered.
                        wrapped_up = True
                        outcome = "message_taken" if notes else "completed"
                        continue
        except CallerIdleTimeout:
            outcome = "caller_went_quiet"
            # The deadline cancels pending recording/model/synthesis work. Do
            # not let a failed goodbye keep the channel alive indefinitely.
            try:
                await asyncio.wait_for(connection.api(f"uuid_break {connection.uuid} all"), timeout=2)
                await asyncio.wait_for(self._speak(connection, CANNED["goodbye_idle"], assistant.voice), timeout=3)
            except Exception:
                log.warning("call %s idle farewell unavailable", call_id[:8])
            finally:
                await asyncio.wait_for(connection.hangup(), timeout=3)
        except SpeechSynthesisError:
            # The receptionist has lost its voice. It cannot apologise, so the
            # caller must reach a person: transfer if there is one, otherwise
            # close the socket and let the dialplan ring the staff. Hanging up
            # would leave the caller with a dead line and no explanation.
            outcome = "error"
            allowed = {target.extension for target in assistant.targets}
            if assistant.office_open and assistant.transfer_enabled and assistant.fallback_extension in allowed:
                try:
                    await self._transfer(connection, assistant.fallback_extension, dialled)
                    transferred_to = assistant.fallback_extension
                    outcome = "transferred"
                except Exception:
                    log.exception("call %s voice failure fallback failed; leaving the call to the dialplan", call_id[:8])
            else:
                log.warning("call %s has no voice and nobody to transfer to; leaving the call to the dialplan", call_id[:8])
        except asyncio.CancelledError:
            outcome = "caller_hung_up" if connection.hungup.is_set() else "error"
            raise
        except EslProtocolError as error:
            if connection.hungup.is_set():
                outcome = "caller_hung_up"
            else:
                log.warning("call %s ESL command failed", call_id[:8])
                outcome = "error"
                await self._release(connection)
        except Exception as error:  # noqa: BLE001 - never leave a caller on a dead line
            # Something we did not anticipate. The caller is still on the line
            # and has done nothing wrong, so the call goes back to the dialplan
            # to ring the staff rather than being hung up on.
            log.exception("call %s failed: %s; leaving the call to the dialplan", call_id[:8], error)
            outcome = "error"
        finally:
            prerender.cancel()
            await asyncio.gather(prerender, return_exceptions=True)
            log.info("call %s ended: %s after %.0fs, %d turns%s", call_id[:8], outcome, time.time() - started, len(conversation.turns), f", transferred to {transferred_to}" if transferred_to else "")
            try:
                await self._api.record_conversation({
                    "callId": call_id,
                    "number": dialled,
                    "caller": caller,
                    "outcome": outcome,
                    "transferredTo": transferred_to,
                    "seconds": round(time.time() - started, 1),
                    "transcript": conversation.transcript(),
                    "note": "\n".join(notes),
                })
            except Exception:
                log.exception("call %s transcript could not be filed", call_id[:8])

    # -- the two halves of a turn ---------------------------------------

    async def _speak(self, connection: EslConnection, text: str, voice: str) -> None:
        """
        Says `text` without stops in the middle.

        Every piece of the answer is sent to the voice engine at once (two at
        a time, so they share the CPU rather than queue behind each other), and
        playback starts as soon as the first is on disk. When the next piece is
        ready by the time the current one ends, the two are handed to FreeSWITCH
        as one `file_string://` so there is no round trip — and no gap — between
        them. Rendering one piece ahead, and playing them one file at a time,
        left a beat of silence between every sentence: the "reading with long
        pauses" callers heard.
        """
        parts = split_sentences(text)
        if not parts:
            return
        gate = asyncio.Semaphore(2)

        async def render(part: str) -> Path | None:
            async with gate:
                try:
                    return await self._voice.say(part, voice)
                except Exception as error:  # noqa: BLE001
                    # Losing the voice engine mid-call is survivable; losing the call is not.
                    log.error("could not synthesise %d characters (%s)", len(part), type(error).__name__)
                    raise SpeechSynthesisError("Required speech could not be rendered") from error

        renders = [asyncio.create_task(render(part)) for part in parts]
        index = 0
        try:
            while index < len(renders):
                if connection.hungup.is_set():
                    return
                first = await renders[index]
                batch: list[Path] = [first] if first is not None else []
                index += 1
                # Everything already rendered follows in the same playback.
                while index < len(renders) and renders[index].done():
                    ready = renders[index].result()
                    if ready is not None:
                        batch.append(ready)
                    index += 1
                if not batch:
                    continue
                target = str(batch[0]) if len(batch) == 1 else "file_string://" + "!".join(str(path) for path in batch)
                await connection.execute("playback", target, timeout=self._settings.greeting_timeout + 40 * len(batch))
        finally:
            for task in renders:
                task.cancel()
            await asyncio.gather(*renders, return_exceptions=True)

    async def _think(self, connection: EslConnection, conversation: Conversation, voice: str) -> Decision:
        """
        Asks the model while saying a short filler.

        The model and the voice engine together take a few seconds; the filler
        covers most of that, and tells the caller they were heard. The answer's
        own synthesis starts as soon as the model replies, before the filler
        has finished, so the two overlap rather than add up.
        """
        # The model streams. Its first sentence goes to the voice engine the
        # moment it is complete — usually well under a second in — so by the
        # time the whole answer has arrived the opening is already on disk and
        # playback starts at once. Previously synthesis began only after the
        # entire reply, and that serial wait was most of the pause before every
        # answer.
        first_ready = asyncio.Event()
        early: list[asyncio.Task] = []
        first_sentence = ""
        first_sentence_seconds: float | None = None

        def render_first(sentence: str) -> None:
            nonlocal first_sentence_seconds, first_sentence
            if not early:
                first_sentence_seconds = time.monotonic() - thinking_started
                first_sentence = sentence
                early.append(asyncio.create_task(self._speak(connection, sentence, voice)))
            first_ready.set()

        thinking_started = time.monotonic()
        thinking = asyncio.create_task(self._brain.respond(conversation, render_first))
        # A filler ("one moment") only when the model has not even begun to
        # answer after a few seconds — the same phrase at the top of every
        # reply is what made the receptionist sound scripted, so it is kept
        # for the turns that would otherwise be dead air, and only those.
        waiter = asyncio.create_task(first_ready.wait())
        try:
            done, _ = await asyncio.wait({thinking, waiter}, timeout=3.5, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                filler = FILLERS[self._filler_index % len(FILLERS)]
                self._filler_index += 1
                await self._speak(connection, filler, voice)
            decision = await thinking
            model_seconds = time.monotonic() - thinking_started
            if early:
                await early[0]
                if decision.say.startswith(first_sentence):
                    decision.spoken_prefix = first_sentence
            log.info(
                "call %s model answered in %.1fs (%s), first sentence after model start: %s",
                connection.uuid[:8], model_seconds, decision.action,
                f"{first_sentence_seconds:.3f}s" if first_sentence_seconds is not None else "unavailable",
            )
            return decision

        finally:
            for task in [thinking, waiter, *early]:
                task.cancel()
            await asyncio.gather(thinking, waiter, *early, return_exceptions=True)

    async def _with_interruption(self, connection: EslConnection, respond, on_activity=None):
        if not self._settings.barge_in:
            return await respond(), b""
        path = Path(self._settings.audio_dir) / "turns" / f"incoming-{uuid4().hex}.r8"
        path.parent.mkdir(parents=True, exist_ok=True)
        # Disable FreeSWITCH's file pre-buffer so the reader sees short frames.
        await connection.set("enable_file_write_buffering", "false")
        await connection.set("RECORD_STEREO", "false")
        try:
            await connection.execute("record_session", f"{path} 120", timeout=5)
        except EslProtocolError:
            self._discard(path)
            if connection.hungup.is_set():
                return None, b""
            log.warning("call %s cannot start interruption capture; using sequential playback", connection.uuid[:8])
            return await respond(), b""
        except BaseException:
            self._discard(path)
            raise
        incoming = IncomingSpeech(path, self._settings, connection.hungup)
        capture = asyncio.create_task(incoming.capture())
        onset = asyncio.create_task(incoming.started.wait())
        ended = asyncio.create_task(connection.hungup.wait())
        response = asyncio.create_task(respond())
        try:
            done, _ = await asyncio.wait({response, onset, capture, ended}, return_when=asyncio.FIRST_COMPLETED)
            if response in done and incoming.frames.loud and not incoming.started.is_set():
                # Speech may have begun in the last frame of playback. Give
                # the onset gate time to confirm it before removing pre-roll.
                await asyncio.wait({onset, capture, ended}, timeout=self._settings.barge_in_onset_ms / 1000, return_when=asyncio.FIRST_COMPLETED)
            if connection.hungup.is_set():
                return None, b""
            if incoming.started.is_set():
                if on_activity is not None:
                    on_activity()
                response.cancel()
                await asyncio.gather(response, return_exceptions=True)
                # API commands bypass the application's event-lock. All queued
                # playback is discarded before the next caller turn is handled.
                result = await asyncio.wait_for(connection.api(f"uuid_break {connection.uuid} all"), 5)
                if not result.startswith("+OK"):
                    raise EslProtocolError("FreeSWITCH refused playback interruption")
                log.info("call %s response interrupted by inbound speech", connection.uuid[:8])
                audio = await asyncio.wait_for(capture, self._settings.listen_seconds + 2)
                return None, audio
            if capture in done:
                # Surface a missing media feed in logs, then retain the ordinary
                # call flow. Do not leave the caller listening to dead air.
                try:
                    capture.result()
                except Exception:
                    log.exception("call %s inbound interruption capture unavailable", connection.uuid[:8])
            await asyncio.wait({response, ended}, return_when=asyncio.FIRST_COMPLETED)
            if connection.hungup.is_set():
                return None, b""
            return await response, b""
        finally:
            for task in (response, capture, onset, ended):
                task.cancel()
            await asyncio.gather(response, capture, onset, ended, return_exceptions=True)
            try:
                if not connection.hungup.is_set():
                    await asyncio.wait_for(connection.api(f"uuid_record {connection.uuid} stop {path}"), 5)
                    # Put the buffering back the way it was found. It was turned
                    # off above only so this capture would see short frames, but
                    # it is a channel variable: left off it also applied to
                    # every turn recording _listen made for the rest of the call.
                    # An empty value unsets it, which is what the recorder wants
                    # when nobody has asked for anything in particular.
                    await asyncio.wait_for(connection.set("enable_file_write_buffering", ""), 5)
            except Exception:  # noqa: BLE001 - tidying up must not replace what went wrong
                # This runs while an exception may already be on its way out,
                # and on a socket that failure has often poisoned. Raising here
                # substituted an EslProtocolError for it — turning a
                # SpeechSynthesisError, which has a transfer-to-a-person
                # recovery, into one that only logs and releases the call, so a
                # caller who should have been put through was dropped instead.
                log.warning("call %s could not stop the interruption capture", connection.uuid[:8])
            finally:
                self._discard(path)

    async def _transcribe_pcm(self, audio: bytes, assistant: Assistant) -> str:
        path = Path(self._settings.audio_dir) / "turns" / f"interruption-{uuid4().hex}.wav"
        try:
            with wave.open(str(path), "wb") as recording:
                recording.setnchannels(1)
                recording.setsampwidth(2)
                recording.setframerate(8000)
                recording.writeframes(audio)
            hints = [assistant.name, *(target.label for target in assistant.targets)]
            heard = await self._ears.transcribe(path, assistant.language, hints)
            return drop_hallucinated_transcript(heard, [assistant.greeting, assistant.name, *hints])
        finally:
            self._discard(path)

    async def _listen(self, connection: EslConnection, call_id: str, assistant: Assistant, on_activity=None) -> str:
        """
        Waits for the caller to say something, then transcribes it.

        The recorder stops after `silence_seconds` of quiet, counted from the
        very start, so a caller who takes three seconds to begin used to be
        told "I couldn't hear you" — the receptionist looked as if it never
        listened. Empty recordings are simply started again until the caller
        speaks or `patience_seconds` have gone by.
        """
        deadline = time.monotonic() + self._settings.patience_seconds
        while True:
            path = Path(self._settings.audio_dir) / "turns" / f"{call_id}-{int(time.time() * 1000)}.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            argument = " ".join([
                str(path),
                str(self._settings.listen_seconds),
                str(self._settings.silence_threshold),
                str(self._settings.silence_seconds),
            ])
            recording_started = time.monotonic()
            try:
                await connection.execute("record", argument, timeout=self._settings.listen_seconds + 10)
            except BaseException:
                self._discard(path)
                raise
            recorded_for = time.monotonic() - recording_started
            stats = recording_stats(path)
            if stats.has_audio:
                if on_activity is not None:
                    on_activity()
                break
            log.info("call %s nothing yet (%.1fs, rms %d)", call_id[:8], recorded_for, stats.rms)
            self._discard(path)
            if connection.hungup.is_set() or time.monotonic() >= deadline:
                return ""
        hints = [assistant.name, *(target.label for target in assistant.targets)]
        transcribing = time.monotonic()
        try:
            heard = await self._ears.transcribe(path, assistant.language, hints)
        finally:
            self._discard(path)
        raw = heard
        heard = drop_hallucinated_transcript(heard, [assistant.greeting, assistant.name, *hints])
        if raw.strip() and not heard:
            log.info("call %s dropped an echo or recogniser filler", call_id[:8])
        # Timing per turn, so a slow answer can be blamed on the right stage
        # from the logs alone: how long the recorder ran (and whether it hit
        # its limit instead of hearing silence), and how long recognition took.
        log.info(
            "call %s heard %d characters (recorded %.1fs%s, rms %d, transcribed in %.1fs)",
            call_id[:8], len(heard), recorded_for,
            " — hit the time limit, silence was never detected" if recorded_for >= self._settings.listen_seconds - 0.5 else "",
            stats.rms, time.monotonic() - transcribing,
        )
        return heard

    def _discard(self, path: Path) -> None:
        # A caller's voice is not kept: the transcript is what the tenant sees.
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.exception("could not remove temporary caller recording")

    async def _act(self, connection: EslConnection, assistant: Assistant, decision: Decision, dialled: str) -> None:
        await self._speak(connection, decision.say, assistant.voice)
        if decision.action == "transfer":
            await self._transfer(connection, decision.extension, dialled)

    async def _transfer(self, connection: EslConnection, extension: str, dialled: str) -> None:
        """
        Hands the call to the API's dialplan as if the caller had keyed the
        extension at the menu: the API resolves the extension to the phone
        registered for it, plays the waiting message, rings it, and falls to
        voicemail or the main line by the tenant's own rules.

        (A transfer into the switch's `default` context by extension number
        dialled the number as a SIP address, which is registered to nobody —
        the switch said "not found" and hung up on the caller.)
        """
        await connection.set("vocivo_stage", "ext-select")
        await connection.set("vocivo_digit", "".join(character for character in extension if character.isdigit())[:5])
        # If nobody answers, the dialplan hands the caller back here (see
        # sip-dialplan backToReceptionistActions) instead of to a recording.
        await connection.set("vocivo_from_receptionist", "1")
        await connection.set("vocivo_transfer_failed", "")
        if self._settings.speech_bed:
            # The hold music takes over while the extension rings; the bed
            # must not carry into a conversation with a person.
            await connection.execute("stop_displace_session", self._settings.speech_bed, timeout=5)
        await connection.execute("transfer", f"{dialled or extension} XML public", timeout=10)
