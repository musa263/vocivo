#!/usr/bin/env python3
"""Validate the temporary relay in Docker with no external networking or calls."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import uuid
from temporary_carrier_pbx import IMAGE
IMAGE = os.environ.get('VOCIVO_TEST_FS_IMAGE', IMAGE)
from temporary_carrier_relay import relay_xml


def main():
    name = 'vocivo-relay-validation-' + uuid.uuid4().hex[:8]
    with tempfile.TemporaryDirectory(prefix='vocivo-relay-validation-') as folder:
        root = Path(folder)
        conf, state = root / 'conf', root / 'state'
        conf.mkdir()
        for child in ('log', 'db', 'run', 'cdr'):
            (state / child).mkdir(parents=True)
        cfg = dict(public_ip='127.0.0.1', carrier_ip='127.0.0.1', peer_ip='127.0.0.1',
                   sip_port=15060, carrier_port=15080, esl_port=18022, rtp_start=16000,
                   rtp_end=16019, channel_limit=5, username='relay_validation', caller_ids=['966135110000'])
        password = secrets.token_hex(32)
        esl_password = secrets.token_hex(32)
        (conf / 'freeswitch.xml').write_text(relay_xml(cfg, password, esl_password))
        (conf / 'settings.json').write_text(json.dumps(cfg))
        (conf / 'relay-password').write_text(password)
        (conf / 'esl-password').write_text(esl_password)
        try:
            subprocess.run(['docker', 'run', '-d', '--platform', 'linux/amd64', '--name', name, '--network', 'none', '--memory', '512m',
                            '--pids-limit', '128', '-v', str(conf) + ':/conf:ro', '-v', str(state) + ':/state',
                            '--entrypoint', '/usr/bin/freeswitch', IMAGE, '-nf', '-nonat', '-np',
                            '-conf', '/conf', '-log', '/state/log', '-db', '/state/db', '-run', '/state/run',
                            '-mod', '/usr/lib/freeswitch/mod'], check=True, stdout=subprocess.DEVNULL, timeout=120)
            subprocess.run(['docker', 'run', '--rm', '--network', 'container:' + name,
                            '-v', str(conf) + ':/fixtures:ro', '-v', str(Path(__file__).parent) + ':/tests:ro',
                            'python:3.12-alpine', 'python', '/tests/relay_wire.py'], check=True, timeout=90)
        except subprocess.CalledProcessError:
            # Disposable loopback fixture only; no production data or credentials.
            subprocess.run(['docker', 'logs', '--tail', '45', name], check=False, timeout=10)
            for log in (state / 'log').glob('*.log'):
                print('\n'.join(log.read_text(errors='replace').splitlines()[-45:]), flush=True)
            raise
        finally:
            subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL, timeout=20)


if __name__ == '__main__':
    main()
