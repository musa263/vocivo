"""Loopback SIP peers exercising the real extension delivery routes.

No carrier, credentials, push providers, or audio devices are involved. The
fixture replaces only admission and media, not transaction/registrar routing.
"""
import re
import socket
import time
import uuid

PORT = 15061


def delivery_config(source, *, suspended_baseline=False):
    start = source.index('route[DELIVER_EXTENSION] {')
    end = source.index('# One line per call event', start)
    delivery = source[start:end]
    # These tests carry no SDP. Media negotiation is a separate acceptance gate.
    delivery = delivery.replace('rtpengine_delete();', 'route(TEST_MEDIA_DELETE);')
    if suspended_baseline:
        # Reproduce the previous production delivery algorithm. It forwards
        # INVITEs but leaves TM suspended, so replies never reach the caller.
        delivery = '''route[DELIVER_EXTENSION] {
            $ru = "sip:" + $rU + "@" + $env(VOCIVO_SIP_REALM);
            $avp(wake_aor) = $ru;
            append_hf("X-Vocivo-Call-UUID: $ci\\r\\n");
            if (!t_newtran()) exit;
            t_set_fr(45000, 45000);
            t_set_max_lifetime(45000, 45000);
            if (!t_suspend()) exit;
            ts_store("$avp(wake_aor)");
            ts_append("location", "$avp(wake_aor)");
            exit;
        }
        route[RESUME_WAKE] { return; }
        '''
    modules = ['tm', 'tmx', 'sl', 'pv', 'xlog', 'rr', 'textops',
               'siputils', 'usrloc', 'registrar', 'tsilo', 'htable']
    return '\n'.join([
        '#!KAMAILIO', 'debug=2', 'children=2',
        f'listen=udp:127.0.0.1:{PORT}',
        *[f'loadmodule "{name}.so"' for name in modules],
        'modparam("usrloc", "use_domain", 1)',
        'modparam("tsilo", "use_domain", 1)',
        'modparam("registrar", "append_branches", 1)',
        'modparam("htable", "htable", "wake=>size=10;autoexpire=90;")',
        '''route {
            if (is_method("OPTIONS")) { sl_send_reply("200", "OK"); exit; }
            if (is_method("CANCEL")) {
                if (t_check_trans()) t_relay();
                exit;
            }
            if (has_totag()) {
                if (loose_route()) t_relay();
                else sl_send_reply("481", "No dialog");
                exit;
            }
            if (is_method("REGISTER")) {
                if (!save("location")) { sl_reply_error(); exit; }
                route(RESUME_WAKE);
                ts_append_by_contact("location", "$var(reg_aor)");
                exit;
            }
            if (is_method("INVITE")) {
                record_route();
                route(DELIVER_EXTENSION);
                exit;
            }
            sl_send_reply("405", "Method Not Allowed");
        }
        route[MEDIA_OFFER] { return; }
        route[WAKEUP_NOW] { return; }
        route[TEST_MEDIA_DELETE] { return; }
        failure_route[MANAGE_FAILURE] { return; }
        onreply_route[MANAGE_REPLY] { return; }
        ''',
        delivery.replace('    dlg_manage();\n', ''),
    ])


def headers(message, name):
    return re.findall(r'^' + re.escape(name) + r':\s*([^\r\n]*)', message, re.M | re.I)


class Peer:
    def __init__(self, user=None):
        self.user = user or 'device-' + uuid.uuid4().hex[:10]
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.contact = f'sip:{uuid.uuid4().hex}@127.0.0.1:{self.sock.getsockname()[1]}'
        self.inbox = []

    def close(self):
        self.sock.close()

    def send(self, message):
        self.sock.sendto(message.encode(), ('127.0.0.1', PORT))

    def receive(self, predicate, timeout=3):
        for index, message in enumerate(self.inbox):
            if predicate(message):
                return self.inbox.pop(index)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.sock.settimeout(max(0.01, deadline - time.monotonic()))
            message = self.sock.recv(65536).decode()
            if predicate(message):
                return message
            self.inbox.append(message)
        raise TimeoutError('Expected SIP message did not arrive')

    def response(self, method, status, timeout=3):
        return self.receive(lambda m: m.startswith(f'SIP/2.0 {status} ')
                            and headers(m, 'CSeq')[0].endswith(' ' + method), timeout)

    def request(self, method, target, call_id=None, branch=None, to=None, cseq=1, routes=(), expires=None):
        call_id = call_id or uuid.uuid4().hex
        branch = branch or 'z9hG4bK' + uuid.uuid4().hex
        lines = [f'{method} {target} SIP/2.0',
                 f'Via: SIP/2.0/UDP 127.0.0.1:{self.sock.getsockname()[1]};branch={branch};rport',
                 f'From: <sip:{self.user}@check>;tag=caller',
                 'To: ' + (to or f'<{target}>'),
                 f'Call-ID: {call_id}', f'CSeq: {cseq} {method}',
                 'Max-Forwards: 10', f'Contact: <{self.contact}>']
        lines += ['Route: ' + route for route in routes]
        if expires is not None:
            lines += [f'Expires: {expires}']
        self.send('\r\n'.join(lines + ['Content-Length: 0', '', '']))
        return call_id, branch

    def register(self, expires=120):
        self.request('REGISTER', 'sip:check', to=f'<sip:{self.user}@check>', expires=expires)
        self.response('REGISTER', 200)

    def reply(self, request, status):
        lines = [f'SIP/2.0 {status} Test response']
        for name in ['Via', 'Record-Route', 'From', 'To', 'Call-ID', 'CSeq']:
            for value in headers(request, name):
                if name == 'To' and ';tag=' not in value:
                    value += ';tag=' + self.user
                lines.append(f'{name}: {value}')
        lines += [f'Contact: <{self.contact}>', 'Content-Length: 0', '', '']
        self.send('\r\n'.join(lines))


