#!/usr/bin/env python3
"""Offline production startup, local speech/recording and socket fallback gate."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import wave
from temporary_carrier_pbx import IMAGE

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('VOCIVO_TEST_FS_IMAGE', IMAGE)
SERVER = r'''
import socket, time
server=socket.socket();server.bind(('127.0.0.1',8084));server.listen(1);server.settimeout(25)
print('ready',flush=True)
client,_=server.accept();client.sendall(b'connect\n\n');client.settimeout(5)
assert client.recv(65535)
time.sleep(.2);client.close();server.close()
'''


def run(*args, check=True):
    return subprocess.run(['docker', *map(str, args)], check=check, capture_output=True, text=True, timeout=90)


def main():
    name = 'vocivo-feature-validation-' + uuid.uuid4().hex[:8]
    with tempfile.TemporaryDirectory(prefix='vocivo-fs-features-') as directory:
        root = Path(directory)
        started = False
        peer = None
        def fs(command):
            return run('exec', name, 'fs_cli', '-x', command, check=False).stdout.strip()
        try:
            run('run', '-d', '--name', name, '--network', 'none', '--memory', '768m', '--pids-limit', '256',
                '-v', f'{ROOT / "freeswitch"}:/opt/vocivo-fs:ro', '-v', f'{root}:/state',
                '-e', 'PUBLIC_IP=127.0.0.2', '-e', 'TELNYX_SIP_HOST=127.0.0.3',
                '-e', 'TELNYX_SIP_REALM=127.0.0.3', '--entrypoint', '/bin/sh', IMAGE, '/opt/vocivo-fs/docker-entrypoint.sh')
            started = True
            deadline = time.monotonic() + 90
            while 'is ready' not in fs('status'):
                assert time.monotonic() < deadline, 'FreeSWITCH did not become ready'
                time.sleep(2)
            modules = {name: fs('module_exists ' + name) for name in [
                'mod_sofia', 'mod_opus', 'mod_curl', 'mod_http_cache', 'mod_loopback',
                'mod_flite', 'mod_event_socket', 'mod_dptools', 'mod_sndfile', 'mod_local_stream', 'mod_tone_stream', 'mod_hash']}
            assert all(value == 'true' for value in modules.values()), modules
            xml = '''<include><context name="fixture"><extension name="socket-fallback"><condition>
<action application="answer"/>
<action application="record_session" data="/state/fixture.wav"/>
<action application="set" data="tts_engine=flite"/>
<action application="set" data="tts_voice=slt"/>
<action application="speak" data="Local test announcement"/>
<action application="playback" data="tone_stream://%(1000,0,440)"/>
<action application="set" data="socket_resume=true"/>
<action application="socket" data="127.0.0.1:8084 async full"/>
<action application="set_global" data="fixture_fallback=reached"/>
<action application="hangup"/>
</condition></extension></context></include>'''
            path = root / 'fixture.xml';path.write_text(xml.replace('><', '>\n<') + '\n')
            run('cp', path, name + ':/etc/freeswitch/dialplan/fixture.xml')
            fs('reloadxml');fs('global_setvar fixture_fallback=not_reached')
            peer = subprocess.Popen(['docker', 'run', '--rm', '--network', 'container:' + name,
                'python:3.12-alpine', 'python', '-u', '-c', SERVER], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            assert peer.stdout.readline().strip() == 'ready', 'Socket fixture failed to listen'
            fs('bgapi originate loopback/probe/fixture &park()')
            stdout, stderr = peer.communicate(timeout=35)
            assert peer.returncode == 0, (stdout, stderr)
            deadline = time.monotonic() + 10
            while fs('global_getvar fixture_fallback') != 'reached':
                assert time.monotonic() < deadline, 'Socket disconnect did not resume fallback'
                time.sleep(.2)
            # Wait for final media-bug/recording close after fallback.
            deadline = time.monotonic() + 10
            while '0 total.' not in fs('show channels count'):
                assert time.monotonic() < deadline, 'Loopback channels did not terminate'
                time.sleep(.2)
            with wave.open(str(root / 'fixture.wav'), 'rb') as recording:
                frames = recording.readframes(recording.getnframes())
                assert recording.getnframes() > 1000 and any(frames), 'No generated audio in recording'
            logs = run('logs', name, check=False)
            assert 'Error opening flite voice' not in logs.stdout + logs.stderr
            print(json.dumps({'version': fs('version'), 'requiredModules': modules,
                'socketDisconnectFallback': True, 'localAudioRecorded': True, 'externalNetwork': False}))
        except Exception:
            if started:
                logs = run('logs', '--tail', '70', name, check=False)
                print(logs.stdout + logs.stderr)
            raise
        finally:
            if peer and peer.poll() is None:
                peer.terminate();peer.wait(timeout=10)
            if started:
                run('rm', '-f', name, check=False)


if __name__ == '__main__':
    main()
