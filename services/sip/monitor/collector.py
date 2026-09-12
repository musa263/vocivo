"""Read-only, complete SIP-edge snapshots. A failed source never publishes zero counts."""
from __future__ import annotations

import json
import logging
import os
import re
import socket
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

log = logging.getLogger("vocivo.operations")
LIMIT = 4 * 1024 * 1024


def iso(seconds):
    return datetime.fromtimestamp(float(seconds), timezone.utc).isoformat()


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def sip_user(value):
    # FreeSWITCH's sip_*_uri variables can omit the scheme.
    match = re.search(r"(?:sips?:)?([^@;<>\s:]+)@", str(value), re.I)
    return match.group(1) if match else ""


def registrations(result, now):
    rows = []
    # ul.dump emits nested Domains / AoRs / Info / Contacts objects.
    if not isinstance(result, dict) or not isinstance(result.get("Domains"), list):
        raise ValueError("Invalid registrar response")
    for row in objects(result):
        if "AoR" not in row or "Contacts" not in row:
            continue
        expiries = []
        for contact in objects(row["Contacts"]):
            if "Expires" in contact:
                expiry = contact["Expires"]
                if expiry == "permanent":
                    raise ValueError("Unexpected permanent application registration")
                seconds = int(expiry)
                if seconds > 0:
                    expiries.append(now + seconds)
        if expiries:
            rows.append({"username": row["AoR"].split("@")[0], "contacts": len(expiries), "expiresAt": iso(max(expiries))})
    return rows


def rpc(method):
    if method not in {"ul.dump", "dlg.list"}:
        raise ValueError("Read-only RPC required")
    reply_path = f"/run/vocivo-monitor/reply-{uuid4().hex}.sock"
    request_id = uuid4().hex
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.settimeout(4)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, LIMIT)
            sock.bind(reply_path)
            sock.sendto(json.dumps({"jsonrpc": "2.0", "method": method, "id": request_id}).encode(), "/run/vocivo-monitor/kamailio.sock")
            data, _, flags, _ = sock.recvmsg(LIMIT)
            if flags & socket.MSG_TRUNC:
                raise ValueError("Telemetry exceeds datagram capacity")
        message = json.loads(data)
        if message.get("id") != request_id or "error" in message or "result" not in message:
            raise ValueError("RPC rejected snapshot")
        return message["result"]
    finally:
        Path(reply_path).unlink(missing_ok=True)


class Esl:
    def __enter__(self):
        self.socket = socket.create_connection(("127.0.0.1", 8021), timeout=4)
        self.file = self.socket.makefile("rb")
        try:
            headers, _ = self.read()
            if headers.get("Content-Type") != "auth/request":
                raise ValueError("ESL authentication required")
            config = ET.parse("/fs-config/autoload_configs/event_socket.conf.xml")
            password = next(p.attrib["value"] for p in config.iter("param") if p.attrib.get("name") == "password")
            if not re.fullmatch(r"[a-f0-9]{48}", password):
                raise ValueError("Invalid generated ESL credential")
            headers, _ = self.command(f"auth {password}")
            if not headers.get("Reply-Text", "").startswith("+OK"):
                raise ValueError("ESL authentication refused")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        self.file.close()
        self.socket.close()

    def read(self):
        headers = {}
        size = 0
        while True:
            line = self.file.readline(8193)
            size += len(line)
            if not line or size > 65536:
                raise ValueError("Invalid ESL frame")
            if line in (b"\n", b"\r\n"):
                break
            key, value = line.decode().split(":", 1)
            headers[key.strip()] = value.strip()
        length = int(headers.get("Content-Length", 0))
        if not 0 <= length <= LIMIT:
            raise ValueError("ESL frame exceeds limit")
        body = self.file.read(length)
        if len(body) != length:
            raise ValueError("ESL truncated frame")
        return headers, body.decode()

    def command(self, value):
        if "\n" in value or "\r" in value:
            raise ValueError("Invalid ESL command")
        self.socket.sendall((value + "\n\n").encode())
        return self.read()

    def channels(self):
        payload = json.loads(self.command("api show channels as json")[1])
        rows = payload.get("rows", [])
        if len(rows) != payload.get("row_count") or len(rows) > 512:
            raise ValueError("Incomplete channel snapshot")
        from urllib.parse import unquote
        result = []
        for row in rows:
            uuid = row.get("uuid", "")
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", uuid):
                raise ValueError("Invalid channel ID")
            dump = self.command(f"api uuid_dump {uuid}")[1]
            if dump.startswith("-ERR"):
                continue  # channel ended between listing and lookup
            result.append({key: unquote(value.strip()) for line in dump.splitlines() if ": " in line for key, value in [line.split(": ", 1)]})
        return result


