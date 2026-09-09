"""Regression contracts for malformed provider output and caller audio handling."""
import asyncio
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.brain import Assistant, Brain, Conversation, TransferTarget, decision_from_response, tool_definitions
from app.call import CallHandler
from app.config import Settings
from app.speech import drop_hallucinated_transcript


class Quality(unittest.IsolatedAsyncioTestCase):
    def test_real_short_answers_and_names_survive_echo_filter(self):
        known = ['Thank you for calling. How can I help you?', 'Global Heritage', 'Samantha Jones']
        for text in ['Thank you.', 'Bye.', 'help', 'Samantha Jones', 'Global Heritage']:
            self.assertEqual(drop_hallucinated_transcript(text, known), text)
        self.assertEqual(drop_hallucinated_transcript(known[0], known), '')

    def test_closed_office_refuses_transfer_even_with_stale_targets(self):
        assistant = Assistant(office_open=False, transfer_enabled=True, targets=(TransferTarget('1001', 'Sam'),))
        self.assertNotIn('transfer_call', [tool['name'] for tool in tool_definitions(assistant)])
        decision = decision_from_response({'content': [{'type': 'tool_use', 'name': 'transfer_call', 'input': {'extension': '1001'}}]}, assistant)
        self.assertNotEqual(decision.action, 'transfer')

    def test_non_object_tool_input_does_not_crash_decision(self):
        for value in ['invalid', [1], 1]:
            result = decision_from_response({'content': [{'type': 'tool_use', 'name': 'transfer_call', 'input': value}]}, Assistant())
            self.assertEqual(result.action, 'speak')

    async def test_incomplete_and_error_streams_are_failures(self):
        brain = Brain(Settings())
        try:
            streams = [
                [{'type': 'error', 'error': {'type': 'overloaded_error'}}],
                [{'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': 'Partial answer'}}],
                [{'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'name': 'transfer_call'}}, {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '[]'}}, {'type': 'content_block_stop', 'index': 0}],
            ]
            for events in streams:
                response = httpx.Response(200, text='\n\n'.join('data: ' + json.dumps(event) for event in events))
                with self.assertRaises(httpx.RemoteProtocolError):
                    await brain._collect_stream(response, None)
            response = httpx.Response(200, text='data: {"type":"message_stop"}\n')
            self.assertEqual(await brain._collect_stream(response, None), {'content': []})
        finally:
            await brain.close()

    async def test_repeated_provider_failure_uses_only_call_local_allowed_fallback(self):
        assistant = Assistant(transfer_enabled=True, fallback_extension='1001', targets=(TransferTarget('1001', 'Sam'),))
        brain = Brain(Settings())
        await brain._client.aclose()
        brain._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(503)))
        try:
            conversation = Conversation(assistant)
            self.assertEqual((await brain.respond(conversation)).action, 'speak')
            self.assertEqual((await brain.respond(conversation)).extension, '1001')
            self.assertEqual((await brain.respond(Conversation(assistant))).action, 'speak')
        finally:
            await brain.close()

    async def test_failed_record_command_discards_partial_caller_audio(self):
        with TemporaryDirectory() as directory:
            async def record(app, argument, **kwargs):
                Path(argument.split()[0]).write_bytes(b'private caller audio')
                raise RuntimeError('record failed')
            connection = AsyncMock()
            connection.execute.side_effect = record
            handler = CallHandler(Settings(audio_dir=directory), None, None, None, None)
            with self.assertRaises(RuntimeError):
                await handler._listen(connection, 'call', Assistant())
            self.assertEqual(list(Path(directory).rglob('*.wav')), [])

    async def test_idle_deadline_interrupts_stalled_work_and_preserves_external_cancel(self):
        from app.idle import CallerIdleDeadline, CallerIdleTimeout
        with self.assertRaises(CallerIdleTimeout):
            with CallerIdleDeadline(0.02):
                await asyncio.sleep(1)
        with self.assertRaises(asyncio.CancelledError):
            with CallerIdleDeadline(1):
                raise asyncio.CancelledError()

    async def test_caller_activity_reschedules_idle_deadline(self):
        from app.idle import CallerIdleDeadline
        with CallerIdleDeadline(0.1) as idle:
            await asyncio.sleep(0.06)
            idle.touch()
            await asyncio.sleep(0.06)

    async def test_outage_message_capture_does_not_need_the_model(self):
        brain = Brain(Settings())
        try:
            conversation = Conversation(Assistant(), message_mode=True)
            conversation.add('caller', 'Please call me back about the invoice.')
            result = await brain.respond(conversation)
            self.assertEqual(result.action, 'message')
            self.assertEqual(result.note, conversation.turns[-1].text)
        finally:
            await brain.close()

    async def test_tts_failure_is_not_silently_skipped(self):
        from app.speech import SpeechSynthesisError
        voice = AsyncMock()
        voice.say.side_effect = RuntimeError('TTS unavailable')
        connection = AsyncMock()
        connection.hungup = asyncio.Event()
        handler = CallHandler(Settings(), voice, None, None, None)
        with self.assertRaises(SpeechSynthesisError):
            await handler._speak(connection, 'The required answer.', 'af_heart')
        connection.execute.assert_not_awaited()

    async def test_cancelled_asr_keeps_its_slot_until_native_work_finishes(self):
        import threading
        from types import SimpleNamespace
        from app.speech import Ears
        from unittest.mock import Mock
        entered, release = threading.Event(), threading.Event()
        calls = []
        def transcribe(source, **kwargs):
            calls.append(source)
            entered.set()
            release.wait(2)
            return [SimpleNamespace(text='hello')], None
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'caller.wav'
            path.write_bytes(b'caller audio')
            # One slot, so the assertion below is about the property under
            # test — a cancelled transcription keeps its slot until the native
            # worker exits — and not about how many slots the gate happens to
            # have. Sizing the gate is a capacity decision; holding the slot is
            # a correctness one, and only the second belongs in this test.
            ears = Ears(Settings(stt_concurrency=1))
            ears._load = AsyncMock(return_value=Mock(transcribe=transcribe))
            first = asyncio.create_task(ears.transcribe(path))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.005)
                self.assertTrue(entered.is_set())
                first.cancel()
                await asyncio.gather(first, return_exceptions=True)
                second = asyncio.create_task(ears.transcribe(path))
                await asyncio.sleep(0.02)
                self.assertEqual(len(calls), 1)
                path.unlink()
                self.assertEqual(calls[0].getvalue(), b'caller audio')
                release.set()
                self.assertEqual(await second, 'hello')
            finally:
                release.set()
                await asyncio.gather(first, *ears._inference_tasks, return_exceptions=True)

    async def test_streamed_opening_plays_before_model_finishes_without_repetition(self):
        from app.brain import Decision
        from unittest.mock import Mock
        played = asyncio.Event()
        released = asyncio.Event()
        spoken = []
        async def respond(conversation, callback):
            callback('We close at five.')
            await released.wait()
            return Decision(say='We close at five. Can I help with anything else?')
        async def speak(connection, text, voice):
            spoken.append(text)
            played.set()
        handler = CallHandler(Settings(), None, None, Mock(respond=respond), None)
        handler._speak = speak
        connection = Mock(uuid='call')
        task = asyncio.create_task(handler._think(connection, Conversation(Assistant()), 'af_heart'))
        try:
            await asyncio.wait_for(played.wait(), 1)
            self.assertFalse(task.done())
            released.set()
            result = await task
            await handler._speak(connection, result.say[len(result.spoken_prefix):].lstrip(), 'af_heart')
            self.assertEqual(spoken, ['We close at five.', 'Can I help with anything else?'])
        finally:
            released.set()
            await asyncio.gather(task, return_exceptions=True)
