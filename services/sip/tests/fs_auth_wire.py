"""Prove ingress Digest terminates before the real loopback FreeSWITCH hop."""
import json
import re
import socket
import uuid
import time
from auth import mock_auth, PORT, exchange


def invite(port, *, authorization=True, proxy=False):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1', 0))
        sock.settimeout(0.5)
        tag = uuid.uuid4().hex
        target = f'sip:+12025550123@127.0.0.1:{port}'
        base = (f'Via: SIP/2.0/UDP 127.0.0.1:{sock.getsockname()[1]};branch=z9hG4bK{tag};rport\r\n'
                f'From: <sip:probe@check>;tag={tag}\r\nTo: <{target}>\r\nCall-ID: {tag}\r\n'
                f'CSeq: 1 INVITE\r\nMax-Forwards: 10\r\nContact: <sip:probe@127.0.0.1:{sock.getsockname()[1]}>\r\n')
        digest = f'Digest username="probe", realm="check", nonce="fixture", uri="{target}", response="00000000000000000000000000000000", algorithm=MD5'
        auth = ('Authorization: ' + digest + '\r\n') if authorization else ''
        if proxy:
            auth += 'Proxy-Authorization: ' + digest + '\r\n'
        body = 'v=0\r\no=probe 1 1 IN IP4 127.0.0.1\r\ns=probe\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 15190 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n'
        packet = f'INVITE {target} SIP/2.0\r\n{base}{auth}Content-Type: application/sdp\r\nContent-Length: {len(body)}\r\n\r\n{body}'.encode()
        sock.sendto(packet, ('127.0.0.1', port))
        deadline = time.monotonic() + 10
        provisional = False
        while True:
            try:
                response = sock.recv(65536).decode()
            except TimeoutError:
                assert time.monotonic() < deadline, f'No final SIP reply on {port}; provisional={provisional}'
                if not provisional:
                    sock.sendto(packet, ('127.0.0.1', port))
                continue
            provisional = True
            code = int(response.split(' ')[1])
            if code >= 200:
                break
        if code >= 300:
            to = re.search(r'^To: (.*)$', response, re.M | re.I).group(1).strip()
            ack = base.replace('CSeq: 1 INVITE', 'CSeq: 1 ACK').replace(f'To: <{target}>', 'To: ' + to)
            sock.sendto(f'ACK {target} SIP/2.0\r\n{ack}Content-Length: 0\r\n\r\n'.encode(), ('127.0.0.1', port))
        return code


def main():
    deadline = time.monotonic() + 15
    while True:
        try:
            if exchange('OPTIONS', authorized=False).startswith('SIP/2.0 200 '): break
        except (TimeoutError, OSError):
            pass
        assert time.monotonic() < deadline, 'Kamailio listener did not become ready'
        time.sleep(.2)
    # Same pinned production profile, including auth-calls=false. Supplying a
    # previous hop's credentials nevertheless triggers FreeSWITCH's Digest.
    assert invite(5080) == 407
    assert invite(5080, authorization=False, proxy=True) == 407
    assert invite(5080, authorization=False) == 480
    with mock_auth() as state:
        state.update(body='{"ok":true,"routeId":"abcdefghijklmnop","callerId":"+12025550000"}')
        assert invite(PORT, proxy=True) == 480, 'Authenticated hop still challenged by FreeSWITCH'
        before = state['nonces']
        state.update(status=403, body='{"ok":false}')
        assert invite(PORT) == 401, 'Rejected ingress credentials were forwarded'
        assert state['nonces'] == before + 1
        before = state['nonces']
        assert invite(PORT, authorization=False, proxy=True) == 401
        assert state['nonces'] == before + 1
    print(json.dumps({'freeswitchChallengeReproduced': True, 'bothCredentialHeadersConsumed': True,
                      'rejectedIngressStillChallenged': True, 'missingIngressStillChallenged': True,
                      'externalNetwork': False}))


if __name__ == '__main__':
    main()