def answered_dialog(caller, callee, invitation):
    call_id = headers(invitation, 'Call-ID')[0]
    assert headers(invitation, 'X-Vocivo-Call-UUID') == [call_id]
    callee.reply(invitation, 180)
    caller.response('INVITE', 180)
    callee.reply(invitation, 200)
    answer = caller.response('INVITE', 200)
    options = dict(call_id=call_id, to=headers(answer, 'To')[0],
                   routes=reversed(headers(answer, 'Record-Route')))
    caller.request('ACK', callee.contact, **options)
    callee.receive(lambda m: m.startswith('ACK '))
    options['routes'] = reversed(headers(answer, 'Record-Route'))
    caller.request('BYE', callee.contact, cseq=2, **options)
    bye = callee.receive(lambda m: m.startswith('BYE '))
    callee.reply(bye, 200)
    caller.response('BYE', 200)


def run_delivery_probes(*, suspended_baseline=False):
    peers = []

    def peer(user=None):
        value = Peer(user)
        peers.append(value)
        return value

    try:
        caller, callee = peer(), peer()
        callee.register()
        caller.request('INVITE', f'sip:{callee.user}@check')
        invitation = callee.receive(lambda m: m.startswith('INVITE '))
        if suspended_baseline:
            callee.reply(invitation, 180)
            try:
                caller.response('INVITE', 180, timeout=1)
            except TimeoutError:
                print('REPRODUCED: suspended production algorithm loses receiver 180', flush=True)
                return
            raise AssertionError('Baseline unexpectedly forwarded 180; revisit the regression')
        answered_dialog(caller, callee, invitation)
        print('PASS registered receiver: 180, 200, ACK and BYE delivered', flush=True)

        for delay in [9, 20, 40]:
            caller, callee = peer(), peer()
            caller.request('INVITE', f'sip:{callee.user}@check')
            caller.response('INVITE', 100)
            time.sleep(delay)
            callee.register()
            invitation = callee.receive(lambda m: m.startswith('INVITE '))
            answered_dialog(caller, callee, invitation)
            print(f'PASS receiver registers after {delay}s: ring and answer', flush=True)

        caller, first = peer(), peer()
        second = peer(first.user)
        first.register()
        caller.request('INVITE', f'sip:{first.user}@check')
        first_invite = first.receive(lambda m: m.startswith('INVITE '))
        first.reply(first_invite, 180)
        caller.response('INVITE', 180)
        second.register()
        second_invite = second.receive(lambda m: m.startswith('INVITE '))
        # A re-REGISTER must not create another branch to the same contact.
        second.register()
        try:
            second.receive(lambda m: m.startswith('INVITE '), timeout=0.2)
        except TimeoutError:
            pass
        else:
            raise AssertionError('Re-registration duplicated a ringing branch')
        answered_dialog(caller, second, second_invite)
        cancel = first.receive(lambda m: m.startswith('CANCEL '))
        first.reply(cancel, 200)
        first.reply(first_invite, 487)
        print('PASS late second device answers and cancels the first device', flush=True)

        first_caller, second_caller, callee = peer(), peer(), peer()
        target = f'sip:{callee.user}@check'
        canceled_id, canceled_branch = first_caller.request('INVITE', target)
        first_caller.response('INVITE', 100)
        live_id, _ = second_caller.request('INVITE', target)
        second_caller.response('INVITE', 100)
        first_caller.request('CANCEL', target, call_id=canceled_id, branch=canceled_branch)
        first_caller.response('CANCEL', 200)
        callee.register()
        invitation = callee.receive(lambda m: m.startswith('INVITE '))
        assert headers(invitation, 'Call-ID') == [live_id], 'Canceled caller was resurrected'
        answered_dialog(second_caller, callee, invitation)
        print('PASS concurrent waiters: canceled caller stays ended, live caller connects', flush=True)

        # One AOR can have more than one suspended call. REGISTER must resume
        # both, not replace the earlier caller's pending transaction identifier.
        first_caller, second_caller, callee = peer(), peer(), peer()
        target = f'sip:{callee.user}@check'
        first_id, _ = first_caller.request('INVITE', target)
        first_caller.response('INVITE', 100)
        second_id, _ = second_caller.request('INVITE', target)
        second_caller.response('INVITE', 100)
        callee.register()
        for caller, call_id in [(first_caller, first_id), (second_caller, second_id)]:
            invitation = callee.receive(lambda m: m.startswith('INVITE ')
                                       and headers(m, 'Call-ID') == [call_id])
            answered_dialog(caller, callee, invitation)
        print('PASS both simultaneous pending calls are resumed', flush=True)

        caller, callee = peer(), peer()
        caller.request('INVITE', f'sip:{callee.user}@check')
        caller.response('INVITE', 408, timeout=48)
        callee.register()
        try:
            callee.receive(lambda m: m.startswith('INVITE '), timeout=1)
        except TimeoutError:
            pass
        else:
            raise AssertionError('Registration resurrected an expired call')
        print('PASS unanswered call expires and cannot ring a late device', flush=True)
    finally:
        for item in peers:
            item.close()
