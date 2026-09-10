"""Second-sweep regressions: malformed providers and lifecycle failure paths."""
import asyncio
import io
import json
import sys
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, Mock, patch

import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.brain import Assistant, Brain, Conversation, TransferTarget, decision_from_response
from app.call import CallHandler
from app.config import Settings
from app.esl import EslConnection
from app.speech import Voice


class Sweep(unittest.IsolatedAsyncioTestCase):
    def test_refused_transfer_does_not_announce_success(self):
        result = decision_from_response({'content': [{'type': 'tool_use', 'name': 'transfer_call', 'input': {'extension': '9999', 'say': 'Putting you through now.'}}]}, Assistant())
        self.assertNotIn('Putting you through', result.say)
        self.assertEqual(result.action, 'speak')

    def test_conflicting_tools_are_not_executed(self):
        assistant = Assistant(transfer_enabled=True, targets=(TransferTarget('1001', 'Sam'),))
        result = decision_from_response({'content': [
            {'type': 'tool_use', 'name': 'take_message', 'input': {'message': 'Call back', 'say': 'Noted.'}},
            {'type': 'tool_use', 'name': 'transfer_call', 'input': {'extension': '1001', 'say': 'Transferring.'}},
        ]}, assistant)
        self.assertEqual(result.action, 'speak')
        self.assertNotIn('Transferring', result.say)

    def test_empty_message_is_not_confirmed_as_saved(self):
        result = decision_from_response({'content': [{'type': 'tool_use', 'name': 'take_message', 'input': {'say': 'Your message was saved.'}}]}, Assistant())
        self.assertEqual(result.action, 'speak')
        self.assertNotIn('was saved', result.say)

    async def test_malformed_stream_fields_enter_recovery(self):
        bad_events = [
            {'type': 'content_block_start', 'index': 'bad', 'content_block': {}},
            {'type': 'content_block_start', 'index': 0, 'content_block': 'bad'},
            {'type': 'content_block_delta', 'index': 0, 'delta': []},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': 12}},
        ]
        brain = Brain(Settings())
        try:
            for event in bad_events:
                response = httpx.Response(200, text='data: '+json.dumps(event)+'\n\ndata: {"type":"message_stop"}\n')
                with self.subTest(event=event), self.assertRaises(httpx.RemoteProtocolError):
                    await brain._collect_stream(response, None)
        finally:
            await brain.close()

    async def test_unclosed_tool_block_cannot_execute(self):
        brain = Brain(Settings())
        try:
            response = httpx.Response(200, text='data: '+json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'name': 'transfer_call', 'input': {'extension': '1001'}}})+'\n\ndata: {"type":"message_stop"}\n')
            with self.assertRaises(httpx.RemoteProtocolError):
                await brain._collect_stream(response, None)
        finally:
            await brain.close()

    async def test_invalid_fresh_wav_is_never_published(self):
        with TemporaryDirectory() as directory:
            voice = Voice(Settings(audio_dir=directory))
            await voice._client.aclose()
            voice._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b'RIFF'+b'x'*100, headers={'content-type':'audio/wav'})))
            try:
                with self.assertRaises(RuntimeError):
                    await voice.say('The answer.')
                self.assertEqual(list(Path(directory).rglob('*.wav')), [])
            finally:
                await voice.close()

    async def test_setup_failure_releases_channel_and_closes_connection(self):
        connection = Mock(uuid='setup-call', hungup=asyncio.Event())
        connection.connect = AsyncMock(side_effect=RuntimeError('setup failed'))
        connection.hangup, connection.close = AsyncMock(), AsyncMock()
        handler = CallHandler(Settings(), None, None, None, None)
        await handler.handle(connection)
        connection.hangup.assert_awaited_once()
        connection.close.assert_awaited_once()

    async def test_stalled_esl_completion_is_a_failure(self):
        connection = EslConnection(asyncio.StreamReader(), Mock())
        with self.assertRaises(TimeoutError):
            await connection._await_completion('record', timeout=0.01, execution_id='record-1')

    async def test_shutdown_waits_for_call_cleanup(self):
        from app.main import drain_calls
        cleaned = asyncio.Event()
        async def call():
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.01)
                cleaned.set()
        task = asyncio.create_task(call())
        await asyncio.sleep(0)
        await drain_calls({task}, grace_seconds=0.01)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(task.done())

    async def test_startup_failure_closes_all_http_clients(self):
        from app import main
        settings = Settings(tts_secret='x', llm_api_key='x', api_secret='x')
        voice, ears, brain, api = [Mock() for _ in range(4)]
        for client in (voice, brain, api):
            client.close = AsyncMock()
        ears.warm = AsyncMock(side_effect=RuntimeError('load failed'))
        with patch.object(main.Settings, 'from_env', return_value=settings), patch.object(main, 'Voice', return_value=voice), patch.object(main, 'Ears', return_value=ears), patch.object(main, 'Brain', return_value=brain), patch.object(main, 'VocivoApi', return_value=api):
            with self.assertRaises(RuntimeError):
                await main.serve()
        for client in (voice, brain, api):
            client.close.assert_awaited_once()

    async def test_missing_esl_ack_is_bounded_and_cannot_be_reused(self):
        from app.esl import EslProtocolError
        writer = Mock()
        writer.drain = AsyncMock()
        writer.wait_closed = AsyncMock()
        connection = EslConnection(asyncio.StreamReader(), writer, reply_timeout=0.01)
        try:
            with self.assertRaises(EslProtocolError):
                await connection.api('status')
            self.assertTrue(connection.hungup.is_set())
            with self.assertRaises(EslProtocolError):
                await connection.api('status')
            self.assertEqual(writer.write.call_count, 1)
        finally:
            await connection.close()

    async def test_stalled_esl_writer_is_bounded_and_cannot_be_reused(self):
        from app.esl import EslProtocolError
        writer = Mock()
        writer.drain = AsyncMock(side_effect=asyncio.Event().wait)
        writer.wait_closed = AsyncMock()
        connection = EslConnection(asyncio.StreamReader(), writer, reply_timeout=0.01)
        try:
            with self.assertRaises(EslProtocolError):
                await connection.api('status')
            self.assertTrue(connection.hungup.is_set())
            with self.assertRaises(EslProtocolError):
                await connection.api('status')
            self.assertEqual(writer.write.call_count, 1)
            writer.close.assert_called()
        finally:
            await connection.close()

    async def test_optional_capture_rejection_keeps_response_and_removes_partial_file(self):
        from app.esl import EslProtocolError
        with TemporaryDirectory() as directory:
            connection = Mock(uuid='call', hungup=asyncio.Event())
            connection.set = AsyncMock()
            async def record(app, argument, **kwargs):
                Path(argument.rsplit(' ', 1)[0]).write_bytes(b'partial')
                raise EslProtocolError('recording refused')
            connection.execute = AsyncMock(side_effect=record)
            handler = CallHandler(Settings(audio_dir=directory),None,None,None,None)
            respond = AsyncMock(return_value='answer')
            self.assertEqual(await handler._with_interruption(connection,respond),('answer',b''))
            self.assertEqual(list(Path(directory).rglob('*.r8')),[])

    async def test_transcript_storage_failure_does_not_hang_up_a_transferred_call(self):
        from app.brain import Decision
        connection = Mock(uuid='transfer-call', hungup=asyncio.Event())
        connection.connect = AsyncMock(return_value={'Answer-State':'answered','Caller-Destination-Number':'+15555550100'})
        connection.set, connection.execute = AsyncMock(), AsyncMock()
        connection.close, connection.hangup = AsyncMock(), AsyncMock()
        api = Mock(assistant_for=AsyncMock(return_value=Assistant()),record_conversation=AsyncMock(side_effect=RuntimeError('storage failed')))
        handler = CallHandler(Settings(barge_in=False),Mock(prerender=AsyncMock()),None,None,api)
        handler._speak = AsyncMock()
        handler._listen = AsyncMock(return_value='Please transfer me')
        handler._think = AsyncMock(return_value=Decision(action='transfer',extension='1001',say='One moment.'))
        await handler.handle(connection)
        connection.hangup.assert_not_awaited()
        self.assertTrue(any(call.args[0]=='transfer' for call in connection.execute.call_args_list))
        connection.close.assert_awaited_once()

    async def test_cleanup_failure_preserves_speech_failure(self):
        from app.speech import SpeechSynthesisError
        with TemporaryDirectory() as directory:
            connection = Mock(uuid='fixture', hungup=asyncio.Event())
            connection.set, connection.execute = AsyncMock(), AsyncMock()
            connection.api = AsyncMock(side_effect=RuntimeError('cleanup failed'))
            handler = CallHandler(Settings(audio_dir=directory), None, None, None, None)
            with self.assertRaises(SpeechSynthesisError):
                await handler._with_interruption(connection, AsyncMock(side_effect=SpeechSynthesisError('voice unavailable')))

    async def test_api_outage_is_not_an_authoritative_absent_receptionist(self):
        from app.api import VocivoApi, ReceptionistUnavailable
        api = VocivoApi(Settings())
        await api._client.aclose()
        api._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503)))
        try:
            with self.assertRaises(ReceptionistUnavailable):
                await api.assistant_for('fixture', 'fixture')
        finally:
            await api.close()
        connection = Mock(uuid='fixture', hungup=asyncio.Event())
        connection.connect = AsyncMock(return_value={'variable_vocivo_org':'tenant-a', 'variable_vocivo_did':'+12025550123'})
        connection.set, connection.execute, connection.hangup, connection.close = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
        handler = CallHandler(Settings(), None, None, None, Mock(assistant_for=AsyncMock(side_effect=ReceptionistUnavailable())))
        await handler.handle(connection)
        connection.set.assert_any_await('vocivo_from_receptionist', '0')
        connection.set.assert_any_await('vocivo_stage', 'unavailable')
        connection.execute.assert_awaited_once_with('transfer', '+12025550123 XML public')
        connection.hangup.assert_not_awaited()
