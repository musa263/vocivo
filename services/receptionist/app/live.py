from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import quote
from uuid import uuid4

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web
from .api import VocivoApi
from .brain import Assistant
from .esl import EslConnection, channel_variable
from .live_contract import live_session, transfer_extension, verify_webhook

log = logging.getLogger("vocivo.live")


@dataclass
class PendingCall:
    connection: EslConnection
    assistant: Assistant
    did: str
    caller: str
    grant: str
    created: float = field(default_factory=time.monotonic)
    session_id: str = ""
    decided: bool = False
    transferred: bool = False
    transfer_started: bool = False
    transferred_to: str = ""
    ai_leg_id: str = field(default_factory=lambda: str(uuid4()))
    ended: bool = False
    finalized: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    monitor: asyncio.Task | None = None
    tool_results: dict = field(default_factory=dict)
    usage: dict | None = None
    backend_usage: dict = field(default_factory=dict)
    outcome: str = "caller_hung_up"


class LiveHandler:
    """FreeSWITCH owns the caller; OpenAI is an SRTP B leg, never the tenant authority."""
    def __init__(self, settings, api: VocivoApi):
        self.settings = settings
        self.api = api
        self.pending: dict[str, PendingCall] = {}
        self.http: ClientSession | None = None
        self.runner = None

    async def start(self):
        self.http = ClientSession(timeout=ClientTimeout(total=12), headers={"Authorization": f"Bearer {self.settings.openai_api_key}"})
        app = web.Application(client_max_size=256 * 1024)
        app.router.add_post("/openai/live/webhook", self.webhook)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", self.settings.openai_webhook_port).start()

    async def control(self, session_id, action, payload=None):
        if action not in {"accept", "reject", "hangup"}:
            raise ValueError("Invalid Live action")
        url = f"https://api.openai.com/v1/live/sessions/{quote(session_id, safe='')}/{action}"
        kwargs = {"json": payload} if payload is not None else {}
        async with self.http.post(url, **kwargs) as response:
            if response.status != 200:
                # Never log the body, which may contain private session configuration.
                raise RuntimeError(f"Live {action} rejected ({response.status})")

    async def webhook(self, request):
        try:
            event = verify_webhook(await request.read(), request.headers, self.settings.openai_webhook_secret)
        except (ValueError, TypeError):
            return web.json_response({"error": "Invalid signature or event"}, status=400)
        if event.get("type") not in {"live.transport.incoming", "live.call.incoming"}:
            return web.json_response({"received": True})
        data = event.get("data", {})
        if not isinstance(data, dict) or (event["type"] == "live.transport.incoming" and data.get("type") != "sip"):
            return web.json_response({"error": "SIP transport required"}, status=400)
        session_id = data.get("session_id", "")
        if not isinstance(session_id, str) or not session_id or len(session_id) > 200:
            return web.json_response({"error": "Session required"}, status=400)
        headers = data.get("sip_headers", [])
        grants = [h.get("value") for h in headers if isinstance(h, dict) and str(h.get("name", "")).lower() == "x-vocivo-live-grant"] if isinstance(headers, list) else []
        call = self.pending.get(grants[0]) if len(grants) == 1 and isinstance(grants[0], str) else None
        if not call or call.ended or (not call.decided and time.monotonic() - call.created > 45):
            try:
                await self.control(session_id, "reject", {"status_code": 403})
            except Exception as error:
                log.warning("live.reject.failed type=%s", type(error).__name__)
            return web.json_response({"received": True})
        async with call.lock:
            if call.ended or call.connection.hungup.is_set():
                await self.control(session_id, "reject", {"status_code": 487})
                return web.json_response({"received": True})
            if call.session_id and call.session_id != session_id:
                return web.json_response({"error": "Grant already bound"}, status=409)
            if call.decided:
                return web.json_response({"received": True})
            # Claim before network I/O: an uncertain accept must never create another decision.
            call.session_id = session_id
            call.decided = True
            try:
                returning = channel_variable(call.connection.channel, "vocivo_transfer_failed") == "1"
                await self.control(session_id, "accept", live_session(call.assistant, self.settings.openai_voice, self.settings.openai_backend_model, returning))
                if call.ended or call.connection.hungup.is_set():
                    await self.control(session_id, "hangup")
                else:
                    call.monitor = asyncio.create_task(self.monitor(call))
            except Exception as error:
                log.warning("live.accept.failed type=%s", type(error).__name__)
                # Release the attempted AI B leg, never retry acceptance blindly.
                await self.break_ai_leg(call)
        return web.json_response({"received": True})

    async def break_ai_leg(self, call):
        try:
            result = await call.connection.api(f"uuid_kill {call.ai_leg_id} NORMAL_TEMPORARY_FAILURE")
            if not result.startswith("+OK"):
                log.warning("live.bridge.break.refused")
        except Exception as error:
            log.warning("live.bridge.break.failed type=%s", type(error).__name__)

    async def transfer(self, call, item):
        fresh = await self.api.assistant_for(call.did, call.caller)
        if not fresh or fresh.organization_id != call.assistant.organization_id:
            return {"status": "denied", "reason": "Company routing changed"}
        try:
            extension = transfer_extension(item.get("arguments", ""), fresh)
        except (ValueError, TypeError):
            return {"status": "denied", "reason": "The requested colleague is unavailable for transfer"}
        if call.transfer_started or call.ended:
            return {"status": "not_started", "reason": "Call is no longer awaiting transfer"}
        uuid = call.connection.uuid
        for key, value in (("vocivo_stage", "ext-select"), ("vocivo_digit", extension), ("vocivo_from_receptionist", "1"), ("vocivo_transfer_failed", "")):
            result = await call.connection.api(f"uuid_setvar {uuid} {key} {value}".rstrip())
            if not result.startswith("+OK"):
                raise RuntimeError("Transfer preparation refused")
        # The bridge application holds the execute lock; API control avoids a queued transfer deadlock.
        call.transfer_started = True
        result = await call.connection.api(f"uuid_transfer {uuid} {call.did} XML public")
        if not result.startswith("+OK"):
            call.transfer_started = False
            raise RuntimeError("Transfer refused")
        call.transferred = True
        call.transferred_to = extension
        return {"status": "routing", "extension": extension}

    async def monitor(self, call):
        pending_tools: dict[str, list] = {}
        try:
            url = f"wss://api.openai.com/v1/live/sessions/{quote(call.session_id, safe='')}/attach"
            async with self.http.ws_connect(url, heartbeat=20, max_msg_size=1024 * 1024) as ws:
                async for message in ws:
                    if message.type == WSMsgType.ERROR:
                        raise ConnectionError("Live sideband failed")
                    if message.type != WSMsgType.TEXT:
                        continue
                    event = json.loads(message.data)
                    if event.get("type") == "session.closed":
                        call.usage = event.get("usage")
                        call.finalized.set()
                        break
                    if event.get("type") == "error":
                        raise RuntimeError("Live command or session failed")
                    if event.get("type") != "response.event":
                        continue
                    nested = event.get("event", {})
                    if not isinstance(nested, dict):
                        raise ValueError("Invalid delegated event")
                    delegation_id = event.get("delegation_id", "")
                    if not isinstance(delegation_id, str) or not delegation_id:
                        continue
                    if nested.get("type") in {"response.failed", "response.cancelled"}:
                        pending_tools.pop(delegation_id, None)
                        continue
                    if nested.get("type") == "response.completed":
                        response = nested.get("response", {})
                        if response.get("id") and response.get("usage") and len(call.backend_usage) < 256:
                            call.backend_usage[response['id']] = response['usage']
                    if nested.get("type") == "response.output_item.done":
                        item = nested.get("item", {})
                        if item.get("type") == "function_call":
                            if sum(map(len, pending_tools.values())) >= 8:
                                raise ValueError("Too many pending Live tools")
                            pending_tools.setdefault(delegation_id, []).append(item)
                    if nested.get("type") == "response.completed" and delegation_id in pending_tools:
                        for item in pending_tools.pop(delegation_id):
                            call_id = item.get("call_id")
                            if not isinstance(call_id, str) or len(call_id) > 200 or not call_id:
                                raise ValueError("Invalid tool identity")
                            if call_id not in call.tool_results:
                                if len(call.tool_results) >= 256:
                                    raise ValueError("Live tool limit reached")
                                # Reserve before the side effect; an uncertain SIP reply is not permission to retry.
                                call.tool_results[call_id] = {"status": "uncertain", "reason": "Do not retry this transfer"}
                                if item.get("name") == "transfer_call":
                                    result = await self.transfer(call, item)
                                elif item.get("name") == "take_message":
                                    result = await self.take_message(call, item)
                                else:
                                    result = {"status": "denied"}
                                call.tool_results[call_id] = result
                            await ws.send_json({"type": "response.item.create", "item": {"type": "function_call_output", "call_id": call_id, "output": json.dumps(call.tool_results[call_id])}})
                        if not call.transferred:
                            await ws.send_json({"type": "response.create"})
            if not call.finalized.is_set():
                raise ConnectionError("Live final usage unavailable")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("live.session.failed type=%s finalized=%s", type(error).__name__, call.finalized.is_set())
            if not call.transfer_started and not call.ended:
                await self.break_ai_leg(call)

    async def fallback(self, connection, did):
        if connection.hungup.is_set():
            return
        await connection.set("vocivo_from_receptionist", "0")
        await connection.set("vocivo_queue_id", "")
        await connection.set("vocivo_stage", "unavailable")
        await connection.execute("transfer", f"{did} XML public", timeout=10)

    async def take_message(self, call, item):
        try:
            args = json.loads(item.get('arguments', ''))
            if not isinstance(args, dict) or set(args) != {'note'} or not isinstance(args['note'], str) or not 1 <= len(args['note'].strip()) <= 1500 or call.ended:
                return {'status': 'denied'}
            fresh = await self.api.assistant_for(call.did, call.caller)
            if not fresh or fresh.organization_id != call.assistant.organization_id:
                return {'status': 'denied'}
            # Idempotent event identity is independent of transcript content.
            import hashlib
            event_id = call.connection.uuid + '-message-' + hashlib.sha256(item['call_id'].encode()).hexdigest()[:16]
            saved = await self.api.record_conversation({'callId': event_id, 'number': call.did, 'caller': call.caller, 'outcome': 'message_taken',
                'transferredTo': '', 'seconds': 0, 'transcript': '', 'note': args['note'].strip()})
            return {'status': 'saved' if saved else 'unconfirmed'}
        except (ValueError, TypeError):
            return {'status': 'denied'}

    async def handle(self, connection: EslConnection):
        call = None
        authorized_did = ""
        try:
            channel = await connection.connect()
            org = channel_variable(channel, "vocivo_org")
            did = channel_variable(channel, "vocivo_did")
            if not org or not re.fullmatch(r"\+?[0-9]{5,15}", did) or not re.fullmatch(r"[a-fA-F0-9-]{36}", connection.uuid):
                await connection.hangup("CALL_REJECTED")
                return
            caller = channel_variable(channel, "Caller-Caller-ID-Number", "caller_id_number")
            authorized_did = did
            assistant = await self.api.assistant_for(did, caller)
            if not assistant or assistant.organization_id != org or len(self.pending) >= 128:
                await self.fallback(connection, did)
                return
            grant = secrets.token_urlsafe(32)
            call = PendingCall(connection, assistant, did, caller, grant)
            self.pending[grant] = call
            await connection.set("hangup_after_bridge", "false")
            await connection.set("continue_on_fail", "true")
            await connection.set("call_timeout", "40")
            # No credentials or caller-controlled data can enter this dial string.
            target = self.settings.openai_sip_uri.removeprefix("sip:")
            dial = f"{{origination_uuid={call.ai_leg_id},sip_h_X-Vocivo-Live-Grant={grant},rtp_secure_media_outbound=mandatory}}sofia/openai-live/{target}"
            await connection.execute("bridge", dial, timeout=24 * 3600)
            if not call.transfer_started and not connection.hungup.is_set():
                call.outcome = "error"
                await self.fallback(connection, did)
        except asyncio.CancelledError:
            await connection.hangup("NORMAL_TEMPORARY_FAILURE")
            raise
        except Exception as error:
            log.warning("live.call.failed type=%s", type(error).__name__)
            if call and not call.transfer_started:
                call.outcome = "error"
                await self.fallback(connection, call.did)
            elif not call and authorized_did:
                await self.fallback(connection, authorized_did)
            elif not call:
                await connection.hangup("NORMAL_TEMPORARY_FAILURE")
        finally:
            if call:
                call.ended = True
                if call.session_id and not call.finalized.is_set():
                    try:
                        await self.control(call.session_id, "hangup")
                        await asyncio.wait_for(call.finalized.wait(), timeout=10)
                    except Exception as error:
                        log.warning("live.finalization.incomplete type=%s", type(error).__name__)
                if call.monitor:
                    call.monitor.cancel()
                    await asyncio.gather(call.monitor, return_exceptions=True)
                self.pending.pop(call.grant, None)
                await self.api.record_conversation({"callId": connection.uuid, "number": call.did, "caller": call.caller,
                    "outcome": "transferred" if call.transferred else call.outcome, "transferredTo": call.transferred_to, "seconds": time.monotonic() - call.created,
                    "transcript": "", "note": json.dumps({"provider": "openai", "model": "gpt-live-1", "finalized": call.finalized.is_set(),
                        "usageReconciliation": "pending", "backendResponses": len(call.backend_usage)})})
            await connection.close()

    async def close(self):
        if self.runner:
            await self.runner.cleanup()
        if self.http:
            await self.http.close()
