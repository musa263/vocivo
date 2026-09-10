"""Bounded local regressions; no production identities or carrier endpoints."""
import json, os, re, socket, sqlite3, subprocess, sys, tempfile, time, uuid
import threading
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'services/sip/tests'))
import delivery
from delivery import Peer, headers, delivery_config, answered_dialog
IMAGE='ghcr.io/kamailio/kamailio-ci:5.8.4-alpine'
SOURCE=(ROOT/'services/sip/kamailio/kamailio.cfg').read_text()
delivery.PORT=15063

def run(*args,check=True):
 return subprocess.run(['docker',*map(str,args)],capture_output=True,text=True,check=check)

def section(start,end): return SOURCE[SOURCE.index(start):SOURCE.index(end,SOURCE.index(start))]

class Fixture:
 def __init__(self,config,directory):
  self.name='vocivo-deep-'+uuid.uuid4().hex[:8]
  self.path=Path(directory)/'test.cfg';self.path.write_text(config)
 def __enter__(self):
  run('run','-d','--name',self.name,'--network','host','-v',f'{self.path}:/test.cfg:ro','-v',f'{self.path.parent}:/audit','-e','VOCIVO_SIP_REALM=check','--entrypoint','kamailio',IMAGE,'-DD','-E','-f','/test.cfg')
  for _ in range(25):
   p=Peer()
   try:p.request('OPTIONS','sip:check');p.response('OPTIONS',200,.2);return self
   except (OSError,AssertionError):time.sleep(.1)
   finally:p.close()
  print(run('logs',self.name,check=False).stderr);run('rm','-f',self.name,check=False)
  raise RuntimeError('fixture not ready')
 def __exit__(self,*args):
  result=run('logs',self.name,check=False)
  (self.path.parent/'kamailio.log').write_text(result.stdout+result.stderr)
  run('rm','-f',self.name,check=False)

out=Path(tempfile.mkdtemp(prefix='sip-repairs-'))

# The committed delivery algorithm, with only admission and media stubbed by
# its existing repository fixture. A port-bearing To URI is valid registrar input.
d=out/'wake';d.mkdir(exist_ok=True)
cfg=delivery_config(SOURCE).replace('15061','15063')
with Fixture(cfg,d):
 caller,receiver=Peer(),Peer('late-device-'+uuid.uuid4().hex[:8])
 try:
  target=f'sip:{receiver.user}@check'
  caller.request('INVITE',target)
  caller.response('INVITE',100)
  receiver.request('REGISTER','sip:check',to=f'<{target}:5060>',expires=120)
  receiver.response('REGISTER',200)
  receiver.receive(lambda m:m.startswith('INVITE '),2)
  print('PASS: port-bearing REGISTER resumes the canonical waiter',flush=True)
 finally:caller.close();receiver.close()

# Keep the actual production timer values: a trusted registered PBX leg must
# still be answerable after the previous 45-second hard deadline.
d=out/'ring-budget';d.mkdir(exist_ok=True)
with Fixture(delivery_config(SOURCE).replace('15061','15063'),d):
 caller,receiver=Peer(),Peer()
 try:
  receiver.register()
  caller.request('INVITE',f'sip:{receiver.user}@check')
  invitation=receiver.receive(lambda m:m.startswith('INVITE '))
  receiver.reply(invitation,180);caller.response('INVITE',180)
  time.sleep(47)
  answered_dialog(caller,receiver,invitation)
  print('PASS: trusted PBX receiver answers after 47 seconds',flush=True)
 finally:caller.close();receiver.close()

