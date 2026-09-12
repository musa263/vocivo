from __future__ import annotations
import asyncio
import base64
import hashlib
import hmac
import json
import sys
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from aiohttp import WSMsgType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.brain import Assistant, TransferTarget
from app.config import Settings
from app.live import LiveHandler, PendingCall
from app.live_contract import live_session, transfer_extension, verify_webhook

SECRET = 'whsec_' + base64.b64encode(b'test-only-webhook-signing-key-1234').decode()
ASSISTANT = Assistant(organization_id='company', transfer_enabled=True, targets=(TransferTarget('2001', 'Sam'),))


def signed(event, timestamp=None):
    body = json.dumps(event).encode()
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    headers = {'webhook-id': 'event-1', 'webhook-timestamp': timestamp}
    message = ('event-1.' + timestamp + '.').encode() + body
    headers['webhook-signature'] = 'v1,' + base64.b64encode(hmac.new(base64.b64decode(SECRET[6:]), message, hashlib.sha256).digest()).decode()
    return SimpleNamespace(read=AsyncMock(return_value=body), headers=headers), body


class LiveContractTests(unittest.TestCase):
    def test_signature_tamper_expiry(self):
        request, body = signed({'type': 'example'}, 1000)
        self.assertEqual(verify_webhook(body, request.headers, SECRET, now=1000)['type'], 'example')
        for data, now in [(body + b' ', 1000), (body, 1400)]:
            with self.assertRaises(ValueError):
                verify_webhook(data, request.headers, SECRET, now=now)

    def test_exact_live_contract_no_realtime_or_audio_format(self):
        session = live_session(ASSISTANT, 'marin', 'gpt-5.6-luna')['session']
        self.assertEqual(session['type'], 'live')
        self.assertEqual(session['model'], 'gpt-live-1')
        self.assertNotIn('format', session['audio'])
        self.assertEqual(session['delegation']['type'], 'responses')
        self.assertFalse(session['delegation']['responses']['parallel_tool_calls'])

    def test_transfer_uses_current_allowlist_not_extension_2000_default(self):
        self.assertEqual(transfer_extension('{"extension":"2001"}', ASSISTANT), '2001')
        for args in ('{"extension":"2000"}', '{"extension":"2001;hangup"}', '{"extension":"2001","organizationId":"other"}'):
            with self.assertRaises(ValueError):
                transfer_extension(args, ASSISTANT)
        with self.assertRaises(ValueError):
            transfer_extension('{"extension":"2001"}', replace(ASSISTANT, office_open=False))

    def test_live_configuration_is_explicit_and_validated(self):
        settings = Settings(provider='openai-live', openai_api_key='test-key', openai_webhook_secret=SECRET,
                            openai_sip_uri='sip:proj_test@sip.api.openai.com;transport=tls', api_secret='test-edge')
        self.assertEqual(settings.missing(), [])
        self.assertTrue(replace(settings, openai_sip_uri='sip:attacker@example.com').missing())
        self.assertTrue(replace(settings, openai_webhook_secret='not a key').missing())
        self.assertTrue(Settings().missing())


class LiveLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.connection = SimpleNamespace(uuid='00000000-0000-0000-0000-000000000001', channel={}, hungup=asyncio.Event(), api=AsyncMock(return_value='+OK'))
        self.api = SimpleNamespace(assistant_for=AsyncMock(return_value=ASSISTANT), record_conversation=AsyncMock(return_value=True))
        self.handler = LiveHandler(Settings(openai_webhook_secret=SECRET), self.api)
        self.handler.control = AsyncMock()
        self.handler.monitor = AsyncMock()
        self.call = PendingCall(self.connection, ASSISTANT, '+15551234567', '+15557654321', 'random-call-grant')
        self.handler.pending[self.call.grant] = self.call

    def incoming(self, grant=None):
        return signed({'type': 'live.transport.incoming', 'data': {'type': 'sip', 'session_id': 'session-1',
            'sip_headers': [{'name': 'X-Vocivo-Live-Grant', 'value': self.call.grant if grant is None else grant}]}})[0]

    async def test_concurrent_duplicate_webhook_accepts_once(self):
        responses = await asyncio.gather(self.handler.webhook(self.incoming()), self.handler.webhook(self.incoming()))
        self.assertEqual([r.status for r in responses], [200, 200])
        self.handler.control.assert_awaited_once()
        self.assertEqual(self.handler.control.call_args.args[1], 'accept')
        await self.call.monitor

    async def test_unknown_grant_cannot_choose_tenant_with_sip_headers(self):
        await self.handler.webhook(self.incoming('untrusted'))
        self.handler.control.assert_awaited_once_with('session-1', 'reject', {'status_code': 403})
        self.handler.monitor.assert_not_awaited()

    async def test_failed_accept_kills_only_ai_leg_and_does_not_retry(self):
        self.handler.control.side_effect = TimeoutError()
        await self.handler.webhook(self.incoming())
        await self.handler.webhook(self.incoming())
        self.handler.control.assert_awaited_once()
        self.connection.api.assert_awaited_once_with(f'uuid_kill {self.call.ai_leg_id} NORMAL_TEMPORARY_FAILURE')

    async def test_caller_hangup_before_answer_prevents_accept(self):
        self.connection.hungup.set()
        await self.handler.webhook(self.incoming())
        self.assertEqual(self.handler.control.call_args.args[1], 'reject')
        self.handler.monitor.assert_not_awaited()

    async def test_cross_tenant_routing_change_is_rejected_before_signaling(self):
        self.api.assistant_for.return_value = replace(ASSISTANT, organization_id='other')
        result = await self.handler.transfer(self.call, {'arguments': '{"extension":"2001"}'})
        self.assertEqual(result['status'], 'denied')
        self.connection.api.assert_not_awaited()

    async def test_transfer_claims_before_switch_response_and_only_once(self):
        async def signaling(command):
            if command.startswith('uuid_transfer'):
                self.assertTrue(self.call.transfer_started)
            return '+OK'
        self.connection.api.side_effect = signaling
        result = await self.handler.transfer(self.call, {'arguments': '{"extension":"2001"}'})
        self.assertEqual(result['status'], 'routing')
        self.assertEqual(self.call.transferred_to, '2001')
        again = await self.handler.transfer(self.call, {'arguments': '{"extension":"2001"}'})
        self.assertEqual(again['status'], 'not_started')
        commands = [c.args[0] for c in self.connection.api.call_args_list]
        self.assertEqual(len([c for c in commands if c.startswith('uuid_transfer')]), 1)

    async def test_message_persistence_failure_is_not_reported_saved(self):
        self.api.record_conversation.return_value = False
        result = await self.handler.take_message(self.call, {'call_id': 'tool-1', 'arguments': '{"note":"Please call tomorrow"}'})
        self.assertEqual(result['status'], 'unconfirmed')

    async def test_sideband_deduplicates_tool_items_and_waits_for_session_closed(self):
        item = {'type': 'function_call', 'call_id': 'tool-1', 'name': 'take_message', 'arguments': '{"note":"Call tomorrow"}'}
        events = []
        for _ in range(2):
            events.extend([{'type': 'response.event', 'delegation_id': 'delegation-1', 'event': {'type': 'response.output_item.done', 'item': item}},
                           {'type': 'response.event', 'delegation_id': 'delegation-1', 'event': {'type': 'response.completed', 'response': {'id': 'response-1', 'output': []}}}])
        events.append({'type': 'session.closed', 'usage': {'input_tokens': 10}})
        ws = Sideband(events)
        self.handler.http = SimpleNamespace(ws_connect=lambda *_args, **_kwargs: ws)
        await LiveHandler.monitor(self.handler, self.call)
        self.api.record_conversation.assert_awaited_once()
        self.assertTrue(self.call.finalized.is_set())
        self.assertEqual(self.call.usage, {'input_tokens': 10})
        self.assertEqual(len([e for e in ws.sent if e['type'] == 'response.item.create']), 2)
        self.assertNotIn('session.start', [e['type'] for e in ws.sent])
        self.connection.api.assert_not_awaited()

    async def test_lost_sideband_releases_ai_leg_without_fabricating_final_usage(self):
        self.handler.http = SimpleNamespace(ws_connect=lambda *_args, **_kwargs: Sideband([]))
        await LiveHandler.monitor(self.handler, self.call)
        self.assertFalse(self.call.finalized.is_set())
        self.assertIsNone(self.call.usage)
        self.connection.api.assert_awaited_once_with(f'uuid_kill {self.call.ai_leg_id} NORMAL_TEMPORARY_FAILURE')

    async def test_configuration_lookup_failure_uses_dialplan_fallback(self):
        self.connection.connect = AsyncMock(return_value={'variable_vocivo_org': 'company', 'variable_vocivo_did': '+15551234567'})
        self.connection.set = AsyncMock()
        self.connection.execute = AsyncMock()
        self.connection.close = AsyncMock()
        self.connection.hangup = AsyncMock()
        self.api.assistant_for.side_effect = TimeoutError()
        await self.handler.handle(self.connection)
        self.connection.execute.assert_awaited_once_with('transfer', '+15551234567 XML public', timeout=10)
        self.connection.hangup.assert_not_awaited()
        self.connection.close.assert_awaited_once()


class Sideband:
    def __init__(self, events):
        self.events = iter(events)
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps(next(self.events)))
        except StopIteration:
            raise StopAsyncIteration

    async def send_json(self, event):
        self.sent.append(event)


if __name__ == '__main__':
    unittest.main()
