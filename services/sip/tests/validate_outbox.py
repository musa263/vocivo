#!/usr/bin/env python3
"""Replay actual HTTP failures after container recreation on a private volume."""
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'python:3.12-alpine@sha256:b64631e04e4920160c50fbe8d8df828f7f35f06f425cb44aa09bca53e708a35a'
PROBE = r'''
import base64, hashlib, hmac, importlib.util, json, os, subprocess, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode
spec=importlib.util.spec_from_file_location('outbox','/fs/outbox.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path('/data');api='http://127.0.0.1:18889';secret='isolated-outbox-secret'
first=os.environ['PHASE']=='fail';seen=[]
class Api(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self): self.accept()
 def do_PUT(self): self.accept()
 def accept(self):
  assert self.headers['Authorization']=='Bearer '+secret
  body=self.rfile.read(int(self.headers['Content-Length']))
  assert body
  seen.append(self.command)
  self.send_response(503 if first else 201);self.end_headers()
server=HTTPServer(('127.0.0.1',18889),Api)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
audio=root/'recordings';cdr=root/'cdr'
if first:
 audio.mkdir();cdr.mkdir()
 subprocess.run(['/bin/sh','/fs/sip-hangup.sh','fixture-route-123456','fixture-channel','7'],env={**os.environ,'VOCIVO_SIP_OUTBOX_DIR':str(root)},check=True)
 (cdr/'fixture.cdr.json').write_text('{"variables":{"uuid":"fixture"}}')
 recording=audio/'fixture.wav';recording.write_bytes(b'RIFF'+bytes(100))
 fields={'org':'tenant-fixture','call':'fixture-channel','from':'fixture','name':'Fixture','exp':'100'}
 payload='\n'.join(['voicemail',*fields.values()])
 fields['sig']=base64.urlsafe_b64encode(hmac.new((secret+':sip-dialplan').encode(),payload.encode(),hashlib.sha256).digest()).decode().rstrip('=')
 url=api+'/api/voice/sip-voicemail?'+urlencode(fields)
 subprocess.run(['/bin/sh','/fs/voicemail-hangup.sh',url,str(recording)],env={**os.environ,'VOCIVO_SIP_RECORDINGS_DIR':str(audio)},check=True)
worker=module.Outbox(api,secret,root,cdr,audio)
assert len(list(worker.jobs()))==3
assert worker.tick(time.time()+10)==3
assert sorted(seen)==['POST','POST','PUT'],seen
assert len(list(worker.jobs()))==(3 if first else 0)
assert (audio/'fixture.wav').exists()==first
server.shutdown()
print('PASS: HTTP 503 retains all jobs' if first else 'PASS: recreated container replays all jobs and deletes only after HTTP 201',flush=True)
'''


def main():
    volume = 'vocivo-outbox-validation-' + uuid.uuid4().hex[:12]
    subprocess.run(['docker', 'volume', 'create', volume], check=True, capture_output=True)
    try:
        for phase in ['fail', 'recover']:
            subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PHASE=' + phase, '-v', volume + ':/data',
                '-v', str(ROOT / 'freeswitch') + ':/fs:ro', IMAGE, 'python', '-c', PROBE], check=True, timeout=90)
    finally:
        subprocess.run(['docker', 'volume', 'rm', volume], check=True, capture_output=True)


if __name__ == '__main__':
    main()
