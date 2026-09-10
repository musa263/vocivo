#!/usr/bin/env python3
"""Private durable SIP deliveries. No SIP listeners or external dependencies."""
import base64
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import time
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

LOG = logging.getLogger('vocivo.outbox')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def upload_url(original, api, secret, now):
    """Verify old private metadata before renewing this exact voicemail grant."""
    url = urlsplit(original)
    target = urlsplit(api)
    if (url.scheme, url.netloc, url.path) != (target.scheme, target.netloc, '/api/voice/sip-voicemail'):
        raise ValueError('Invalid upload destination')
    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
    names = ('org', 'call', 'from', 'name', 'exp', 'sig')
    if set(query) != set(names) or any(len(query[name]) != 1 for name in names):
        raise ValueError('Invalid upload metadata')
    fields = {key: query[key][0] for key in names}
    def signature():
        payload = '\n'.join(['voicemail', *[fields[key] for key in names[:-1]]])
        return base64.urlsafe_b64encode(hmac.new((secret + ':sip-dialplan').encode(), payload.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    if not hmac.compare_digest(signature(), fields['sig']):
        raise ValueError('Invalid upload signature')
    fields['exp'] = str(int(now) + 3600)
    fields['sig'] = signature()
    return urlunsplit((target.scheme, target.netloc, url.path, urlencode(fields), ''))


class Outbox:
    def __init__(self, api, secret, spool, cdr, recordings, send=None):
        self.api = api.rstrip('/')
        self.secret = secret
        self.spool, self.cdr, self.recordings = map(Path, (spool, cdr, recordings))
        self.send = send or self.http
        self.next_attempt = {}

    def http(self, url, data, content_type, method):
        req = Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.secret, 'Content-Type': content_type,
        })
        with build_opener(NoRedirect).open(req, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise OSError('Delivery rejected')
            response.read(65536)

    def jobs(self):
        yield from ((p, 'hangup') for p in self.spool.joinpath('hangups').glob('*.json'))
        yield from ((p, 'cdr') for p in self.cdr.rglob('*.cdr.json'))
        yield from ((p, 'voicemail') for p in self.recordings.glob('*.wav.upload'))

    def tick(self, now=None):
        now = time.time() if now is None else now
        count = 0
        for path, kind in self.jobs():
            if count >= 50:
                break
            if path.is_symlink() or self.next_attempt.get(path, 0) > now:
                continue
            # FreeSWITCH writes CDRs directly. Allow completion before reading.
            if now - path.stat().st_mtime < 5:
                continue
            count += 1
            try:
                if kind == 'voicemail':
                    audio = path.with_suffix('')
                    if audio.is_symlink() or not 44 < audio.stat().st_size <= 4 * 1024 * 1024:
                        raise ValueError('Invalid recording')
                    url = upload_url(path.read_text(), self.api, self.secret, now)
                    self.send(url, audio.read_bytes(), 'audio/wav', 'PUT')
                    path.unlink()
                    audio.unlink()
                else:
                    if path.stat().st_size > 8 * 1024 * 1024:
                        raise ValueError('Oversized record')
                    data = path.read_bytes()
                    parsed = json.loads(data)
                    if not isinstance(parsed, dict):
                        raise ValueError('Invalid record')
                    endpoint = 'sip-hangup' if kind == 'hangup' else 'sip-cdr'
                    self.send(self.api + '/api/voice/' + endpoint, data, 'application/json', 'POST')
                    path.unlink()
                self.next_attempt.pop(path, None)
            except (OSError, ValueError) as error:
                # Log only category/class: URLs and exception messages can
                # contain caller information, signed grants and credentials.
                LOG.warning('delivery deferred kind=%s error=%s', kind, type(error).__name__)
                self.next_attempt[path] = now + 60
        # Bound scheduler memory; filesystem remains authoritative after restart.
        if len(self.next_attempt) > 10000:
            self.next_attempt = {p: due for p, due in self.next_attempt.items() if due > now}
        return count


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    api, secret = os.environ['VOCIVO_API_URL'], os.environ['SIP_EDGE_SECRET']
    if urlsplit(api).scheme != 'https' or not secret:
        raise SystemExit('HTTPS API and SIP edge secret required')
    worker = Outbox(api, secret, '/var/lib/vocivo/outbox', '/var/log/freeswitch/json_cdr', '/var/lib/vocivo/recordings')
    while True:
        try:
            worker.tick()
        except OSError as error:
            LOG.error('spool unavailable error=%s', type(error).__name__)
        time.sleep(5)