# Negative admission check against the production in-dialog block. All
# addresses are loopback fixtures; no production route or grant is supplied.
d=out/'dialog';d.mkdir(exist_ok=True)
block=section('    if (has_totag()) {','    if (is_method("INVITE")) {\n        t_on_reply("MANAGE_REPLY");')
block=re.sub(r'rtpengine_manage\([^;]*;', 'route(NOOP);', block)
block=block.replace('udp:0.0.0.0:5060','udp:127.0.0.1:15063')
mods=['tm','tmx','sl','pv','xlog','rr','dialog','textops','siputils','nathelper','htable']
cfg='\n'.join(['#!KAMAILIO','debug=2','children=1','#!define FLT_FS 3','listen=udp:127.0.0.1:15063',*[f'loadmodule "{m}.so"' for m in mods],
 'modparam("htable","htable","cdr=>size=4;autoexpire=90;")',
 'route { if(is_method("OPTIONS")) {sl_send_reply("200","OK");exit;}',block,
 'if ($fU == "admitted-fixture") {record_route();dlg_manage();t_relay();exit;} sl_send_reply("403","Initial call not authorized");exit;}',
 'route[MEDIA_TO_RTP] {return 1;} route[MEDIA_TO_WEBRTC] {return 1;} route[NOOP] {return;} route[CDR_ENQUEUE] {return;} onreply_route[MANAGE_REPLY] {return;}',SOURCE[SOURCE.index('route[RELAY] {'):]])
with Fixture(cfg,d):
 caller,receiver=Peer(),Peer()
 try:
  for method in ['INVITE','UPDATE','PRACK','INFO','BYE']:
   caller.request(method,receiver.contact,to='<sip:fixture@check>;tag=unknown-dialog',routes=['<sip:127.0.0.1:15063;lr>'])
   caller.response(method,481)
  try: receiver.receive(lambda m: True,.3)
  except socket.timeout: pass
  else: raise AssertionError('unknown dialog forwarded to peer')
  print('PASS: unknown-dialog requests rejected before relay',flush=True)
  caller.user = 'admitted-fixture'
  caller.request('INVITE',receiver.contact)
  invite = receiver.receive(lambda m:m.startswith('INVITE '))
  receiver.reply(invite,200)
  answer = caller.response('INVITE',200)
  call_id = headers(answer,'Call-ID')[0]
  for method,seq in [('ACK',1),('UPDATE',2),('BYE',3)]:
   caller.request(method,receiver.contact,call_id=call_id,to=headers(answer,'To')[0],cseq=seq,routes=reversed(headers(answer,'Record-Route')))
   message = receiver.receive(lambda m:m.startswith(method+' '))
   if method != 'ACK':
    receiver.reply(message,200);caller.response(method,200)
  print('PASS: admitted dialog retains ACK, UPDATE and BYE delivery',flush=True)

 finally:caller.close();receiver.close()

# Use the real CDR expression, SQL writer and reply callback with one worker.
# Different dummy route markers show message-to-message contamination without
# using any credentials, signed grants or production tenant data.
d=out/'cdr';d.mkdir(exist_ok=True)
db=sqlite3.connect(d/'cdr.db');db.execute('CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,body TEXT)');db.execute('DELETE FROM outbox');db.commit();db.close()
mods=['tm','tmx','sl','pv','xlog','textops','siputils','nathelper','sqlops','db_sqlite','htable']
callback=section('onreply_route {','route[RELAY] {')
callback=re.sub(r'rtpengine_manage\([^;]*;', 'route(NOOP);', callback)
receiver=Peer();caller=Peer();other=Peer()
cfg='\n'.join(['#!KAMAILIO','debug=2','children=1','#!define FLT_WS 4','listen=udp:127.0.0.1:15063',*[f'loadmodule "{m}.so"' for m in mods],
 'modparam("sqlops","sqlcon","cdrdb=>sqlite:///audit/cdr.db")','modparam("htable","htable","cdr=>size=4;autoexpire=90;")',
 '''route {
 route(ROUTE_TOKEN);
 if(is_method("OPTIONS")) {sl_send_reply("200","OK");exit;}
 if(is_method("MESSAGE")) {sl_send_reply("200","OK");exit;}
 $sht(cdr=>$ci)=1;$var(cdr_event)="invite";$var(cdr_flow)="internal";route(CDR_ENQUEUE);
 t_on_reply("MANAGE_REPLY");''',f'$du="sip:127.0.0.1:{receiver.sock.getsockname()[1]}";', 't_relay();exit;} route[MEDIA_TO_RTP] {return 1;} route[MEDIA_TO_WEBRTC] {return 1;} route[NOOP] { return; }',
 section('route[ROUTE_TOKEN] {','# What the API said'),section('route[CDR_ENQUEUE] {','# Every second'),callback])
