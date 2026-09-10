#!/usr/bin/env python3
"""Exercise generated gateway includes with production FreeSWITCH startup, offline."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

from relay_operations import gateway_xml
from temporary_carrier_pbx import IMAGE
IMAGE = os.environ.get('VOCIVO_TEST_FS_IMAGE', IMAGE)


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=60)


def main():
    name = 'vocivo-gateway-load-' + uuid.uuid4().hex[:10]
    source = Path(__file__).resolve().parents[1] / 'freeswitch'
    cfg = {'gateway': 'byoc_load_probe', 'carrier_ip': '127.0.0.3', 'carrier_port': 5060,
           'public_ip': '127.0.0.4', 'sip_port': 5062, 'username': 'relay_probe', 'password': 'a' * 64}
    started = False
    try:
        run('docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '768m',
            '--pids-limit', '256', '-v', str(source) + ':/opt/vocivo-fs:ro',
            '-e', 'PUBLIC_IP=127.0.0.2', '-e', 'TELNYX_SIP_HOST=127.0.0.5',
            '-e', 'TELNYX_SIP_REALM=127.0.0.5', '--entrypoint', '/bin/sh', IMAGE,
            '/opt/vocivo-fs/docker-entrypoint.sh')
        started = True

        def fs(command):
            return run('docker', 'exec', name, 'fs_cli', '-x', command).stdout

        deadline = time.monotonic() + 90
        while 'is ready' not in run('docker', 'exec', name, 'fs_cli', '-x', 'status', check=False).stdout:
            if time.monotonic() >= deadline:
                logs = run('docker', 'logs', name, check=False)
                print(logs.stdout[-6000:] + logs.stderr[-6000:])
                raise RuntimeError('Production fixture did not start')
            time.sleep(2)
        if 'trunk' not in fs('sofia status'):
            raise RuntimeError('Trunk profile did not start')
        with tempfile.TemporaryDirectory(prefix='vocivo-gateway-include-') as directory:
            path = Path(directory) / 'gateway.xml'

            def load(payload):
                path.write_text(payload)
                path.chmod(0o600)
                run('docker', 'cp', str(path), name + ':/etc/freeswitch/sip_profiles/carriers/byoc_probe.xml')
                fs('sofia profile trunk rescan reloadxml')
                return fs('sofia status gateway ' + cfg['gateway'])

            # Establish the reported failure: syntactically valid compact XML
            # silently disappears in FreeSWITCH's line-oriented include pass.
            compact_root = ET.fromstring(gateway_xml(cfg))
            for node in compact_root.iter():
                node.text = node.tail = None
            compact = ET.tostring(compact_root, encoding='unicode')
            if 'Invalid Gateway' not in load(compact):
                raise AssertionError('Compact include no longer reproduces the production failure')
            # Observe actual OPTIONS destinations inside the offline namespace.
            # The carrier socket must never receive probes from the app PBX.
            probe = subprocess.Popen([
                'docker', 'run', '--rm', '--network', 'container:' + name,
                'python:3.12-alpine', 'python', '-u', '-c', '''
import json, selectors, socket, time
watch = selectors.DefaultSelector()
for label, address in [('relay', ('127.0.0.4', 5062)), ('carrier', ('127.0.0.3', 5060))]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(address)
    watch.register(sock, selectors.EVENT_READ, label)
print('ready', flush=True)
seen = []
until = time.monotonic() + 40
while time.monotonic() < until:
    for key, _ in watch.select(1):
        data, _ = key.fileobj.recvfrom(65535)
        # The unrelated platform gateway targets a separate loopback address.
        if data.startswith(b'OPTIONS '):
            seen.append(key.data)
print(json.dumps(seen))
'''], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if probe.stdout.readline().strip() != 'ready':
                raise RuntimeError('Gateway probe listeners did not start')
            status = load(gateway_xml(cfg))
            fields = dict(line.split(None, 1) for line in status.splitlines() if len(line.split(None, 1)) == 2)
            if fields.get('Name') != cfg['gateway'] or fields.get('Profile') != 'trunk':
                raise AssertionError('Generated gateway was not loaded into the production trunk profile')
            observed, error = probe.communicate(timeout=50)
            if probe.returncode or not json.loads(observed) or set(json.loads(observed)) != {'relay'}:
                raise AssertionError('OPTIONS escaped the relay destination: ' + observed + error)
        print(json.dumps({'compactIncludeFailureReproduced': True, 'generatedGatewayLoaded': True,
                          'optionsUseRelayOnly': True, 'productionStartupUsed': True, 'externalNetwork': False}))
    finally:
        if started:
            run('docker', 'rm', '-f', name, check=False)


if __name__ == '__main__':
    main()