def live_calls(dialogs, channels, now):
    if not isinstance(dialogs, list) or any(not isinstance(row, dict) or "callid" not in row or "state" not in row for row in dialogs):
        raise ValueError("Invalid dialog response")
    calls = []
    fs_ids = {c.get("variable_sip_call_id") for c in channels}
    for row in objects(dialogs):
        if "callid" not in row or "state" not in row:
            continue
        if row["callid"] in fs_ids or int(row["state"]) not in (1, 2, 3, 4):
            continue
        users = [sip_user(row.get(key, "")) for key in ("from_uri", "to_uri")]
        calls.append({"id": str(row["callid"]), "direction": "internal", "state": "active" if int(row["state"]) in (3, 4) else "ringing",
                      "usernames": [u for u in users if u], "organizationId": "", "queueId": "", "startedAt": iso(row.get("init_ts") or row.get("start_ts") or now)})
    for c in channels:
        org = c.get("variable_vocivo_org", "")
        if not org or c.get("variable_originating_leg_uuid"):
            continue
        uuid = c.get("Unique-ID", "")
        if not uuid:
            raise ValueError("Missing channel identity")
        queue = c.get("variable_vocivo_queue_id", "")
        bridged = c.get("variable_bridge_uuid", "")
        # A remembered bridge UUID is not an active bridge once that channel is gone.
        answered_peer = next((p for p in channels if p.get("Unique-ID") == bridged and p.get("Answer-State") == "answered"), None)
        peers = [c] + ([answered_peer] if answered_peer else [])
        users = set()
        for peer in peers:
            for key in ("variable_sip_from_uri", "variable_sip_to_uri", "variable_sip_req_uri"):
                user = sip_user(peer.get(key, ""))
                if user:
                    users.add(user)
        calls.append({"id": uuid, "direction": "outbound" if c.get("variable_vocivo_report_direction") == "outbound" else "inbound",
                      "state": "waiting" if queue and not answered_peer else "active" if c.get("Answer-State") == "answered" else "ringing",
                      "usernames": sorted(users), "organizationId": org, "queueId": queue,
                      "startedAt": iso(int(c.get("Caller-Channel-Created-Time", int(now * 1e6))) / 1e6)})
    return calls


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def run():
    logging.basicConfig(level=logging.INFO)
    api = os.environ["VOCIVO_API_URL"].rstrip("/")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::443)?", api):
        raise ValueError("HTTPS API origin required")
    secret = os.environ["SIP_EDGE_SECRET"]
    if not secret:
        raise ValueError("Edge authentication required")
    while True:
        try:
            started = time.time()
            registered = registrations(rpc("ul.dump"), started)
            dialogs = rpc("dlg.list")
            with Esl() as esl:
                channels = esl.channels()
            if time.time() - started > 20:
                raise TimeoutError("Snapshot collection too slow")
            payload = {"version": 1, "observedAt": iso(started), "registrations": registered, "calls": live_calls(dialogs, channels, started)}
            request = urllib.request.Request(f"{api}/api/voice/telemetry", json.dumps(payload).encode(), {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, method="POST")
            with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
                if response.status != 200:
                    raise ValueError("Snapshot rejected")
        except Exception as error:
            log.warning("operations.snapshot.failed type=%s", type(error).__name__)
        time.sleep(15)


if __name__ == "__main__":
    run()