with Fixture(cfg,d):
 try:
  def send(peer,method,marker):
   peer.request(method,'sip:target@check')
   # Request helper has no custom headers. Re-send a distinct valid transaction.
  def marked(peer,method,call_id,marker):
   payload=f'{method} sip:target@check SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:{peer.sock.getsockname()[1]};branch=z9hG4bK{uuid.uuid4().hex};rport\r\nFrom: <sip:caller@check>;tag=one\r\nTo: <sip:target@check>\r\nCall-ID: {call_id}\r\nCSeq: 1 {method}\r\nMax-Forwards: 10\r\nContact: <{peer.contact}>\r\nX-Vocivo-Route-Token: {marker}\r\nContent-Length: 0\r\n\r\n'
   peer.send(payload)
  marked(caller,'INVITE','audit-call-a','markerA.value')
  invitation=receiver.receive(lambda m:m.startswith('INVITE '))
  marked(other,'MESSAGE','audit-call-b','markerB.value');other.response('MESSAGE',200)
  receiver.reply(invitation,200);caller.response('INVITE',200)
  db=sqlite3.connect(d/'cdr.db');rows=[json.loads(r[0]) for r in db.execute('select body from outbox')];db.close()
  answered=next(r for r in rows if r['event']=='answered')
  assert answered['callId']=='audit-call-a' and answered['routeToken']=='' and rows[0]['routeToken']=='markerA.value',rows
  (d/'observed.json').write_text(json.dumps(rows,indent=2))
  print('PASS: interleaved request cannot contaminate call A answer token',flush=True)
 finally:receiver.close();caller.close();other.close()

# A real rtpengine client pointed at an unused loopback port. Admission is
# fixture-only; test whether unavailable media stops delivery of an SDP INVITE.
d=out/'media';d.mkdir(exist_ok=True)
cfg=delivery_config(SOURCE).replace('15061','15063')
cfg=cfg.replace('route[MEDIA_OFFER] { return; }',section('route[MEDIA_TO_RTP] {','onreply_route[MANAGE_REPLY] {'))
cfg=cfg.replace('debug=2','debug=2\n#!define FLT_FS 3\nloadmodule "rtpengine.so"\nmodparam("rtpengine","rtpengine_sock","udp:127.0.0.1:22999")\nmodparam("rtpengine","rtpengine_tout_ms",100)\nmodparam("rtpengine","rtpengine_retr",1)')
with Fixture(cfg,d):
 caller,receiver=Peer(),Peer('media-device-'+uuid.uuid4().hex[:8])
 try:
  receiver.register()
  sdp='v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\ns=fixture\r\nc=IN IP4 192.0.2.1\r\nt=0 0\r\nm=audio 30000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n'
  payload=f'INVITE sip:{receiver.user}@check SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:{caller.sock.getsockname()[1]};branch=z9hG4bK{uuid.uuid4().hex};rport\r\nFrom: <sip:caller@check>;tag=one\r\nTo: <sip:{receiver.user}@check>\r\nCall-ID: audit-no-media\r\nCSeq: 1 INVITE\r\nMax-Forwards: 10\r\nContact: <{caller.contact}>\r\nContent-Type: application/sdp\r\nContent-Length: {len(sdp)}\r\n\r\n{sdp}'
  caller.send(payload)
  caller.response('INVITE',503,3)
  try: receiver.receive(lambda m:m.startswith('INVITE '),.3)
  except socket.timeout: pass
  else: raise AssertionError('unconverted SDP was forwarded')
  print('PASS: unavailable media returns 503 without forwarding SDP',flush=True)
 finally:caller.close();receiver.close()

# A failed answer rewrite must not forward a successful SIP answer or record it
# as answered. Exercise the real onreply route, not a structural assertion.
d=out/'media-answer';d.mkdir(exist_ok=True)
cfg='\n'.join(['#!KAMAILIO','debug=2','children=1','#!define FLT_WS 4','listen=udp:127.0.0.1:15063',
 *[f'loadmodule "{m}.so"' for m in ['tm','tmx','sl','pv','xlog','textops','siputils','nathelper','htable','rtpengine']],
 'modparam("htable","htable","cdr=>size=4;autoexpire=90;")',
 'modparam("rtpengine","rtpengine_sock","udp:127.0.0.1:22999")',
 'modparam("rtpengine","rtpengine_tout_ms",100)','modparam("rtpengine","rtpengine_retr",1)',
 'route {if(is_method("OPTIONS")){sl_send_reply("200","OK");exit;} $sht(cdr=>$ci)=1;t_on_reply("MANAGE_REPLY");t_relay();exit;}',
 'route[CDR_ENQUEUE] { xlog("L_ERR","UNEXPECTED_ANSWER_RECORD\\n"); }',
 section('route[MEDIA_TO_RTP] {','route[MEDIA_OFFER] {'),
 section('onreply_route {','route[RELAY] {')])
