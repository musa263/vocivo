"""Run in a Python container sharing the isolated FreeSWITCH network namespace.

Uses only loopback SIP peers and the production generated outbound XML. Validates
selected carrier, caller ID, actual media bridging, capacity and no fallback.
"""
import json
import re
import select
import socket
import struct
import threading
import time
import uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

FIXTURE = json.load(open('/fixtures/routes.json'))
ROUTES = FIXTURE['routes']
COUNTS = [0, 0]
ERRORS = []
MEDIA = [0, 0]
READY = [threading.Event(), threading.Event()]


class Api(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
        xml = FIXTURE['unavailable']
        for route in ROUTES:
            if body.get('variable_sip_h_X-Vocivo-Route-Token') == [route['token']] and body.get('Caller-Destination-Number') == [route['destination']]:
                xml = route['xml']
        self.send_response(200)
        self.send_header('Content-Type', 'text/xml')
        self.send_header('Content-Length', str(len(xml.encode())))
        self.end_headers()
        self.wfile.write(xml.encode())


def headers(msg):
    return {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip()
            for line in msg.split('\r\n\r\n')[0].split('\r\n')[1:] if ':' in line}


def response(msg, status='200 OK', body='', contact='', tag=''):
    h = headers(msg)
    fields = [f'{name}: {h[name.lower()]}' for name in ['Via', 'From', 'Call-ID', 'CSeq']]
    fields.append('To: ' + h['to'] + tag)
    if body:
        fields += ['Content-Type: application/sdp', f'Contact: <{contact}>']
    return f'SIP/2.0 {status}\r\n' + '\r\n'.join(fields) + f'\r\nContent-Length: {len(body)}\r\n\r\n' + body


def sdp(port):
    return f'v=0\r\no=test 1 1 IN IP4 127.0.0.1\r\ns=local\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {port} RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\na=ptime:20\r\na=sendrecv\r\n'


def carrier(index):
    sip = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sip.bind(('127.0.0.1', 15080 + index))
    rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rtp.bind(('127.0.0.1', 15180 + index))
    calls = set()
    while True:
        for ready in select.select([sip, rtp], [], [], 1)[0]:
            raw, addr = ready.recvfrom(65536)
            if ready is rtp:
                MEDIA[index] += 1
                rtp.sendto(raw, addr)
                continue
            msg = raw.decode()
            if msg.startswith('INVITE '):
                h = headers(msg)
                if h['call-id'] not in calls:
                    calls.add(h['call-id'])
                    COUNTS[index] += 1
                    if not msg.startswith(f'INVITE sip:{ROUTES[index]["destination"]}@'):
                        ERRORS.append('Wrong gateway destination')
                    if ROUTES[index]['callerId'] not in h['from']:
                        ERRORS.append('Wrong tenant caller ID')
                if not re.search(r'^a=rtpmap:8 PCMA/8000', msg, re.M):
                    sip.sendto(response(msg, status='488 Not Acceptable Here', tag=';tag=carrier').encode(), addr)
                    continue
                body = sdp(15180 + index)
                sip.sendto(response(msg, body=body, contact=f'sip:carrier@127.0.0.1:{15080 + index}', tag=';tag=carrier').encode(), addr)
            elif msg.startswith(('OPTIONS ', 'BYE ', 'CANCEL ')):
                sip.sendto(response(msg).encode(), addr)
                if msg.startswith('OPTIONS '):
                    READY[index].set()


class Caller:
    def __init__(self, index, invalid=False, opus=False):
        self.opus = opus
        self.sip = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sip.bind(('127.0.0.1', 0))
        self.sip.settimeout(8)
        self.rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rtp.bind(('127.0.0.1', 0))
        self.port = self.sip.getsockname()[1]
        self.cid = uuid.uuid4().hex
        route = ROUTES[index]
        target = f'sip:{route["destination"]}@127.0.0.1:15060'
        self.base = f'Via: SIP/2.0/UDP 127.0.0.1:{self.port};branch=z9hG4bK{self.cid}\r\nMax-Forwards: 70\r\nFrom: <sip:caller@127.0.0.1>;tag=caller{self.cid}\r\nTo: <{target}>\r\nCall-ID: {self.cid}\r\nContact: <sip:caller@127.0.0.1:{self.port}>\r\n'
        token = 'invalid' if invalid else route['token']
        body = sdp(self.rtp.getsockname()[1])
        if opus:
            body = body.replace('RTP/AVP 8', 'RTP/AVP 102').replace('a=rtpmap:8 PCMA/8000', 'a=rtpmap:102 opus/48000/2')
        msg = f'INVITE {target} SIP/2.0\r\n{self.base}CSeq: 1 INVITE\r\nX-Vocivo-Flow: outbound\r\nX-Vocivo-Caller-ID: {route["callerId"]}\r\nX-Vocivo-Route-Token: {token}\r\nContent-Type: application/sdp\r\nContent-Length: {len(body)}\r\n\r\n{body}'
        self.sip.sendto(msg.encode(), ('127.0.0.1', 15060))
        while True:
            reply = self.sip.recv(65536).decode()
            self.code = int(reply.split()[1])
            if self.code >= 200:
                self.h = headers(reply)
                self.target = re.search(r'<([^>]+)>', self.h.get('contact', f'<{target}>')).group(1)
                self.send('ACK', 1)
                if self.code == 200:
                    self.media = ('127.0.0.1', int(re.search(r'm=audio (\d+)', reply).group(1)))
                break

    def send(self, method, seq):
        branch = self.cid if method == 'ACK' and self.code >= 300 else uuid.uuid4().hex
        msg = f'{method} {self.target} SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:{self.port};branch=z9hG4bK{branch}\r\nMax-Forwards: 70\r\nFrom: {self.h["from"]}\r\nTo: {self.h["to"]}\r\nCall-ID: {self.cid}\r\nCSeq: {seq} {method}\r\nContent-Length: 0\r\n\r\n'
        self.sip.sendto(msg.encode(), ('127.0.0.1', 15060))
        return msg.encode()

    def audio(self):
        received = 0
        for seq in range(100):
            started = time.monotonic()
            payload = b'\xf8\xff\xfe' if self.opus else b'\xd5' * 160
            self.rtp.sendto(struct.pack('!BBHII', 0x80, 102 if self.opus else 8, seq, seq * (960 if self.opus else 160), 12345) + payload, self.media)
            for ready in select.select([self.rtp], [], [], .02)[0]:
                packet = ready.recv(2048)
                received += (len(packet) > 12 and packet[1] & 127 == 102) if self.opus else packet[12:] == b'\xd5' * 160
            # A fast loopback echo must not compress two seconds of RTP into
            # a sub-second burst. Test both real pacing and billable duration.
            time.sleep(max(0, .02 - (time.monotonic() - started)))
        return received

    def close(self):
        if self.code == 200:
            packet = self.send('BYE', 2)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                self.sip.settimeout(min(.5, max(.01, deadline - time.monotonic())))
                try:
                    message = self.sip.recv(65536).decode()
                except socket.timeout:
                    # UDP transactions retransmit the same branch and CSeq.
                    self.sip.sendto(packet, ('127.0.0.1', 15060))
                    continue
                if headers(message).get('cseq') == '2 BYE':
                    assert message.startswith('SIP/2.0 200 '), message.split('\r\n')[0]
                    break
            else:
                raise AssertionError('BYE was not acknowledged')
        self.sip.close()
        self.rtp.close()


def limit_usage(gateway):
    with socket.create_connection(('127.0.0.1', 18021), timeout=3) as sock:
        stream = sock.makefile('rb')
        def frame():
            fields = {}
            while True:
                line = stream.readline().decode().strip()
                if not line: break
                key, value = line.split(':', 1); fields[key.lower()] = value.strip()
            return fields, stream.read(int(fields.get('content-length', '0'))).decode().strip()
        frame()
        sock.sendall(b'auth local-test-only\n\n')
        reply, _ = frame()
        assert reply.get('reply-text', '').startswith('+OK'), 'ESL fixture authentication failed'
        sock.sendall(f'api limit_usage hash vocivo-carrier {gateway}\n\n'.encode())
        _, body = frame()
        return int(body.split('/')[0])


threading.Thread(target=HTTPServer(('127.0.0.1', 18881), Api).serve_forever, daemon=True).start()
for index in [0, 1]:
    threading.Thread(target=carrier, args=(index,), daemon=True).start()
for event in READY:
    assert event.wait(40), 'Simulated carrier received no gateway OPTIONS'
time.sleep(.2)
a = Caller(0)
assert a.code == 200, ('first carrier failed', a.code)
blocked = Caller(0)
assert blocked.code >= 400, ('capacity not enforced', blocked.code)
b = Caller(1)
assert b.code == 200, ('other tenant blocked', b.code)
invalid = Caller(1, invalid=True)
assert invalid.code == 503, ('invalid route admitted', invalid.code)
audio = [a.audio(), b.audio()]
assert min(audio) > 30 and min(MEDIA) > 30, (audio, MEDIA)
assert COUNTS == [1, 1] and not ERRORS, (COUNTS, ERRORS)
for caller in [a, blocked, b, invalid]:
    caller.close()
deadline = time.monotonic() + 5
while any(limit_usage(route['carrierGateway']) for route in ROUTES):
    assert time.monotonic() < deadline, 'Carrier capacity did not release within five seconds after BYE'
    time.sleep(.05)
# Inspect actual hook output from the production generated XML and shell hook.
# A route denied at capacity may also have a zero-duration record; each answered
# tenant call must have its own positive duration and channel identity.
deadline = time.monotonic() + 10
while True:
    jobs = [json.loads(path.read_text()) for path in Path('/spool/hangups').glob('*.json')]
    if all(any(job['routeId'] == route['routeId'] and job['durationSeconds'] > 0 and job['eventId'] for job in jobs) for route in ROUTES): break
    assert time.monotonic() < deadline, ('Answered hangup records lost their final duration', jobs)
    time.sleep(.05)
retry = Caller(0, opus=True)
assert retry.code == 200, ('Opus-only caller could not reach the G.711 carrier after releasing capacity', retry.code)
before = MEDIA[0]
opus_audio = retry.audio()
assert opus_audio > 30 and MEDIA[0] > before + 30, ('Opus/G.711 media did not cross the bridge', opus_audio, MEDIA[0] - before)
retry.close()
print(json.dumps({'tenantGateways': COUNTS, 'callerIdCorrect': not ERRORS, 'mediaEchoPackets': audio, 'carrierMediaPackets': MEDIA, 'capacityDenied': blocked.code, 'invalidGrantDenied': invalid.code, 'capacityReleased': True, 'hangupDurationPersisted': True, 'opusToG711EchoPackets': opus_audio}))
