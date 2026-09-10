#!/usr/bin/env python3
"""Offline Kamailio-to-FreeSWITCH credential boundary regression."""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import uuid
from auth import auth_config
from temporary_carrier_pbx import IMAGE
IMAGE = os.environ.get('VOCIVO_TEST_FS_IMAGE', IMAGE)


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=60)


def main():
    root = Path(__file__).resolve().parents[1]
    name = 'vocivo-hop-auth-' + uuid.uuid4().hex[:10]
    started = []
    with tempfile.TemporaryDirectory(prefix='vocivo-hop-auth-') as directory:
        config = Path(directory) / 'kamailio.cfg'
        config.write_text(auth_config((root / 'kamailio/kamailio.cfg').read_text(), forward_to_fs=True))
        try:
            run('docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '768m', '--pids-limit', '256',
                '-v', str(root / 'freeswitch') + ':/opt/vocivo-fs:ro', '-e', 'PUBLIC_IP=127.0.0.2',
                '-e', 'TELNYX_SIP_HOST=127.0.0.3', '-e', 'TELNYX_SIP_REALM=127.0.0.3',
                '--entrypoint', '/bin/sh', IMAGE, '/opt/vocivo-fs/docker-entrypoint.sh')
            started.append(name)
            run('docker', 'run', '-d', '--name', name + '-kam', '--network', 'container:' + name,
                '-v', str(config) + ':/test.cfg:ro', '-e', 'VOCIVO_SIP_REALM=check', '--entrypoint', 'kamailio',
                'ghcr.io/kamailio/kamailio-ci:5.8.4-alpine', '-DD', '-E', '-f', '/test.cfg')
            started.append(name + '-kam')
            deadline = time.monotonic() + 90
            while 'is ready' not in run('docker', 'exec', name, 'fs_cli', '-x', 'status', check=False).stdout:
                if time.monotonic() >= deadline:
                    logs = run('docker', 'logs', name, check=False)
                    print(logs.stdout[-6000:] + logs.stderr[-6000:])
                    raise RuntimeError('FreeSWITCH did not finish startup')
                time.sleep(2)
            result = run('docker', 'run', '--rm', '--network', 'container:' + name,
                         '-v', str(root / 'tests') + ':/tests:ro', 'python:3.12-alpine', 'python', '/tests/fs_auth_wire.py', check=False)
            if result.returncode:
                print(result.stderr)
                print(run('docker', 'logs', name + '-kam', check=False).stderr[-5000:])
                raise RuntimeError('Credential boundary regression failed')
            print(result.stdout.strip())
        finally:
            for container in reversed(started):
                run('docker', 'rm', '-f', container, check=False)


if __name__ == '__main__':
    main()