with Fixture(cfg,d):
 caller,receiver=Peer(),Peer()
 try:
  caller.request('INVITE',receiver.contact)
  invite=receiver.receive(lambda m:m.startswith('INVITE '))
  lines=['SIP/2.0 200 OK']
  for name in ['Via','From','To','Call-ID','CSeq']:
   for value in headers(invite,name):
    if name=='To': value+=';tag=answer-fixture'
    lines.append(name+': '+value)
  lines += ['Content-Type: application/sdp',f'Content-Length: {len(sdp)}','','']
  receiver.send('\r\n'.join(lines)+sdp)
  try: caller.response('INVITE',200,.8)
  except socket.timeout: pass
  else: raise AssertionError('failed media answer was relayed as success')
 finally:caller.close();receiver.close()
assert 'UNEXPECTED_ANSWER_RECORD' not in (d/'kamailio.log').read_text()
print('PASS: failed media answer is suppressed and never recorded as answered',flush=True)

# Exercise the successful core reply path with a deterministic NG control
# server. This validates SDP replacement and direction selection; it does not
# substitute for RTP, ICE or DTLS media acceptance against a real engine.
for listener, expected_profile in [(15063,b'RTP/AVP'),(8080,b'UDP/TLS/RTP/SAVPF')]:
 d=out/f'media-success-{listener}';d.mkdir(exist_ok=True)
 rewritten=sdp.replace('192.0.2.1','198.51.100.7')
 requests=[]
 control=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
 control.bind(('127.0.0.1',22998));control.settimeout(.2)
 stopped=threading.Event()
 def serve():
  while not stopped.is_set():
   try: packet,remote=control.recvfrom(65536)
   except socket.timeout: continue
   cookie,body=packet.split(b' ',1);requests.append(body)
   reply=(b'd6:result4:ponge' if b'4:ping' in body else
          b'd6:result2:ok3:sdp'+str(len(rewritten)).encode()+b':'+rewritten.encode()+b'e')
   control.sendto(cookie+b' '+reply,remote)
 thread=threading.Thread(target=serve);thread.start()
 success_cfg=cfg.replace('22999','22998').replace('UNEXPECTED_ANSWER_RECORD','EXPECTED_ANSWER_RECORD')
 if listener==8080:
  # Simulate the original WebRTC listener identity while keeping this fixture
  # UDP-only. The main ingress gate separately exercises actual WebSockets.
  success_cfg=success_cfg.replace('listen=udp:127.0.0.1:15063','listen=udp:127.0.0.1:15063\nlisten=udp:127.0.0.1:8080')
 try:
  with Fixture(success_cfg,d):
   caller,receiver=Peer(),Peer()
   try:
    delivery.PORT=listener
    caller.request('INVITE',receiver.contact)
    invite=receiver.receive(lambda m:m.startswith('INVITE '))
    lines=['SIP/2.0 200 OK']
    for name in ['Via','From','To','Call-ID','CSeq']:
     for value in headers(invite,name):
      if name=='To': value+=';tag=success-fixture'
      lines.append(name+': '+value)
    lines += ['Content-Type: application/sdp',f'Content-Length: {len(sdp)}','','']
    receiver.send('\r\n'.join(lines)+sdp)
    answer=caller.response('INVITE',200)
    assert '198.51.100.7' in answer and '192.0.2.1' not in answer,answer
    assert requests and expected_profile in requests[-1],requests
   finally:
    caller.close();receiver.close();delivery.PORT=15063
  assert 'EXPECTED_ANSWER_RECORD' in (d/'kamailio.log').read_text()
  print(f'PASS: successful answer rewritten for original listener {listener}',flush=True)
 finally:
  stopped.set();thread.join();control.close()
